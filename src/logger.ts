import pino, { type Logger } from "pino";

/** Log levels supported by the registry, ordered from most to least severe. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Supported runtime log-level names. */
export type LogLevel = typeof LOG_LEVELS[number];

/** Check whether an unknown configuration value is a supported log level. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Create the structured JSON logger shared by the CLI and HTTP server. */
export function createLogger(level: LogLevel = "info"): Logger {
  return pino({
    level,
    name: "a2a-registry",
  });
}

export type { Logger } from "pino";
