import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: "\u001b[38;5;244m",
  info: "\u001b[38;5;180m",
  warn: "\u001b[38;5;214m",
  error: "\u001b[38;5;167m",
};

const DIM = "\u001b[38;5;240m";
const RESET = "\u001b[0m";

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return "info";
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${stringify(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export interface LoggerOptions {
  level?: LogLevel;
  file?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const pretty = options.pretty ?? true;
  let queue: Promise<unknown> = Promise.resolve();
  let directoryReady: Promise<unknown> | null = null;

  function write(levelName: LogLevel, bindings: LogFields, message: string, fields?: LogFields): void {
    if (ORDER[levelName] < ORDER[level]) return;
    const now = new Date();
    const merged = { ...bindings, ...fields };

    if (options.file) {
      const line = JSON.stringify({ at: now.toISOString(), level: levelName, message, ...merged });
      const file = options.file;
      directoryReady ??= mkdir(dirname(file), { recursive: true });
      queue = queue.then(() => directoryReady).then(() => appendFile(file, `${line}\n`)).catch(() => undefined);
    }

    if (pretty) {
      process.stdout.write(
        `${DIM}${clock(now)}${RESET} ${COLOR[levelName]}${levelName.toUpperCase().padEnd(5)}${RESET} ${message}${DIM}${renderFields(merged)}${RESET}\n`,
      );
    }
  }

  function make(bindings: LogFields): Logger {
    return {
      debug: (message, fields) => write("debug", bindings, message, fields),
      info: (message, fields) => write("info", bindings, message, fields),
      warn: (message, fields) => write("warn", bindings, message, fields),
      error: (message, fields) => write("error", bindings, message, fields),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }

  return make({});
}
