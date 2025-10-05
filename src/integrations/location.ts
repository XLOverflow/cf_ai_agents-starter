const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const WEATHER_CODE_DESCRIPTION: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
};

export interface GeocodedLocation {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface WeatherObservation {
  temperatureC: number;
  windSpeedKmh: number;
  windDirectionDegrees: number;
  weatherCode: number;
  weatherDescription: string;
  observedAt: string;
}

export interface WeatherResult {
  location: GeocodedLocation;
  observation: WeatherObservation;
  source: string;
}

export interface TimeResult {
  location: GeocodedLocation;
  timezone: string;
  datetime: string;
  utcOffset: string;
  abbreviation?: string;
  formatted: string;
  source: string;
}

async function geocode(query: string): Promise<GeocodedLocation> {
  const url = new URL(GEOCODING_ENDPOINT);
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to geocode location: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      name: string;
      country?: string;
      latitude: number;
      longitude: number;
      timezone: string;
    }>;
  };

  const entry = data.results?.[0];
  if (!entry) {
    throw new Error(`Could not find location for "${query}"`);
  }

  return {
    name: entry.name,
    country: entry.country,
    latitude: entry.latitude,
    longitude: entry.longitude,
    timezone: entry.timezone
  } satisfies GeocodedLocation;
}

function describeWeather(code: number): string {
  return WEATHER_CODE_DESCRIPTION[code] ?? "Unknown conditions";
}

export async function getWeatherByCity(city: string): Promise<WeatherResult> {
  const location = await geocode(city);

  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current_weather", "true");
  url.searchParams.set("timezone", location.timezone);

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch weather data: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    current_weather?: {
      temperature: number;
      windspeed: number;
      winddirection: number;
      weathercode: number;
      time: string;
    };
  };

  const current = data.current_weather;
  if (!current) {
    throw new Error("Weather data unavailable for the requested location");
  }

  const observation: WeatherObservation = {
    temperatureC: current.temperature,
    windSpeedKmh: current.windspeed,
    windDirectionDegrees: current.winddirection,
    weatherCode: current.weathercode,
    weatherDescription: describeWeather(current.weathercode),
    observedAt: current.time
  };

  return {
    location,
    observation,
    source: "open-meteo.com"
  } satisfies WeatherResult;
}

function extractPart(parts: Intl.DateTimeFormatPart[], type: string) {
  return parts.find((part) => part.type === type)?.value;
}

export async function getLocalTimeByLocation(
  locationQuery: string
): Promise<TimeResult> {
  const location = await geocode(locationQuery);
  const now = new Date();

  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: location.timezone
  }).format(now);

  const isoParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: location.timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(now);

  const year = extractPart(isoParts, "year") ?? String(now.getUTCFullYear());
  const month =
    extractPart(isoParts, "month") ??
    String(now.getUTCMonth() + 1).padStart(2, "0");
  const day =
    extractPart(isoParts, "day") ?? String(now.getUTCDate()).padStart(2, "0");
  const hour =
    extractPart(isoParts, "hour") ?? String(now.getUTCHours()).padStart(2, "0");
  const minute =
    extractPart(isoParts, "minute") ??
    String(now.getUTCMinutes()).padStart(2, "0");
  const second =
    extractPart(isoParts, "second") ??
    String(now.getUTCSeconds()).padStart(2, "0");

  const datetime = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: location.timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(now);

  const abbreviationParts = new Intl.DateTimeFormat("en-US", {
    timeZone: location.timezone,
    timeZoneName: "short"
  }).formatToParts(now);

  const utcOffset = extractPart(offsetParts, "timeZoneName") ?? "GMT";
  const abbreviation =
    extractPart(abbreviationParts, "timeZoneName") ?? undefined;

  return {
    location,
    timezone: location.timezone,
    datetime,
    utcOffset,
    abbreviation,
    formatted,
    source: "Intl.DateTimeFormat"
  } satisfies TimeResult;
}
