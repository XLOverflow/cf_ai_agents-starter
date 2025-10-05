import init, { MemoryFileSystem, Workspace } from "@biomejs/wasm-web";

/**
 * Default Biome configuration fallback.
 * Derived from the project's biome.json but simplified for virtual execution.
 */
const BIOME_CONFIGURATION = {
  $schema: "https://biomejs.dev/schemas/2.2.5/schema.json",
  assist: {
    enabled: true
  },
  files: {
    ignoreUnknown: false
  },
  formatter: {
    enabled: false
  },
  javascript: {
    formatter: {
      quoteStyle: "double"
    }
  },
  linter: {
    enabled: true,
    rules: {
      recommended: true
    }
  }
} as const;

const WASM_URL = new URL(
  "@biomejs/wasm-web/biome_wasm_bg.wasm",
  import.meta.url
);
const VIRTUAL_ROOT = "/virtual";

let initPromise: Promise<void> | null = null;
let workspace: Workspace | null = null;
let filesystem: MemoryFileSystem | null = null;
let projectKey: number | null = null;
let currentVersion = 1;

interface Position {
  line: number;
  column: number;
}

interface LintLocation {
  start: Position;
  end: Position;
}

export interface LintDiagnostic {
  message: string;
  severity: string;
  category?: string;
  ruleId?: string;
  location?: LintLocation;
  advice?: string[];
}

export interface LintCodeResult {
  diagnostics: LintDiagnostic[];
  summary: {
    errorCount: number;
    warningCount: number;
    hintCount: number;
  };
  fixedSource?: string;
  fixesApplied?: number;
}

export interface LintCodeInput {
  code: string;
  path?: string;
  language?: string;
  applyFixes?: boolean;
}

function offsetToPositionMap(source: string) {
  const lineOffsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lineOffsets.push(i + 1);
    }
  }
  return lineOffsets;
}

function offsetToPosition(offset: number, lineOffsets: number[]): Position {
  let low = 0;
  let high = lineOffsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineOffsets[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const line = Math.max(high, 0);
  const column = offset - lineOffsets[line];

  return {
    line: line + 1,
    column: column + 1
  };
}

function deriveExtension(language?: string) {
  switch ((language || "").toLowerCase()) {
    case "tsx":
      return "tsx";
    case "typescript":
    case "ts":
      return "ts";
    case "jsx":
      return "jsx";
    case "javascript":
    case "js":
      return "js";
    case "json":
      return "json";
    default:
      return "ts";
  }
}

function nextVirtualPath(input: LintCodeInput) {
  if (input.path) return normalizePath(input.path);
  const ext = deriveExtension(input.language);
  const uniqueId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `${VIRTUAL_ROOT}/snippet-${uniqueId}.${ext}`;
}

function normalizePath(path: string) {
  if (path.startsWith("/")) return path;
  if (/^[a-zA-Z]:/.test(path)) return `/${path}`;
  return `${VIRTUAL_ROOT}/${path}`.replace(/\\/g, "/");
}

async function ensureWorkspace() {
  if (!initPromise) {
    initPromise = (async () => {
      await init(WASM_URL);
      filesystem = new MemoryFileSystem();
      workspace = Workspace.withFileSystem(filesystem);
      const project = workspace.openProject({
        path: VIRTUAL_ROOT,
        openUninitialized: true
      });
      projectKey = project.projectKey;
      workspace.updateSettings({
        projectKey,
        configuration: BIOME_CONFIGURATION,
        workspaceDirectory: VIRTUAL_ROOT
      });
    })();
  }

  await initPromise;
}

interface RawMarkupNode {
  content?: string;
}

interface RawAdvice {
  log?: [unknown, RawMarkupNode[]];
  list?: RawMarkupNode[];
}

interface RawDiagnostic {
  message?: string;
  description?: string;
  severity?: string;
  category?: string;
  metadata?: {
    ruleName?: string;
  };
  location?: {
    span?: [number, number];
  };
  advices?: RawAdvice[];
}

function toDiagnostics(
  rawDiagnostics: unknown[],
  source: string
): LintDiagnostic[] {
  if (!Array.isArray(rawDiagnostics)) return [];
  const offsets = offsetToPositionMap(source);

  return rawDiagnostics.map((diag): LintDiagnostic => {
    const diagnostic = diag as RawDiagnostic;
    const span: [number, number] | undefined = diagnostic?.location?.span;
    let location: LintLocation | undefined;

    if (span && typeof span[0] === "number" && typeof span[1] === "number") {
      location = {
        start: offsetToPosition(span[0], offsets),
        end: offsetToPosition(span[1], offsets)
      };
    }

    const advice: string[] = [];
    if (Array.isArray(diagnostic?.advices)) {
      for (const item of diagnostic.advices) {
        if (item?.log && Array.isArray(item.log[1])) {
          const [, nodes] = item.log;
          for (const node of nodes) {
            if (node?.content) {
              advice.push(node.content);
            }
          }
        }
        if (item?.list && Array.isArray(item.list)) {
          for (const node of item.list) {
            if (node?.content) {
              advice.push(node.content);
            }
          }
        }
      }
    }

    return {
      message:
        diagnostic?.message ??
        diagnostic?.description ??
        "Unknown lint message",
      severity: diagnostic?.severity ?? "information",
      category: diagnostic?.category,
      ruleId: diagnostic?.metadata?.ruleName ?? diagnostic?.category,
      location,
      advice
    } satisfies LintDiagnostic;
  });
}

export async function lintCode(input: LintCodeInput): Promise<LintCodeResult> {
  if (!input.code?.trim()) {
    throw new Error("lintCode requires non-empty code input");
  }

  await ensureWorkspace();
  if (!workspace || !filesystem || projectKey == null) {
    throw new Error("Biome workspace failed to initialise");
  }

  const path = nextVirtualPath(input);
  const source = input.code;
  const encoder = new TextEncoder();
  filesystem.insert(path, encoder.encode(source));

  const version = currentVersion++;
  workspace.openFile({
    path,
    projectKey,
    content: {
      type: "fromClient",
      version,
      content: source
    }
  });

  const diagnosticsResult = workspace.pullDiagnostics({
    categories: ["syntax", "lint"],
    path,
    projectKey,
    pullCodeActions: true
  });

  const diagnostics = toDiagnostics(
    diagnosticsResult.diagnostics ?? [],
    source
  );

  let fixedSource: string | undefined;
  let fixesApplied: number | undefined;

  if (input.applyFixes) {
    const fixResult = workspace.fixFile({
      path,
      projectKey,
      ruleCategories: ["lint"],
      fixFileMode: "safeFixes",
      shouldFormat: false
    });

    if (fixResult?.actions?.length) {
      fixesApplied = fixResult.actions.length;
      fixedSource = fixResult.code;
    }
  }

  workspace.closeFile({ path, projectKey });
  filesystem.remove(path);

  const summary = diagnostics.reduce(
    (acc, diag) => {
      switch (diag.severity) {
        case "error":
        case "fatal":
          acc.errorCount += 1;
          break;
        case "warning":
          acc.warningCount += 1;
          break;
        default:
          acc.hintCount += 1;
      }
      return acc;
    },
    { errorCount: 0, warningCount: 0, hintCount: 0 }
  );

  return {
    diagnostics,
    summary,
    fixedSource,
    fixesApplied
  };
}
