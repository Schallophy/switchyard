import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApiKind } from "../config/schema.ts";
import type { CallerIdentity } from "../core/caller.ts";
import type { ModelRecord, Usage } from "../types.ts";
import { familyOf } from "../util/model.ts";

export interface CatalogEntry {
  /** `提供商/模型名`，与 chain.models 使用同一套标识。 */
  code: string;
  /** 上游模型名（不含提供商标识）。 */
  upstream: string;
  family: string;
  /** 该模型来自哪个提供商；同名模型在不同提供商下是两条记录。 */
  provider: string;
}

export interface ApiStat {
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheTrackedPromptTokens: number;
  completionTokens: number;
  cost: number;
  lastModel: string | null;
  lastUsedAt: string | null;
}

export type ApiStats = Record<ApiKind, ApiStat>;

export interface Stats {
  startedAt: string;
  requests: number;
  failovers: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheTrackedPromptTokens: number;
  completionTokens: number;
  cost: number;
  /** 按协议（chat / completions / responses / embeddings）拆分。 */
  apis: ApiStats;
}

export interface CallerRecord {
  id: string;
  label: string;
  requests: number;
  failures: number;
  failovers: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheTrackedPromptTokens: number;
  completionTokens: number;
  cost: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastModel: string | null;
  /** 最近一次请求走的协议。 */
  lastApi: ApiKind | null;
}

export interface CalibrationBucket {
  /** 提供商 prompt token ÷ 本地估算 prompt token，按样本量加权更新。 */
  ratio: number;
  samples: number;
}

export interface CalibrationRecord {
  plain?: CalibrationBucket;
  tools?: CalibrationBucket;
}

export interface PersistedState {
  version: number;
  models: Record<string, ModelRecord>;
  callers: Record<string, CallerRecord>;
  calibration: Record<string, CalibrationRecord>;
  catalog: {
    fetchedAt: string | null;
    models: CatalogEntry[];
  };
  stats: Stats;
}

export interface StateOpenOptions {
  file: string;
  codes: string[];
  onError?: (error: unknown) => void;
}

function blankRecord(code: string): ModelRecord {
  return {
    code,
    family: familyOf(code),
    health: "unknown",
    reason: null,
    lastErrorCode: null,
    lastStatusCode: null,
    lastErrorMessage: null,
    checkedAt: null,
    lastUsedAt: null,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheTrackedPromptTokens: 0,
    completionTokens: 0,
    cost: 0,
    requests: 0,
    failures: 0,
    throttledUntil: null,
  };
}

function blankApiStat(): ApiStat {
  return {
    requests: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheTrackedPromptTokens: 0,
    completionTokens: 0,
    cost: 0,
    lastModel: null,
    lastUsedAt: null,
  };
}

function blankApis(): ApiStats {
  return {
    chat: blankApiStat(),
    completions: blankApiStat(),
    responses: blankApiStat(),
    embeddings: blankApiStat(),
  };
}

function blankCaller(caller: CallerIdentity, at: string): CallerRecord {
  return {
    id: caller.id,
    label: caller.label,
    requests: 0,
    failures: 0,
    failovers: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheTrackedPromptTokens: 0,
    completionTokens: 0,
    cost: 0,
    firstSeenAt: at,
    lastSeenAt: at,
    lastModel: null,
    lastApi: null,
  };
}

function blankState(): PersistedState {
  return {
    version: 1,
    models: {},
    callers: {},
    calibration: {},
    catalog: { fetchedAt: null, models: [] },
    stats: {
      startedAt: new Date().toISOString(),
      requests: 0,
      failovers: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheTrackedPromptTokens: 0,
      completionTokens: 0,
      cost: 0,
      apis: blankApis(),
    },
  };
}

export class StateStore {
  readonly file: string;
  #data: PersistedState;
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<unknown> = Promise.resolve();
  #onError: (error: unknown) => void;

  private constructor(file: string, data: PersistedState, onError: (error: unknown) => void) {
    this.file = file;
    this.#data = data;
    this.#onError = onError;
  }

  static async open(options: StateOpenOptions): Promise<StateStore> {
    const onError = options.onError ?? (() => undefined);
    await mkdir(dirname(options.file), { recursive: true });

    let data = blankState();
    try {
      const raw = await readFile(options.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = hydrate(parsed as Record<string, unknown>);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${options.file}.corrupt-${Date.now()}`;
        await rename(options.file, backup).catch(() => undefined);
        onError(error);
      }
    }

    const store = new StateStore(options.file, data, onError);
    store.ensure(options.codes);
    return store;
  }

  get stats(): Stats {
    return this.#data.stats;
  }

  get catalog(): { fetchedAt: string | null; models: CatalogEntry[] } {
    return this.#data.catalog;
  }

  callers(): CallerRecord[] {
    return Object.values(this.#data.callers);
  }

  all(): Record<string, ModelRecord> {
    return this.#data.models;
  }

  get(code: string): ModelRecord | undefined {
    return this.#data.models[code];
  }

  ensure(codes: string[]): void {
    let changed = false;
    for (const code of codes) {
      if (!code) continue;
      if (!this.#data.models[code]) {
        this.#data.models[code] = blankRecord(code);
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  /**
   * 只保留模型列表里的记录。模型由用户显式加入，目录里的候选模型不算「已添加」，
   * 所以它们既不会出现在 state.json 的 models 里，也不会保留健康状态与用量。
   */
  pruneModels(keep: string[]): void {
    const allowed = new Set(keep);
    let changed = false;
    for (const code of Object.keys(this.#data.models)) {
      if (allowed.has(code)) continue;
      delete this.#data.models[code];
      changed = true;
    }
    for (const code of Object.keys(this.#data.calibration)) {
      if (allowed.has(code)) continue;
      delete this.#data.calibration[code];
      changed = true;
    }
    if (changed) this.saveSoon();
  }

  setHealth(code: string, health: ModelRecord["health"], patch: Partial<ModelRecord> = {}): void {
    const record = this.#data.models[code];
    if (!record) return;
    this.#data.models[code] = { ...record, ...patch, code, health };
    this.saveSoon();
  }

  markUsed(code: string, usage: Usage | null, cost = 0, api: ApiKind = "chat"): void {
    const record = this.#data.models[code];
    const cached = usage?.cachedPromptTokens ?? 0;
    const tracked = usage?.cacheReported ? usage.promptTokens : 0;
    const now = new Date().toISOString();
    // 只有用户加入列表的模型才有记录；透传模型只计入全局与调用方统计
    if (record) {
      this.#data.models[code] = {
        ...record,
        health: "alive",
        reason: null,
        lastStatusCode: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        checkedAt: now,
        lastUsedAt: now,
        requests: record.requests + 1,
        throttledUntil: null,
        promptTokens: record.promptTokens + (usage?.promptTokens ?? 0),
        cachedPromptTokens: record.cachedPromptTokens + cached,
        cacheTrackedPromptTokens: record.cacheTrackedPromptTokens + tracked,
        completionTokens: record.completionTokens + (usage?.completionTokens ?? 0),
        cost: record.cost + cost,
      };
    }
    if (usage) {
      this.#data.stats.promptTokens += usage.promptTokens;
      this.#data.stats.cachedPromptTokens += cached;
      this.#data.stats.cacheTrackedPromptTokens += tracked;
      this.#data.stats.completionTokens += usage.completionTokens;
      this.#data.stats.cost += cost;

      const stat = this.#data.stats.apis[api];
      stat.promptTokens += usage.promptTokens;
      stat.cachedPromptTokens += cached;
      stat.cacheTrackedPromptTokens += tracked;
      stat.completionTokens += usage.completionTokens;
      stat.cost += cost;
    }
    const stat = this.#data.stats.apis[api];
    stat.lastModel = code;
    stat.lastUsedAt = now;
    this.saveSoon();
  }

  markFailure(code: string): void {
    const record = this.#data.models[code];
    if (!record) return;
    this.#data.models[code] = { ...record, failures: record.failures + 1 };
    this.saveSoon();
  }

  addUsage(code: string, usage: Usage, cost = 0, api: ApiKind = "chat"): void {
    const record = this.#data.models[code];
    const tracked = usage.cacheReported ? usage.promptTokens : 0;
    const now = new Date().toISOString();
    if (record) {
      this.#data.models[code] = {
        ...record,
        lastUsedAt: now,
        promptTokens: record.promptTokens + usage.promptTokens,
        cachedPromptTokens: record.cachedPromptTokens + usage.cachedPromptTokens,
        cacheTrackedPromptTokens: record.cacheTrackedPromptTokens + tracked,
        completionTokens: record.completionTokens + usage.completionTokens,
        cost: record.cost + cost,
      };
    }
    this.#data.stats.promptTokens += usage.promptTokens;
    this.#data.stats.cachedPromptTokens += usage.cachedPromptTokens;
    this.#data.stats.cacheTrackedPromptTokens += tracked;
    this.#data.stats.completionTokens += usage.completionTokens;
    this.#data.stats.cost += cost;

    const stat = this.#data.stats.apis[api];
    stat.promptTokens += usage.promptTokens;
    stat.cachedPromptTokens += usage.cachedPromptTokens;
    stat.cacheTrackedPromptTokens += tracked;
    stat.completionTokens += usage.completionTokens;
    stat.cost += cost;
    stat.lastModel = code;
    stat.lastUsedAt = now;
    this.saveSoon();
  }

  recordCallerRequest(
    caller: CallerIdentity,
    patch: { ok: boolean; failovers: number; model: string | null; api?: ApiKind },
  ): void {
    const now = new Date().toISOString();
    const record = this.#data.callers[caller.id] ?? blankCaller(caller, now);
    this.#data.callers[caller.id] = {
      ...record,
      label: caller.label,
      requests: record.requests + 1,
      failures: record.failures + (patch.ok ? 0 : 1),
      failovers: record.failovers + Math.max(0, patch.failovers),
      lastSeenAt: now,
      lastModel: patch.model ?? record.lastModel,
      lastApi: patch.api ?? "chat",
    };
    this.saveSoon();
  }

  addCallerUsage(caller: CallerIdentity, usage: Usage | null, model: string, cost = 0, api: ApiKind = "chat"): void {
    const now = new Date().toISOString();
    const record = this.#data.callers[caller.id] ?? blankCaller(caller, now);
    const cached = usage?.cachedPromptTokens ?? 0;
    const tracked = usage?.cacheReported ? usage.promptTokens : 0;
    this.#data.callers[caller.id] = {
      ...record,
      label: caller.label,
      promptTokens: record.promptTokens + (usage?.promptTokens ?? 0),
      cachedPromptTokens: record.cachedPromptTokens + cached,
      cacheTrackedPromptTokens: record.cacheTrackedPromptTokens + tracked,
      completionTokens: record.completionTokens + (usage?.completionTokens ?? 0),
      cost: record.cost + cost,
      lastSeenAt: now,
      lastModel: model,
      lastApi: api,
    };
    this.saveSoon();
  }

  /** 已学习的修正系数：提供商实际 prompt token ÷ 本地估算。没有样本时为 1。 */
  calibrationRatio(code: string, hasTools: boolean): number {
    const record = this.#data.calibration[code];
    const bucket = hasTools ? (record?.tools ?? record?.plain) : (record?.plain ?? record?.tools);
    return bucket?.ratio ?? 1;
  }

  /**
   * 用提供商返回的 prompt token 修正本地估算。带 tools 的请求单独统计，
   * 因为工具定义序列化后的开销和普通文本差别很大。样本按估算长度加权，
   * 长请求（更接近真实比例）比短请求更快改变系数。
   */
  observeCalibration(code: string, hasTools: boolean, estimatedPrompt: number, actualPrompt: number): void {
    if (!(estimatedPrompt >= 100) || !(actualPrompt > 0)) return;

    const observed = clampRatio(actualPrompt / estimatedPrompt);
    const key: keyof CalibrationRecord = hasTools ? "tools" : "plain";
    const record = this.#data.calibration[code] ?? {};
    const previous = record[key];
    const weight = Math.min(0.5, Math.max(0.02, estimatedPrompt / (estimatedPrompt + 5000)));
    const ratio = clampRatio(previous ? previous.ratio + (observed - previous.ratio) * weight : observed);

    this.#data.calibration[code] = {
      ...record,
      [key]: { ratio, samples: (previous?.samples ?? 0) + 1 },
    };
    this.saveSoon();
  }

  /**
   * 旧版本按裸模型名记账；现在模型 code 带提供商前缀。把旧记录并到新 code 上，
   * 保留健康状态、用量与校准样本，避免升级后历史凭空消失。
   */
  migrateModelCodes(resolve: (code: string) => string | null): void {
    let changed = false;
    for (const [code, record] of Object.entries(this.#data.models)) {
      const target = resolve(code);
      if (!target || target === code) continue;
      const existing = this.#data.models[target];
      if (!existing) {
        this.#data.models[target] = { ...record, code: target };
      } else {
        const keep = newest(existing.checkedAt, record.checkedAt) === record.checkedAt ? record : existing;
        this.#data.models[target] = {
          ...existing,
          health: keep.health,
          reason: keep.reason,
          lastErrorCode: keep.lastErrorCode,
          lastStatusCode: keep.lastStatusCode,
          lastErrorMessage: keep.lastErrorMessage,
          checkedAt: keep.checkedAt,
          throttledUntil: keep.throttledUntil,
          lastUsedAt: newest(existing.lastUsedAt, record.lastUsedAt) === record.lastUsedAt ? record.lastUsedAt : existing.lastUsedAt,
          requests: existing.requests + record.requests,
          failures: existing.failures + record.failures,
          promptTokens: existing.promptTokens + record.promptTokens,
          cachedPromptTokens: existing.cachedPromptTokens + record.cachedPromptTokens,
          cacheTrackedPromptTokens: existing.cacheTrackedPromptTokens + record.cacheTrackedPromptTokens,
          completionTokens: existing.completionTokens + record.completionTokens,
          cost: existing.cost + record.cost,
        };
      }
      delete this.#data.models[code];
      changed = true;
    }

    for (const [code, record] of Object.entries(this.#data.calibration)) {
      const target = resolve(code);
      if (!target || target === code) continue;
      if (!this.#data.calibration[target]) this.#data.calibration[target] = record;
      delete this.#data.calibration[code];
      changed = true;
    }

    for (const stat of Object.values(this.#data.stats.apis)) {
      if (stat.lastModel) stat.lastModel = resolve(stat.lastModel) ?? stat.lastModel;
    }
    for (const caller of Object.values(this.#data.callers)) {
      if (caller.lastModel) caller.lastModel = resolve(caller.lastModel) ?? caller.lastModel;
    }

    if (changed) this.saveSoon();
  }

  bumpRequests(api: ApiKind = "chat"): void {
    const now = new Date().toISOString();
    this.#data.stats.requests += 1;
    const stat = this.#data.stats.apis[api];
    stat.requests += 1;
    stat.lastUsedAt = now;
    this.saveSoon();
  }

  /**
   * 用给定单价重算已累计 token 的成本。调用方没有按模型拆分用量，
   * 因此调用方成本按它最近使用的模型计价（单一模型或同价模型时准确）。
   */
  recomputeCosts(
    costFor: (
      model: string | null,
      usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number },
    ) => number,
  ): void {
    let total = 0;
    for (const record of Object.values(this.#data.models)) {
      record.cost = costFor(record.code, record);
      total += record.cost;
    }
    for (const caller of Object.values(this.#data.callers)) {
      caller.cost = costFor(caller.lastModel, caller);
    }
    for (const stat of Object.values(this.#data.stats.apis)) {
      stat.cost = costFor(stat.lastModel, stat);
    }
    this.#data.stats.cost = total;
    this.saveSoon();
  }

  resetUsage(): void {
    const now = new Date().toISOString();
    this.#data.stats = {
      startedAt: now,
      requests: 0,
      failovers: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheTrackedPromptTokens: 0,
      completionTokens: 0,
      cost: 0,
      apis: blankApis(),
    };
    for (const [code, record] of Object.entries(this.#data.models)) {
      this.#data.models[code] = {
        ...record,
        requests: 0,
        failures: 0,
        promptTokens: 0,
        cachedPromptTokens: 0,
        cacheTrackedPromptTokens: 0,
        completionTokens: 0,
        cost: 0,
      };
    }
    this.#data.callers = {};
    this.saveSoon();
  }

  bumpFailovers(count: number): void {
    this.#data.stats.failovers += count;
    this.saveSoon();
  }

  setCatalog(entries: Array<{ id: string; provider: string }>): void {
    const byCode = new Map<string, CatalogEntry>();
    for (const entry of entries) {
      const upstream = entry.id.trim();
      const provider = entry.provider.trim();
      if (!upstream || !provider) continue;
      const code = `${provider}/${upstream}`;
      if (byCode.has(code)) continue;
      byCode.set(code, { code, upstream, family: familyOf(upstream), provider });
    }
    this.#data.catalog = {
      fetchedAt: new Date().toISOString(),
      models: [...byCode.values()].sort((a, b) => a.family.localeCompare(b.family) || a.code.localeCompare(b.code)),
    };
    this.saveSoon();
  }

  saveSoon(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#persist();
    }, 300);
    this.#timer.unref();
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#persist();
    await this.#writing;
  }

  #persist(): void {
    this.#writing = this.#writing.then(() => this.#write()).catch(this.#onError);
  }

  async #write(): Promise<void> {
    const payload = `${JSON.stringify(this.#data, null, 2)}\n`;
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, payload, "utf8");
    await rename(temp, this.file);
  }
}

function hydrate(source: Record<string, unknown>): PersistedState {
  const base = blankState();
  const stats = source.stats;
  if (stats && typeof stats === "object") {
    const record = stats as Record<string, unknown>;
    base.stats = {
      startedAt: typeof record.startedAt === "string" ? record.startedAt : base.stats.startedAt,
      requests: numberOr(record.requests, 0),
      failovers: numberOr(record.failovers, 0),
      promptTokens: numberOr(record.promptTokens, 0),
      cachedPromptTokens: numberOr(record.cachedPromptTokens, 0),
      cacheTrackedPromptTokens: numberOr(record.cacheTrackedPromptTokens, 0),
      completionTokens: numberOr(record.completionTokens, 0),
      cost: numberOr(record.cost, 0),
      apis: hydrateApis(record.apis),
    };
  }

  const callers = source.callers;
  if (callers && typeof callers === "object" && !Array.isArray(callers)) {
    for (const [id, raw] of Object.entries(callers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      base.callers[id] = {
        id,
        label: typeof record.label === "string" && record.label ? record.label : id,
        requests: numberOr(record.requests, 0),
        failures: numberOr(record.failures, 0),
        failovers: numberOr(record.failovers, 0),
        promptTokens: numberOr(record.promptTokens, 0),
        cachedPromptTokens: numberOr(record.cachedPromptTokens, 0),
        cacheTrackedPromptTokens: numberOr(record.cacheTrackedPromptTokens, 0),
        completionTokens: numberOr(record.completionTokens, 0),
        cost: numberOr(record.cost, 0),
        firstSeenAt: typeof record.firstSeenAt === "string" ? record.firstSeenAt : base.stats.startedAt,
        lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : base.stats.startedAt,
        lastModel: typeof record.lastModel === "string" ? record.lastModel : null,
        lastApi: isApiKindValue(record.lastApi) ? record.lastApi : null,
      };
    }
  }

  const models = source.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const [code, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      base.models[code] = { ...blankRecord(code), ...(raw as Partial<ModelRecord>) };
    }
  }

  const calibration = source.calibration;
  if (calibration && typeof calibration === "object" && !Array.isArray(calibration)) {
    for (const [code, raw] of Object.entries(calibration as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const plain = bucketFrom(record.plain);
      const tools = bucketFrom(record.tools);
      if (!plain && !tools) continue;
      const entry: CalibrationRecord = {};
      if (plain) entry.plain = plain;
      if (tools) entry.tools = tools;
      base.calibration[code] = entry;
    }
  }

  const catalog = source.catalog;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    const record = catalog as Record<string, unknown>;
    const list = Array.isArray(record.models) ? record.models : [];
    const seen = new Set<string>();
    const models: CatalogEntry[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      // 旧版本把上游模型名存在 id 里，提供商标识单独放 provider
      const upstreamRaw = typeof raw.upstream === "string" ? raw.upstream : typeof raw.id === "string" ? raw.id : "";
      const providerRaw = typeof raw.provider === "string" ? raw.provider : "";
      const upstream = upstreamRaw.trim();
      if (!upstream) continue;
      const provider = providerRaw.trim();
      const code = typeof raw.code === "string" && raw.code.trim() ? raw.code.trim() : provider ? `${provider}/${upstream}` : upstream;
      if (seen.has(code)) continue;
      seen.add(code);
      models.push({
        code,
        upstream,
        family: typeof raw.family === "string" ? raw.family : familyOf(upstream),
        provider,
      });
    }
    base.catalog = {
      fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : null,
      models,
    };
  }

  return base;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 两个 ISO 时间取较新的一个；任一为空时返回另一个。 */
function newest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function isApiKindValue(value: unknown): value is ApiKind {
  return value === "chat" || value === "completions" || value === "responses" || value === "embeddings";
}

function hydrateApis(raw: unknown): ApiStats {
  const apis = blankApis();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return apis;
  for (const kind of Object.keys(apis) as ApiKind[]) {
    const value = (raw as Record<string, unknown>)[kind];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    apis[kind] = {
      requests: numberOr(record.requests, 0),
      promptTokens: numberOr(record.promptTokens, 0),
      cachedPromptTokens: numberOr(record.cachedPromptTokens, 0),
      cacheTrackedPromptTokens: numberOr(record.cacheTrackedPromptTokens, 0),
      completionTokens: numberOr(record.completionTokens, 0),
      cost: numberOr(record.cost, 0),
      lastModel: typeof record.lastModel === "string" ? record.lastModel : null,
      lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
    };
  }
  return apis;
}

const MIN_CALIBRATION_RATIO = 0.2;
const MAX_CALIBRATION_RATIO = 5;

function clampRatio(value: number): number {
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, value));
}

function bucketFrom(value: unknown): CalibrationBucket | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ratio = numberOr(record.ratio, 0);
  if (!(ratio > 0)) return undefined;
  return { ratio: clampRatio(ratio), samples: Math.max(0, Math.trunc(numberOr(record.samples, 0))) };
}
