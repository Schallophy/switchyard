import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
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
  /** 访问日志：终端压成一行，文件里保留 method / path / status / ms。 */
  access(method: string, path: string, status: number, ms: number): void;
  /** 等文件日志写完，退出前调用，避免最后几行丢失。 */
  flush(): Promise<void>;
  /** 运行期调整级别（看板保存或热加载时使用）。 */
  setLevel(level: LogLevel): void;
  /** 运行期调整轮转策略。 */
  setRotation(maxBytes: number, maxFiles: number): void;
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
const GREEN = "\u001b[38;5;114m";
const YELLOW = "\u001b[38;5;214m";
const RED = "\u001b[38;5;167m";
const RESET = "\u001b[0m";

/** 重定向到文件或管道时不要塞 ANSI 序列；NO_COLOR 也一样。 */
const COLOR_ENABLED = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return COLOR_ENABLED ? `${code}${text}${RESET}` : text;
}

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

/** 太长的耗时换成秒，免得一列数字宽度乱跳。 */
function duration(ms: number): string {
  if (ms >= 10_000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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
  /** 单个日志文件的上限（字节）；0 或省略表示不轮转。 */
  maxBytes?: number;
  /** 轮转后保留的旧文件数量（不含当前文件）。 */
  maxFiles?: number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  let level = options.level ?? "info";
  const pretty = options.pretty ?? true;
  let maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? 0));
  let maxFiles = Math.max(0, Math.trunc(options.maxFiles ?? 0));
  let queue: Promise<unknown> = Promise.resolve();
  let directoryReady: Promise<unknown> | null = null;
  /** 当前文件的字节数；首次写入时 stat 获取，之后按写入量累加。 */
  let size: number | null = null;

  async function currentSize(file: string): Promise<number> {
    if (size !== null) return size;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0;
    }
    return size;
  }

  async function rotate(file: string): Promise<void> {
    if (maxFiles <= 0) {
      await rm(file, { force: true });
      size = 0;
      return;
    }
    await rm(`${file}.${maxFiles}`, { force: true });
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => undefined);
    }
    await rename(file, `${file}.1`).catch(() => undefined);
    size = 0;
  }

  function append(record: Record<string, unknown>): void {
    if (!options.file) return;
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    const file = options.file;
    directoryReady ??= mkdir(dirname(file), { recursive: true });
    queue = queue
      .then(() => directoryReady)
      .then(async () => {
        const current = await currentSize(file);
        if (maxBytes > 0 && current > 0 && current + bytes > maxBytes) {
          await rotate(file);
        }
        await appendFile(file, line);
        size = (size ?? 0) + bytes;
      })
      .catch(() => {
        // 写失败（磁盘满、权限变化等）时重建大小缓存，下一次重新 stat
        size = null;
      });
  }

  function write(levelName: LogLevel, bindings: LogFields, message: string, fields?: LogFields): void {
    if (ORDER[levelName] < ORDER[level]) return;
    const now = new Date();
    const merged = { ...bindings, ...fields };

    append({ at: now.toISOString(), level: levelName, message, ...merged });

    if (pretty) {
      process.stdout.write(
        `${paint(DIM, clock(now))} ${paint(COLOR[levelName], levelName.toUpperCase().padEnd(5))} ${message}${paint(
          DIM,
          renderFields(merged),
        )}\n`,
      );
    }
  }

  function make(bindings: LogFields): Logger {
    return {
      debug: (message, fields) => write("debug", bindings, message, fields),
      info: (message, fields) => write("info", bindings, message, fields),
      warn: (message, fields) => write("warn", bindings, message, fields),
      error: (message, fields) => write("error", bindings, message, fields),
      access: (method, path, status, ms) => {
        if (ORDER.info < ORDER[level]) return;
        const now = new Date();
        append({ at: now.toISOString(), level: "info", message: "api request", method, path, status, ms });

        // 访问日志默认只进文件；想看每一行请求时把 log.level 调到 debug
        if (!pretty || level !== "debug") return;
        const tone = status >= 500 ? RED : status >= 400 ? YELLOW : GREEN;
        process.stdout.write(
          `${paint(DIM, clock(now))}  ${method.padEnd(4)} ${path}  ${paint(tone, String(status))} ${paint(
            DIM,
            duration(ms),
          )}\n`,
        );
      },
      flush: async () => {
        await queue;
      },
      setLevel: (next) => {
        level = next;
      },
      setRotation: (bytes, files) => {
        maxBytes = Math.max(0, Math.trunc(bytes));
        maxFiles = Math.max(0, Math.trunc(files));
      },
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }

  return make({});
}