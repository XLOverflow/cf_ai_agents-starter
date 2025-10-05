// via https://github.com/vercel/ai/blob/main/examples/next-openai/app/api/use-chat-human-in-the-loop/utils.ts

import type {
  UIMessage,
  UIMessageStreamWriter,
  ToolSet,
  CoreMessage
} from "ai";
import { convertToModelMessages, isToolUIPart } from "ai";
import { APPROVAL } from "./shared";

interface ToolContext {
  messages: CoreMessage[];
  toolCallId: string;
}

const pendingToolInputs = new Map<string, unknown>();

function getOriginalToolInput(messages: UIMessage[], toolCallId: string) {
  for (const message of messages) {
    if (!message.parts) continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (part.toolCallId !== toolCallId) continue;
      if (
        part.input &&
        part.input !== APPROVAL.YES &&
        part.input !== APPROVAL.NO
      ) {
        return part.input;
      }
    }
  }
  return undefined;
}

function isValidToolName<K extends PropertyKey, T extends object>(
  key: K,
  obj: T
): key is K & keyof T {
  return key in obj;
}

/**
 * Processes tool invocations where human input is required, executing tools when authorized.
 */
export async function processToolCalls<Tools extends ToolSet>({
  dataStream,
  messages,
  executions
}: {
  tools: Tools; // used for type inference
  dataStream: UIMessageStreamWriter;
  messages: UIMessage[];
  executions: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: needs a better type
    (args: any, context: ToolContext) => Promise<unknown>
  >;
}): Promise<UIMessage[]> {
  // Process all messages, not just the last one
  const processedMessages = await Promise.all(
    messages.map(async (message) => {
      const parts = message.parts;
      if (!parts) return message;

      const processedParts = await Promise.all(
        parts.map(async (part) => {
          // Only process tool UI parts
          if (!isToolUIPart(part)) return part;

          const toolName = part.type.replace(
            "tool-",
            ""
          ) as keyof typeof executions;

          if (!(toolName in executions)) return part;

          const awaitingApproval = part.state === "input-available";
          const decisionAvailable =
            (part.state === "output-available" &&
              (part.output === APPROVAL.YES || part.output === APPROVAL.NO)) ||
            part.input === APPROVAL.YES ||
            part.input === APPROVAL.NO;

          if (awaitingApproval) {
            if (part.input !== APPROVAL.YES && part.input !== APPROVAL.NO) {
              pendingToolInputs.set(part.toolCallId, part.input);
            }
            return part;
          }

          if (!decisionAvailable) {
            return part;
          }

          const decision =
            part.output === APPROVAL.YES || part.output === APPROVAL.NO
              ? (part.output as string)
              : (part.input as string);

          let result: unknown;

          if (decision === APPROVAL.YES) {
            // User approved the tool execution
            if (!isValidToolName(toolName, executions)) {
              return part;
            }

            const toolInstance = executions[toolName];
            if (toolInstance) {
              const originalInput = pendingToolInputs.get(part.toolCallId);
              let args = originalInput ?? part.input;

              if (!args || args === APPROVAL.YES || args === APPROVAL.NO) {
                args = getOriginalToolInput(messages, part.toolCallId);
              }

              if (!args || args === APPROVAL.YES || args === APPROVAL.NO) {
                result = "Error: Unable to resolve original tool input";
              } else {
                result = await toolInstance(args, {
                  messages: convertToModelMessages(messages),
                  toolCallId: part.toolCallId
                });
              }
              pendingToolInputs.delete(part.toolCallId);
            } else {
              result = "Error: No execute function found on tool";
            }
          } else if (decision === APPROVAL.NO) {
            result = "Error: User denied access to tool execution";
            pendingToolInputs.delete(part.toolCallId);
          } else {
            return part;
          }

          // Forward updated tool result to the client.
          dataStream.write({
            type: "data-tool-result",
            data: {
              toolCallId: part.toolCallId,
              result: result
            }
          });

          // Return updated tool part with the actual result.
          return {
            ...part,
            state: "output-available" as const,
            output: result,
            errorText: undefined
          };
        })
      );

      return { ...message, parts: processedParts };
    })
  );

  return processedMessages;
}

/**
 * Clean up incomplete tool calls from messages before sending to API
 * Prevents API errors from interrupted or failed tool executions
 */
export function cleanupMessages(messages: UIMessage[]): UIMessage[] {
  return messages.filter((message) => {
    if (!message.parts) return true;

    // Filter out messages with incomplete tool calls
    const hasIncompleteToolCall = message.parts.some((part) => {
      if (!isToolUIPart(part)) return false;
      // Remove tool calls that are still streaming or awaiting input without results
      return (
        part.state === "input-streaming" ||
        (part.state === "input-available" && !part.output && !part.errorText)
      );
    });

    return !hasIncompleteToolCall;
  });
}
