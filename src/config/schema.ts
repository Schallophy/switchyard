import { joinModelCode, splitModelCode } from "../core/model-code.ts";

export type ApiKind = "chat" | "completions" | "responses" | "embeddings";

export const API_KINDS: readonly ApiKind[] = ["chat", "completions", "responses", "embeddings"];

export const DEFAULT_MODEL_APIS: readonly ApiKind[] = ["chat"];

export type ModelApiMap = Record<string, ApiKind[]>;

export function isApiKind(value: string): value is ApiKind {
  return (API_KINDS as readonly string[]).includes(value);
}

export type ContextOverflowMode = "reject" | "passthrough";

export interface ContextConfig {
  window: number;
  onOverflow: ContextOverflowMode;
}

export const DEFAULT_CONTEXT_WINDOW = 256_000;

/** dead 模型默认在一天后重新参与选路（对齐按天刷新的免费额度）。 */
export const DEFAULT_RETRY_DEAD_AFTER_MINUTES = 1_440;

export interface ChainConfig {
  /** 当前用于输出的模型；不在 models 里时回退到 models[0]。 */
  active: string;
  /** 优先级从高到低。auto 请求从 active 开始，按这个顺序回退。 */
  models: string[];
  context: ContextConfig;
  /** dead 模型经过多少分钟后自动重新参与选路（免费额度按天刷新的场景）；0 = 只能手动重置。 */
  retryDeadAfterMinutes: number;
}

export interface ServerConfig {
  /** 请求体上限，单位字节。 */
  maxBodyBytes: number;
  /** 是否为 /v1/* 返回 CORS 头（浏览器直连需要）。 */
  cors: boolean;
}

export interface UiConfig {
  /** 关闭后不再提供看板静态资源，配置只能走 config.json。 */
  enabled: boolean;
}

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface LogConfig {
  level: LogLevelName;
  /** 空字符串表示使用数据目录下的 switchyard.log。 */
  file: string;
  /** 单个文件的上限（字节）；0 表示不轮转。 */
  maxBytes: number;
  /** 轮转后保留的旧文件数量（不含当前文件）。 */
  maxFiles: number;
}

export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 3;

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export const LOG_LEVELS: readonly LogLevelName[] = ["debug", "info", "warn", "error"];

export function isLogLevel(value: string): value is LogLevelName {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  /** 稳定的短 id，模型通过它来选择提供商。 */
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey: string;
  requestTimeoutMs: number;
  injectStreamUsage: boolean;
}

export interface FailoverConfig {
  maxAttempts: number;
  throttleCooldownMs: number;
}

export interface PriceTier {
  /** 本地时间 HH:MM；from === to 表示全天。 */
  from: string;
  to: string;
  /** 每 unit 个 token 的价格。 */
  input: number;
  cachedInput: number;
  output: number;
}

export interface ModelPricing {
  tiers: PriceTier[];
}

export interface PricingConfig {
  currency: string;
  /** 单价的 token 基数，例如 1_000_000 表示「每百万 token」。 */
  unit: number;
  /** 模型 code → 价格；"*" 作为所有模型的兜底。 */
  models: Record<string, ModelPricing>;
}

export interface ResponsesChainingConfig {
  /** 开启后，/v1/responses 会复用平台侧会话，只发送新增内容。 */
  enabled: boolean;
  /** response id 的保留时间（分钟）。 */
  ttlMinutes: number;
  /** 内存中最多保留多少个会话前缀。 */
  maxSessions: number;
}

export const DEFAULT_PRICING_CURRENCY = "CNY";
export const DEFAULT_PRICING_UNIT = 1_000_000;

export interface GatewayConfig {
  version: number;
  host: string;
  port: number;
  gatewayToken: string;
  server: ServerConfig;
  ui: UiConfig;
  log: LogConfig;
  chain: ChainConfig;
  modelApis: ModelApiMap;
  providers: ProviderConfig[];
  defaultProvider: string;
  failover: FailoverConfig;
  pricing: PricingConfig;
  responsesChaining: ResponsesChainingConfig;
}

export interface NormalizeResult {
  ok: boolean;
  config: GatewayConfig;
  errors: string[];
  warnings: string[];
  /** 旧格式的自动迁移记录；可以写回配置文件后消失。 */
  migrations: string[];
}

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "dashscope",
    label: "阿里云百炼",
    baseUrl: DEFAULT_BASE_URL,
    apiKeyEnv: "DASHSCOPE_API_KEY",
    apiKey: "",
    requestTimeoutMs: 90_000,
    injectStreamUsage: true,
  },
];

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function isValidProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value);
}

export function defaultConfig(): GatewayConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 8788,
    gatewayToken: "",
    server: {
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      cors: true,
    },
    ui: {
      enabled: true,
    },
    log: {
      level: "info",
      file: "",
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      maxFiles: DEFAULT_LOG_MAX_FILES,
    },
    chain: {
      active: "",
      models: [],
      context: { window: DEFAULT_CONTEXT_WINDOW, onOverflow: "reject" },
      retryDeadAfterMinutes: DEFAULT_RETRY_DEAD_AFTER_MINUTES,
    },
    modelApis: {},
    providers: clone(DEFAULT_PROVIDERS),
    defaultProvider: DEFAULT_PROVIDERS[0].id,
    failover: {
      maxAttempts: 8,
      throttleCooldownMs: 60_000,
    },
    pricing: {
      currency: DEFAULT_PRICING_CURRENCY,
      unit: DEFAULT_PRICING_UNIT,
      models: {},
    },
    responsesChaining: {
      enabled: false,
      ttlMinutes: 120,
      maxSessions: 500,
    },
  };
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readString(source: Obj, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function readBool(source: Obj, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(
  source: Obj,
  key: string,
  fallback: number,
  min: number,
  max: number,
  path: string,
  errors: string[],
): number {
  const raw = source[key];
  if (raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${path} 必须是 ${min} 到 ${max} 之间的数字`);
    return fallback;
  }
  return value;
}

function readBaseUrl(source: Obj, fallback: string, path: string, errors: string[]): string {
  const raw = source.baseUrl;
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    errors.push(`${path}.baseUrl 必须是合法的 http(s) 地址`);
    return fallback;
  }
  return value.replace(/\/+$/, "");
}

function readProviderItem(item: Obj, id: string, path: string, errors: string[]): ProviderConfig {
  return {
    id,
    label: readString(item, "label", "") || id,
    baseUrl: readBaseUrl(item, DEFAULT_BASE_URL, path, errors),
    apiKeyEnv: readString(item, "apiKeyEnv", ""),
    apiKey: readString(item, "apiKey", ""),
    requestTimeoutMs: readNumber(
      item,
      "requestTimeoutMs",
      90_000,
      1_000,
      600_000,
      `${path}.requestTimeoutMs`,
      errors,
    ),
    injectStreamUsage: readBool(item, "injectStreamUsage", true),
  };
}

function readProviders(
  source: Obj,
  errors: string[],
  warnings: string[],
  migrations: string[],
): { providers: ProviderConfig[]; defaultProvider: string } {
  const providers: ProviderConfig[] = [];
  // 旧版字段名：upstreams（本版之前的数组）、upstream（更早的单对象）
  let raw: unknown = source.providers;
  if (raw === undefined && Array.isArray(source.upstreams)) {
    raw = source.upstreams;
    migrations.push("已把旧字段 upstreams 迁移为 providers");
  }

  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push("providers 必须是数组");
  }

  if (Array.isArray(raw) && raw.length > 0) {
    const seen = new Set<string>();
    for (let index = 0; index < raw.length; index += 1) {
      const item: unknown = raw[index];
      const path = `providers[${index}]`;
      if (!isObj(item)) {
        errors.push(`${path} 必须是对象`);
        continue;
      }
      const id = readString(item, "id", "").toLowerCase();
      if (!isValidProviderId(id)) {
        errors.push(`${path}.id 只能使用小写字母、数字和 . _ -，且不能为空`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`${path}.id 重复: ${id}`);
        continue;
      }
      seen.add(id);
      providers.push(readProviderItem(item, id, path, errors));
    }
  } else if (isObj(source.upstream)) {
    // 更早版本的单提供商写法（键名 upstream）：自动迁移，保留用户的地址与 Key 设置
    migrations.push("已把旧版 upstream 单对象迁移为 providers[0]（id: default）");
    providers.push(readProviderItem(source.upstream, "default", "upstream", errors));
  } else if (Array.isArray(raw) && raw.length === 0) {
    errors.push("providers 至少需要一个提供商");
  }

  if (providers.length === 0) {
    if (errors.length === 0) errors.push("至少需要一个提供商");
    return { providers: clone(DEFAULT_PROVIDERS), defaultProvider: DEFAULT_PROVIDERS[0].id };
  }

  const requested = (
    readString(source, "defaultProvider", "") || readString(source, "defaultUpstream", "")
  ).toLowerCase();
  let defaultProvider = requested || providers[0].id;
  if (!providers.some((item) => item.id === defaultProvider)) {
    warnings.push(`defaultProvider 指向不存在的提供商，已改为 ${providers[0].id}`);
    defaultProvider = providers[0].id;
  }

  return { providers, defaultProvider };
}

/**
 * 旧版本把「模型 → 提供商」放在 modelProviders 里。现在提供商直接写在模型 code 里，
 * 这里只读取旧字段用于迁移，读到的映射不会写回配置。
 */
function readLegacyBindings(
  source: Obj,
  providers: ProviderConfig[],
  errors: string[],
  migrations: string[],
): Record<string, string> {
  let raw = source.modelProviders;
  if (raw === undefined && isObj(source.modelUpstreams)) {
    raw = source.modelUpstreams;
    migrations.push("已把旧字段 modelUpstreams 迁移为 modelProviders");
  }
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    migrations.push("已忽略非对象的 modelProviders，改为在模型 code 中写提供商");
    return {};
  }

  const map: Record<string, string> = {};
  for (const [rawCode, rawValue] of Object.entries(raw)) {
    const code = rawCode.trim();
    if (!code || typeof rawValue !== "string" || !rawValue.trim()) {
      errors.push(`modelProviders.${code || "(empty)"} 必须是提供商 id`);
      continue;
    }
    const id = rawValue.trim().toLowerCase();
    if (!providers.some((item) => item.id === id)) {
      errors.push(`modelProviders.${code} 指向不存在的提供商：${id}`);
      continue;
    }
    map[code] = id;
  }
  if (Object.keys(map).length > 0) {
    migrations.push("已把 modelProviders 并入模型 code（提供商/模型名），该字段不再需要");
  }
  return map;
}

function readContext(item: Obj, path: string, errors: string[]): ContextConfig {
  if (item.context !== undefined && !isObj(item.context)) {
    errors.push(`${path}.context 必须是对象`);
  }
  const raw = isObj(item.context) ? item.context : {};
  const window = readNumber(
    raw,
    "window",
    DEFAULT_CONTEXT_WINDOW,
    1_000,
    10_000_000,
    `${path}.context.window`,
    errors,
  );
  const rawMode = raw.onOverflow;
  let onOverflow: ContextOverflowMode = "reject";
  if (rawMode === "reject" || rawMode === "passthrough") {
    onOverflow = rawMode;
  } else if (rawMode !== undefined) {
    errors.push(`${path}.context.onOverflow 只能是 reject / passthrough`);
  }
  return { window, onOverflow };
}

function readChain(
  source: Obj,
  providers: ProviderConfig[],
  bindings: Record<string, string>,
  fallbackProvider: string,
  errors: string[],
  warnings: string[],
  migrations: string[],
): ChainConfig {
  let raw: Obj | null = null;

  if (source.chain !== undefined) {
    if (isObj(source.chain)) raw = source.chain;
    else errors.push("chain 必须是对象");
  } else if (Array.isArray(source.chains)) {
    // 旧版多链配置：只保留默认链（或第一条）的模型，迁移成一条列表。
    const items = source.chains.filter(isObj);
    if (items.length > 0) {
      raw = items.find((item) => item.purpose === "default") ?? items[0] ?? null;
      migrations.push("已把多条模型链合并为单条模型列表（保留默认链的模型与上下文设置）");
    }
  } else if (source.chains !== undefined) {
    errors.push("chains 必须是数组");
  }

  if (!raw) {
    return {
      active: "",
      models: [],
      context: { window: DEFAULT_CONTEXT_WINDOW, onOverflow: "reject" },
      retryDeadAfterMinutes: DEFAULT_RETRY_DEAD_AFTER_MINUTES,
    };
  }

  const models: string[] = [];
  const migrated = new Set<string>();
  const normalize = (value: string): string => {
    const parsed = splitModelCode(value, providers);
    if (parsed) return joinModelCode(parsed.provider, parsed.upstream);
    migrated.add(value.trim());
    return joinModelCode(bindings[value.trim()] ?? fallbackProvider, value);
  };

  const rawModels = raw.models;
  if (rawModels !== undefined && !Array.isArray(rawModels)) {
    errors.push("chain.models 必须是数组");
  } else if (Array.isArray(rawModels)) {
    for (const entry of rawModels) {
      if (typeof entry !== "string" || entry.trim() === "") {
        warnings.push("chain.models 忽略了非法条目");
        continue;
      }
      const code = normalize(entry);
      if (!models.includes(code)) models.push(code);
    }
  }

  let active = readString(raw, "active", "");
  if (!active) {
    active = models[0] ?? "";
  } else {
    active = normalize(active);
    if (!models.includes(active)) {
      warnings.push(`当前模型 ${active} 不在模型列表里，已改为 ${models[0] ?? "（空）"}`);
      active = models[0] ?? "";
    }
  }

  if (migrated.size > 0) {
    migrations.push(`已为 ${migrated.size} 个模型补全提供商标识`);
  }

  return {
    active,
    models,
    context: readContext(raw, "chain", errors),
    retryDeadAfterMinutes: readNumber(
      raw,
      "retryDeadAfterMinutes",
      DEFAULT_RETRY_DEAD_AFTER_MINUTES,
      0,
      1_000_000,
      "chain.retryDeadAfterMinutes",
      errors,
    ),
  };
}

function readModelApis(
  source: Obj,
  chain: ChainConfig,
  providers: ProviderConfig[],
  bindings: Record<string, string>,
  errors: string[],
  migrations: string[],
): ModelApiMap {
  const map: ModelApiMap = {};
  const raw = source.modelApis;

  if (raw !== undefined && !isObj(raw)) {
    errors.push("modelApis 必须是对象");
  }

  if (isObj(raw)) {
    let dropped = 0;
    for (const [rawCode, rawValue] of Object.entries(raw)) {
      const rawKey = rawCode.trim();
      if (!rawKey) {
        errors.push("modelApis 包含空的模型 code");
        continue;
      }
      const parsed = splitModelCode(rawKey, providers);
      let code: string;
      if (parsed) code = joinModelCode(parsed.provider, parsed.upstream);
      else if (bindings[rawKey]) code = joinModelCode(bindings[rawKey], rawKey);
      else if (chain.models.includes(rawKey)) code = rawKey;
      else {
        // 旧版本会给整个模型目录写默认能力；这些条目不指向任何已绑定提供商的模型，直接丢弃
        dropped += 1;
        continue;
      }
      if (!Array.isArray(rawValue)) {
        errors.push(`modelApis.${rawKey} 必须是数组`);
        continue;
      }
      const apis: ApiKind[] = [];
      for (const entry of rawValue) {
        if (typeof entry !== "string" || !isApiKind(entry)) {
          errors.push(`modelApis.${rawKey} 包含未知 API：${String(entry)}`);
          continue;
        }
        if (!apis.includes(entry)) apis.push(entry);
      }
      if (apis.length === 0) {
        errors.push(`modelApis.${rawKey} 至少需要一个 API`);
        continue;
      }
      map[code] = API_KINDS.filter((kind) => apis.includes(kind));
    }
    if (dropped > 0) {
      migrations.push(`modelApis 中 ${dropped} 个旧条目不指向已加入的模型，已清理`);
    }
  }

  for (const code of chain.models) {
    if (!map[code]) map[code] = [...DEFAULT_MODEL_APIS];
  }

  return map;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = CLOCK_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function readPrice(value: unknown, path: string, errors: string[]): number {
  if (value === undefined) {
    errors.push(`${path} 不能为空`);
    return 0;
  }
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(num) || num < 0 || num > 1_000_000_000) {
    errors.push(`${path} 必须是非负数字`);
    return 0;
  }
  return num;
}

function coversDay(tiers: PriceTier[]): boolean {
  const covered = new Array<boolean>(1_440).fill(false);
  for (const tier of tiers) {
    const from = readClock(tier.from) ?? 0;
    const to = readClock(tier.to) ?? 0;
    if (from === to) return true;
    if (from < to) {
      for (let minute = from; minute < to; minute += 1) covered[minute] = true;
    } else {
      for (let minute = from; minute < 1_440; minute += 1) covered[minute] = true;
      for (let minute = 0; minute < to; minute += 1) covered[minute] = true;
    }
  }
  return covered.every(Boolean);
}

function readPricing(
  source: Obj,
  providers: ProviderConfig[],
  bindings: Record<string, string>,
  errors: string[],
  migrations: string[],
): PricingConfig {
  const pricing: PricingConfig = {
    currency: DEFAULT_PRICING_CURRENCY,
    unit: DEFAULT_PRICING_UNIT,
    models: {},
  };
  if (source.pricing === undefined) return pricing;
  if (!isObj(source.pricing)) {
    errors.push("pricing 必须是对象");
    return pricing;
  }

  const raw = source.pricing;
  pricing.currency = readString(raw, "currency", pricing.currency) || pricing.currency;
  pricing.unit = readNumber(raw, "unit", pricing.unit, 1, 1_000_000_000, "pricing.unit", errors);

  if (raw.models === undefined) return pricing;
  if (!isObj(raw.models)) {
    errors.push("pricing.models 必须是对象");
    return pricing;
  }

  let dropped = 0;
  for (const [rawCode, rawValue] of Object.entries(raw.models)) {
    const rawKey = rawCode.trim();
    const path = `pricing.models.${rawKey || "(empty)"}`;
    if (!rawKey) {
      errors.push("pricing.models 包含空的模型 code");
      continue;
    }
    const parsed = splitModelCode(rawKey, providers);
    let code: string;
    if (parsed) code = joinModelCode(parsed.provider, parsed.upstream);
    else if (bindings[rawKey]) code = joinModelCode(bindings[rawKey], rawKey);
    else {
      dropped += 1;
      continue;
    }
    if (!isObj(rawValue)) {
      errors.push(`${path} 必须是对象`);
      continue;
    }
    if (!Array.isArray(rawValue.tiers) || rawValue.tiers.length === 0) {
      errors.push(`${path}.tiers 必须是非空数组`);
      continue;
    }
    if (rawValue.tiers.length > 12) {
      errors.push(`${path}.tiers 最多 12 档`);
      continue;
    }

    const tiers: PriceTier[] = [];
    for (const [index, rawTier] of rawValue.tiers.entries()) {
      const tierPath = `${path}.tiers[${index}]`;
      if (!isObj(rawTier)) {
        errors.push(`${tierPath} 必须是对象`);
        continue;
      }
      const from = readClock(rawTier.from);
      const to = readClock(rawTier.to);
      if (from === null) errors.push(`${tierPath}.from 必须是 HH:MM`);
      if (to === null) errors.push(`${tierPath}.to 必须是 HH:MM`);
      const input = readPrice(rawTier.input, `${tierPath}.input`, errors);
      const cachedInput = readPrice(rawTier.cachedInput, `${tierPath}.cachedInput`, errors);
      const output = readPrice(rawTier.output, `${tierPath}.output`, errors);
      if (cachedInput > input) errors.push(`${tierPath}.cachedInput 不能高于 input`);
      if (from === null || to === null) continue;
      tiers.push({
        from: String(rawTier.from).trim(),
        to: String(rawTier.to).trim(),
        input,
        cachedInput,
        output,
      });
    }
    if (tiers.length === 0) continue;
    if (!coversDay(tiers)) {
      errors.push(`${path}.tiers 必须覆盖一整天（00:00–24:00），可用 from == to 表示全天`);
    }
    pricing.models[code] = { tiers };
  }
  if (dropped > 0) {
    migrations.push(`pricing.models 中 ${dropped} 个条目没有对应已绑定提供商的模型，已忽略`);
  }

  return pricing;
}

function readResponsesChaining(source: Obj, errors: string[]): ResponsesChainingConfig {
  const defaults: ResponsesChainingConfig = { enabled: false, ttlMinutes: 120, maxSessions: 500 };
  if (source.responsesChaining === undefined) return defaults;
  if (!isObj(source.responsesChaining)) {
    errors.push("responsesChaining 必须是对象");
    return defaults;
  }
  const raw = source.responsesChaining;
  return {
    enabled: readBool(raw, "enabled", defaults.enabled),
    ttlMinutes: readNumber(raw, "ttlMinutes", defaults.ttlMinutes, 1, 1_440, "responsesChaining.ttlMinutes", errors),
    maxSessions: Math.trunc(readNumber(raw, "maxSessions", defaults.maxSessions, 1, 10_000, "responsesChaining.maxSessions", errors)),
  };
}

export function normalizeConfig(input: unknown): NormalizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const migrations: string[] = [];
  const defaults = defaultConfig();
  const config: GatewayConfig = clone(defaults);
  const source = isObj(input) ? input : {};

  if (!isObj(input)) errors.push("配置根节点必须是对象");

  config.host = readString(source, "host", defaults.host) || defaults.host;
  config.port = readNumber(source, "port", defaults.port, 1, 65_535, "port", errors);
  config.gatewayToken = readString(source, "gatewayToken", "");

  const providerResult = readProviders(source, errors, warnings, migrations);
  config.providers = providerResult.providers;
  config.defaultProvider = providerResult.defaultProvider;
  const bindings = readLegacyBindings(source, config.providers, errors, migrations);

  config.chain = readChain(source, config.providers, bindings, config.defaultProvider, errors, warnings, migrations);
  config.modelApis = readModelApis(source, config.chain, config.providers, bindings, errors, migrations);

  const server = isObj(source.server) ? source.server : {};
  if (source.server !== undefined && !isObj(source.server)) errors.push("server 必须是对象");
  config.server = {
    maxBodyBytes: readNumber(
      server,
      "maxBodyBytes",
      defaults.server.maxBodyBytes,
      1_024,
      256 * 1024 * 1024,
      "server.maxBodyBytes",
      errors,
    ),
    cors: readBool(server, "cors", defaults.server.cors),
  };

  const ui = isObj(source.ui) ? source.ui : {};
  if (source.ui !== undefined && !isObj(source.ui)) errors.push("ui 必须是对象");
  config.ui = { enabled: readBool(ui, "enabled", defaults.ui.enabled) };

  const log = isObj(source.log) ? source.log : {};
  if (source.log !== undefined && !isObj(source.log)) errors.push("log 必须是对象");
  const rawLevel = log.level;
  let level: LogLevelName = defaults.log.level;
  if (typeof rawLevel === "string" && isLogLevel(rawLevel)) level = rawLevel;
  else if (rawLevel !== undefined) errors.push("log.level 只能是 debug / info / warn / error");
  config.log = {
    level,
    file: readString(log, "file", ""),
    maxBytes: readNumber(log, "maxBytes", defaults.log.maxBytes, 0, 10 * 1024 * 1024 * 1024, "log.maxBytes", errors),
    maxFiles: Math.trunc(readNumber(log, "maxFiles", defaults.log.maxFiles, 0, 100, "log.maxFiles", errors)),
  };

  if (config.chain.models.length === 0) {
    warnings.push("模型列表里还没有任何模型：配好提供商后从「模型目录」加入，或直接在 chain.models 里填写");
  }

  const failover = isObj(source.failover) ? source.failover : {};
  config.failover = {
    maxAttempts: readNumber(failover, "maxAttempts", defaults.failover.maxAttempts, 1, 32, "failover.maxAttempts", errors),
    throttleCooldownMs: readNumber(
      failover,
      "throttleCooldownMs",
      defaults.failover.throttleCooldownMs,
      0,
      3_600_000,
      "failover.throttleCooldownMs",
      errors,
    ),
  };

  config.pricing = readPricing(source, config.providers, bindings, errors, migrations);
  config.responsesChaining = readResponsesChaining(source, errors);

  return {
    ok: errors.length === 0,
    config,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    migrations: [...new Set(migrations)],
  };
}
