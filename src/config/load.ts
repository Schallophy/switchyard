import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeConfig, type GatewayConfig } from "./schema.ts";

export class ConfigError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.details = details;
  }
}

export interface LoadedConfig {
  config: GatewayConfig;
  created: boolean;
  warnings: string[];
}

/**
 * 配置是给人手写的，所以容忍注释与尾逗号（README 的示例本来就是 jsonc）。
 * 严格 JSON 走快路径，解析失败才降级到宽松解析。
 */
export function parseConfigText(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (strictError) {
    try {
      return JSON.parse(dropTrailingCommas(stripJsonComments(raw)));
    } catch {
      throw new ConfigError(`配置文件不是合法 JSON：${(strictError as Error).message}`);
    }
  }
}

/** 去掉 // 与 /* *\/ 注释，字符串内的斜杠不受影响。 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    out += char;
  }

  return out;
}

/** 去掉对象与数组末尾多余的逗号，字符串内的逗号不受影响。 */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let pendingComma = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (char === "\\") {
        out += char + (text[index + 1] ?? "");
        index += 1;
        continue;
      }
      out += char;
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      pendingComma = -1;
      out += char;
      continue;
    }
    if (char === ",") {
      pendingComma = out.length;
      out += char;
      continue;
    }
    if ((char === "}" || char === "]") && pendingComma >= 0) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = -1;
    } else if (!/\s/.test(char)) {
      pendingComma = -1;
    }
    out += char;
  }

  return out;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const config = normalizeConfig({}).config;
      await saveConfig(file, config);
      return { config, created: true, warnings: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseConfigText(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`配置文件不是合法 JSON：${(error as Error).message}`);
  }

  const result = normalizeConfig(parsed);
  if (!result.ok) {
    throw new ConfigError("配置文件校验失败", result.errors);
  }
  return { config: result.config, created: false, warnings: result.warnings };
}

export async function saveConfig(path: string, config: GatewayConfig): Promise<void> {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export interface OverrideResult {
  config: GatewayConfig;
  warnings: string[];
}

export function applyEnvOverrides(config: GatewayConfig): OverrideResult {
  const warnings: string[] = [];
  const port = Number(process.env.SWITCHYARD_PORT);
  if (process.env.SWITCHYARD_PORT !== undefined) {
    if (Number.isInteger(port) && port > 0 && port < 65_536) {
      config.port = port;
    } else {
      warnings.push(`SWITCHYARD_PORT 不是合法端口：${process.env.SWITCHYARD_PORT}`);
    }
  }

  // 旧变量名 SWITCHYARD_UPSTREAM 仍然生效，便于升级后不改启动脚本
  const provider = (process.env.SWITCHYARD_PROVIDER?.trim() || process.env.SWITCHYARD_UPSTREAM?.trim()) ?? "";
  if (provider) {
    try {
      const url = new URL(provider);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      const target =
        config.providers.find((item) => item.id === config.defaultProvider) ?? config.providers[0];
      if (target) target.baseUrl = provider.replace(/\/+$/, "");
    } catch {
      warnings.push("SWITCHYARD_PROVIDER 不是合法的 http(s) 地址，已忽略");
    }
  }

  return { config, warnings };
}
