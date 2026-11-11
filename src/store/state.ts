import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApiKind } from "../config/schema.ts";
import type { CallerIdentity } from "../core/caller.ts";
import type { CostBreakdown, CostSplit, ModelRecord, Usage } from "../types.ts";
import { familyOf } from "../util/model.ts";

/** 升级前的历史用量无法反推模型归属，统一放在这个 bucket 里。 */
export const LEGACY_CALLER_MODEL = "__legacy__";

type CostUsage = { promptTokens: number; cachedPromptTokens: number; completionTokens: number };

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
  costBreakdown: CostBreakdown;
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
  costBreakdown: CostBreakdown;
  /** 按协议（chat / completions / responses / embeddings）拆分。 */
  apis: ApiStats;
}

/** 某个调用方在某个模型上的累计用量。 */
export interface CallerModelStat {
  /** 模型 code；升级前的汇总行是 null。 */
  model: string | null;
  /** 在该模型上发生的尝试次数，含成功与失败。 */
  attempts: number;
  /** 成功承接并返回响应的请求数。 */
  requests: number;
  /** 在该模型上失败的尝试次数。 */
  failures: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheTrackedPromptTokens: number;
  completionTokens: number;
  cost: number;
  costBreakdown: CostBreakdown;
  firstSeenAt: string;
  lastSeenAt: string;
  lastApi: ApiKind | null;
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
  costBreakdown: CostBreakdown;
  firstSeenAt: string;
  lastSeenAt: string;
  lastModel: string | null;
  /** 最近一次请求走的协议。 */
  lastApi: ApiKind | null;
  /** 按模型拆分的用量；`LEGACY_CALLER_MODEL` 保存升级前的汇总。 */
  models: Record<string, CallerModelStat>;
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

function zeroSplit(): CostSplit {
  return { input: 0, cachedInput: 0, output: 0, cacheSaved: 0 };
}

function zeroBreakdown(estimated = false): CostBreakdown {
  return { ...zeroSplit(), estimated };
}

function addSplit(base: CostBreakdown, parts: CostSplit, estimated = false): CostBreakdown {
  return {
    input: base.input + parts.input,
    cachedInput: base.cachedInput + parts.cachedInput,
    output: base.output + parts.output,
    cacheSaved: base.cacheSaved + parts.cacheSaved,
    estimated: base.estimated || estimated,
  };
}

function splitTotal(parts: CostSplit): number {
  return parts.input + parts.cachedInput + parts.output;
}

/** 没有拆分数据时只保住总额，标记为估算。 */
function fallbackSplit(cost: number): CostSplit {
  return cost > 0 ? { input: cost, cachedInput: 0, output: 0, cacheSaved: 0 } : zeroSplit();
}

function sumBreakdowns(parts: CostBreakdown[]): CostBreakdown {
  const out = zeroBreakdown();
  for (const part of parts) {
    out.input += part.input;
    out.cachedInput += part.cachedInput;
    out.output += part.output;
    out.cacheSaved += part.cacheSaved;
    out.estimated = out.estimated || Boolean(part.estimated);
  }
  return out;
}

/** 历史数据只保留了总成本，按 token 比例估出三项后缩放到原金额。 */
function scaleSplit(parts: CostSplit | null, targetCost: number): CostBreakdown {
  if (!(targetCost > 0)) return zeroBreakdown(true);
  if (!parts) return { ...fallbackSplit(targetCost), estimated: true };
  const raw = splitTotal(parts);
  if (!(raw > 0)) return { ...fallbackSplit(targetCost), estimated: true };
  const factor = targetCost / raw;
  return {
    input: parts.input * factor,
    cachedInput: parts.cachedInput * factor,
    output: parts.output * factor,
    cacheSaved: parts.cacheSaved * factor,
    estimated: true,
  };
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
    costBreakdown: zeroBreakdown(),
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
    costBreakdown: zeroBreakdown(),
    lastModel: null,
    lastUsedAt: null,
  };
}

function blankCallerModel(model: string | null, at: string): CallerModelStat {
  return {
    model,
    attempts: 0,
    requests: 0,
    failures: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheTrackedPromptTokens: 0,
    completionTokens: 0,
    cost: 0,
    costBreakdown: zeroBreakdown(),
    firstSeenAt: at,
    lastSeenAt: at,
    lastApi: null,
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
    costBreakdown: zeroBreakdown(),
    firstSeenAt: at,
    lastSeenAt: at,
    lastModel: null,
    lastApi: null,
    models: {},
  };
}

function blankState(): PersistedState {
  return {
    version: 2,
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
      costBreakdown: zeroBreakdown(),
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

  markUsed(code: string, usage: Usage | null, cost = 0, api: ApiKind = "chat", parts?: CostSplit): void {
    const record = this.#data.models[code];
    const cached = usage?.cachedPromptTokens ?? 0;
    const tracked = usage?.cacheReported ? usage.promptTokens : 0;
    const split = parts ?? fallbackSplit(cost);
    const estimated = !parts && cost > 0;
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
        costBreakdown: addSplit(record.costBreakdown ?? zeroBreakdown(), split, estimated),
      };
    }
    if (usage) {
      this.#data.stats.promptTokens += usage.promptTokens;
      this.#data.stats.cachedPromptTokens += cached;
      this.#data.stats.cacheTrackedPromptTokens += tracked;
      this.#data.stats.completionTokens += usage.completionTokens;
      this.#data.stats.cost += cost;
      this.#data.stats.costBreakdown = addSplit(this.#data.stats.costBreakdown, split, estimated);

      const stat = this.#data.stats.apis[api];
      stat.promptTokens += usage.promptTokens;
      stat.cachedPromptTokens += cached;
      stat.cacheTrackedPromptTokens += tracked;
      stat.completionTokens += usage.completionTokens;
      stat.cost += cost;
      stat.costBreakdown = addSplit(stat.costBreakdown, split, estimated);
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

  addUsage(code: string, usage: Usage, cost = 0, api: ApiKind = "chat", parts?: CostSplit): void {
    const record = this.#data.models[code];
    const tracked = usage.cacheReported ? usage.promptTokens : 0;
    const split = parts ?? fallbackSplit(cost);
    const estimated = !parts && cost > 0;
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
        costBreakdown: addSplit(record.costBreakdown ?? zeroBreakdown(), split, estimated),
      };
    }
    this.#data.stats.promptTokens += usage.promptTokens;
    this.#data.stats.cachedPromptTokens += usage.cachedPromptTokens;
    this.#data.stats.cacheTrackedPromptTokens += tracked;
    this.#data.stats.completionTokens += usage.completionTokens;
    this.#data.stats.cost += cost;
    this.#data.stats.costBreakdown = addSplit(this.#data.stats.costBreakdown, split, estimated);

    const stat = this.#data.stats.apis[api];
    stat.promptTokens += usage.promptTokens;
    stat.cachedPromptTokens += usage.cachedPromptTokens;
    stat.cacheTrackedPromptTokens += tracked;
    stat.completionTokens += usage.completionTokens;
    stat.cost += cost;
    stat.costBreakdown = addSplit(stat.costBreakdown, split, estimated);
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

  addCallerUsage(
    caller: CallerIdentity,
    usage: Usage | null,
    model: string,
    cost = 0,
    api: ApiKind = "chat",
    parts?: CostSplit,
  ): void {
    const now = new Date().toISOString();
    const record = this.#data.callers[caller.id] ?? blankCaller(caller, now);
    const cached = usage?.cachedPromptTokens ?? 0;
    const tracked = usage?.cacheReported ? usage.promptTokens : 0;
    const split = parts ?? fallbackSplit(cost);
    const estimated = !parts && cost > 0;
    const bucket = record.models[model] ?? blankCallerModel(model, now);
    this.#data.callers[caller.id] = {
      ...record,
      label: caller.label,
      promptTokens: record.promptTokens + (usage?.promptTokens ?? 0),
      cachedPromptTokens: record.cachedPromptTokens + cached,
      cacheTrackedPromptTokens: record.cacheTrackedPromptTokens + tracked,
      completionTokens: record.completionTokens + (usage?.completionTokens ?? 0),
      cost: record.cost + cost,
      costBreakdown: addSplit(record.costBreakdown, split, estimated),
      lastSeenAt: now,
      lastModel: model,
      lastApi: api,
      models: {
        ...record.models,
        [model]: {
          ...bucket,
          attempts: bucket.attempts + 1,
          requests: bucket.requests + 1,
          promptTokens: bucket.promptTokens + (usage?.promptTokens ?? 0),
          cachedPromptTokens: bucket.cachedPromptTokens + cached,
          cacheTrackedPromptTokens: bucket.cacheTrackedPromptTokens + tracked,
          completionTokens: bucket.completionTokens + (usage?.completionTokens ?? 0),
          cost: bucket.cost + cost,
          costBreakdown: addSplit(bucket.costBreakdown, split, estimated),
          lastSeenAt: now,
          lastApi: api,
        },
      },
    };
    this.saveSoon();
  }

  /** 调用方在某个模型上的失败尝试；用于明细里的「失败」列。 */
  markCallerModelFailure(caller: CallerIdentity, model: string, api: ApiKind = "chat"): void {
    const now = new Date().toISOString();
    const record = this.#data.callers[caller.id] ?? blankCaller(caller, now);
    const bucket = record.models[model] ?? blankCallerModel(model, now);
    this.#data.callers[caller.id] = {
      ...record,
      label: caller.label,
      models: {
        ...record.models,
        [model]: {
          ...bucket,
          attempts: bucket.attempts + 1,
          failures: bucket.failures + 1,
          lastSeenAt: now,
          lastApi: api,
        },
      },
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
        this.#data.models[target] = { ...record, code: target, costBreakdown: record.costBreakdown ?? zeroBreakdown() };
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
          costBreakdown: sumBreakdowns([
            existing.costBreakdown ?? zeroBreakdown(),
            record.costBreakdown ?? zeroBreakdown(),
          ]),
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
      for (const [key, bucket] of Object.entries(caller.models)) {
        if (key === LEGACY_CALLER_MODEL) continue;
        const target = resolve(key);
        if (!target || target === key) continue;
        const existing = caller.models[target];
        caller.models[target] = existing
          ? {
              ...existing,
              model: target,
              attempts: existing.attempts + bucket.attempts,
              requests: existing.requests + bucket.requests,
              failures: existing.failures + bucket.failures,
              promptTokens: existing.promptTokens + bucket.promptTokens,
              cachedPromptTokens: existing.cachedPromptTokens + bucket.cachedPromptTokens,
              cacheTrackedPromptTokens: existing.cacheTrackedPromptTokens + bucket.cacheTrackedPromptTokens,
              completionTokens: existing.completionTokens + bucket.completionTokens,
              cost: existing.cost + bucket.cost,
              costBreakdown: sumBreakdowns([existing.costBreakdown, bucket.costBreakdown]),
              firstSeenAt:
                Date.parse(existing.firstSeenAt) <= Date.parse(bucket.firstSeenAt)
                  ? existing.firstSeenAt
                  : bucket.firstSeenAt,
              lastSeenAt:
                Date.parse(existing.lastSeenAt) >= Date.parse(bucket.lastSeenAt)
                  ? existing.lastSeenAt
                  : bucket.lastSeenAt,
            }
          : { ...bucket, model: target };
        delete caller.models[key];
        changed = true;
      }
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
   * 用给定单价重算已累计 token 的成本。调用方按模型明细逐项重算；
   * 没有明细时退回最近使用的模型（单一模型或同价模型时准确）。
   */
  recomputeCosts(costFor: (model: string | null, usage: CostUsage) => CostSplit): void {
    let modelTotal = 0;
    const modelParts: CostBreakdown[] = [];
    for (const record of Object.values(this.#data.models)) {
      const split = costFor(record.code, record);
      record.cost = splitTotal(split);
      record.costBreakdown = { ...split, estimated: true };
      modelTotal += record.cost;
      modelParts.push(record.costBreakdown);
    }

    for (const caller of Object.values(this.#data.callers)) {
      const buckets = Object.values(caller.models);
      if (buckets.length === 0) {
        const split = costFor(caller.lastModel, caller);
        caller.cost = splitTotal(split);
        caller.costBreakdown = { ...split, estimated: true };
        continue;
      }
      let callerTotal = 0;
      const callerParts: CostBreakdown[] = [];
      for (const bucket of buckets) {
        const split = costFor(bucket.model ?? caller.lastModel, bucket);
        bucket.cost = splitTotal(split);
        bucket.costBreakdown = { ...split, estimated: true };
        callerTotal += bucket.cost;
        callerParts.push(bucket.costBreakdown);
      }
      caller.cost = callerTotal;
      caller.costBreakdown = sumBreakdowns(callerParts);
    }

    for (const stat of Object.values(this.#data.stats.apis)) {
      const split = costFor(stat.lastModel, stat);
      stat.cost = splitTotal(split);
      stat.costBreakdown = { ...split, estimated: true };
    }

    const callers = Object.values(this.#data.callers);
    if (callers.length > 0) {
      this.#data.stats.cost = callers.reduce((sum, caller) => sum + caller.cost, 0);
      this.#data.stats.costBreakdown = sumBreakdowns(callers.map((caller) => caller.costBreakdown));
    } else {
      this.#data.stats.cost = modelTotal;
      this.#data.stats.costBreakdown = sumBreakdowns(modelParts);
    }
    this.saveSoon();
  }

  /**
   * 补齐升级前没有成本拆分、也没有调用方 × 模型明细的历史数据。
   * 拆分按 token 比例估算后缩放到已记录成本；调用方只有在唯一一个时
   * 才用顶层模型记录反推明细，其余情况统一放进 legacy bucket。
   */
  backfillUsageDetails(estimate: (model: string | null, usage: CostUsage) => CostSplit | null): boolean {
    let changed = false;

    for (const record of Object.values(this.#data.models)) {
      if (this.fillBreakdown(record, record.cost, () => estimate(record.code, record))) changed = true;
    }

    const callers = Object.values(this.#data.callers);
    const soleCaller = callers.length === 1 ? callers[0]! : null;
    for (const caller of callers) {
      if (
        Object.keys(caller.models).length === 0 &&
        (caller.promptTokens > 0 || caller.completionTokens > 0 || caller.cost > 0)
      ) {
        this.seedCallerModels(caller, soleCaller === caller ? Object.values(this.#data.models) : null);
        changed = true;
      }
      for (const bucket of Object.values(caller.models)) {
        const model = bucket.model ?? caller.lastModel;
        if (this.fillBreakdown(bucket, bucket.cost, () => (model ? estimate(model, bucket) : null))) {
          changed = true;
        }
      }
      if (splitTotal(caller.costBreakdown) <= 0 && caller.cost > 0) {
        const fromModels = sumBreakdowns(Object.values(caller.models).map((bucket) => bucket.costBreakdown));
        if (Math.abs(splitTotal(fromModels) - caller.cost) <= 1e-6 && splitTotal(fromModels) > 0) {
          caller.costBreakdown = fromModels;
        } else {
          caller.costBreakdown = scaleSplit(estimate(caller.lastModel, caller), caller.cost);
        }
        changed = true;
      }
    }

    for (const stat of Object.values(this.#data.stats.apis)) {
      if (this.fillBreakdown(stat, stat.cost, () => estimate(stat.lastModel, stat))) changed = true;
    }
    if (splitTotal(this.#data.stats.costBreakdown) <= 0 && this.#data.stats.cost > 0) {
      const fromCallers = sumBreakdowns(callers.map((caller) => caller.costBreakdown));
      if (Math.abs(splitTotal(fromCallers) - this.#data.stats.cost) <= 1e-6 && splitTotal(fromCallers) > 0) {
        this.#data.stats.costBreakdown = fromCallers;
      } else {
        const model = this.latestModel();
        this.#data.stats.costBreakdown = scaleSplit(model ? estimate(model, this.#data.stats) : null, this.#data.stats.cost);
      }
      changed = true;
    }

    if (changed) this.saveSoon();
    return changed;
  }

  private fillBreakdown<T extends { cost: number; costBreakdown: CostBreakdown }>(
    record: T,
    targetCost: number,
    estimate: () => CostSplit | null,
  ): boolean {
    if (splitTotal(record.costBreakdown) > 0 || !(targetCost > 0)) return false;
    record.costBreakdown = scaleSplit(estimate(), targetCost);
    return true;
  }

  private seedCallerModels(caller: CallerRecord, models: ModelRecord[] | null): void {
    const usable = (models ?? []).filter(
      (model) => model.promptTokens > 0 || model.completionTokens > 0 || model.cost > 0,
    );
    if (usable.length > 0) {
      const totals = usable.reduce(
        (sum, model) => ({
          prompt: sum.prompt + model.promptTokens,
          cached: sum.cached + model.cachedPromptTokens,
          tracked: sum.tracked + model.cacheTrackedPromptTokens,
          completion: sum.completion + model.completionTokens,
          cost: sum.cost + model.cost,
        }),
        { prompt: 0, cached: 0, tracked: 0, completion: 0, cost: 0 },
      );
      const fits =
        totals.prompt <= caller.promptTokens + 1e-6 &&
        totals.cached <= caller.cachedPromptTokens + 1e-6 &&
        totals.tracked <= caller.cacheTrackedPromptTokens + 1e-6 &&
        totals.completion <= caller.completionTokens + 1e-6 &&
        totals.cost <= caller.cost + 1e-6;
      if (fits) {
        for (const model of usable) {
          caller.models[model.code] = {
            model: model.code,
            attempts: model.requests + model.failures,
            requests: model.requests,
            failures: model.failures,
            promptTokens: model.promptTokens,
            cachedPromptTokens: model.cachedPromptTokens,
            cacheTrackedPromptTokens: model.cacheTrackedPromptTokens,
            completionTokens: model.completionTokens,
            cost: model.cost,
            costBreakdown: { ...model.costBreakdown },
            firstSeenAt: model.lastUsedAt ?? caller.firstSeenAt,
            lastSeenAt: model.lastUsedAt ?? caller.lastSeenAt,
            lastApi: caller.lastApi,
          };
        }
        const prompt = Math.max(0, caller.promptTokens - totals.prompt);
        const cached = Math.max(0, caller.cachedPromptTokens - totals.cached);
        const tracked = Math.max(0, caller.cacheTrackedPromptTokens - totals.tracked);
        const completion = Math.max(0, caller.completionTokens - totals.completion);
        const cost = Math.max(0, caller.cost - totals.cost);
        if (prompt > 0 || completion > 0 || cost > 1e-9) {
          caller.models[LEGACY_CALLER_MODEL] = {
            model: null,
            attempts: caller.requests,
            requests: caller.requests,
            failures: caller.failures,
            promptTokens: prompt,
            cachedPromptTokens: cached,
            cacheTrackedPromptTokens: tracked,
            completionTokens: completion,
            cost,
            costBreakdown: zeroBreakdown(true),
            firstSeenAt: caller.firstSeenAt,
            lastSeenAt: caller.lastSeenAt,
            lastApi: caller.lastApi,
          };
        }
        return;
      }
    }

    caller.models[LEGACY_CALLER_MODEL] = {
      model: null,
      attempts: caller.requests,
      requests: caller.requests,
      failures: caller.failures,
      promptTokens: caller.promptTokens,
      cachedPromptTokens: caller.cachedPromptTokens,
      cacheTrackedPromptTokens: caller.cacheTrackedPromptTokens,
      completionTokens: caller.completionTokens,
      cost: caller.cost,
      costBreakdown: zeroBreakdown(true),
      firstSeenAt: caller.firstSeenAt,
      lastSeenAt: caller.lastSeenAt,
      lastApi: caller.lastApi,
    };
  }

  private latestModel(): string | null {
    let best: { at: number; model: string } | null = null;
    for (const stat of Object.values(this.#data.stats.apis)) {
      if (!stat.lastModel) continue;
      const at = stat.lastUsedAt ? Date.parse(stat.lastUsedAt) : 0;
      if (!best || at > best.at) best = { at, model: stat.lastModel };
    }
    if (best) return best.model;
    for (const caller of Object.values(this.#data.callers)) {
      if (caller.lastModel) return caller.lastModel;
    }
    return null;
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
      costBreakdown: zeroBreakdown(),
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
        costBreakdown: zeroBreakdown(),
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
      costBreakdown: readBreakdown(record.costBreakdown),
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
        costBreakdown: readBreakdown(record.costBreakdown),
        firstSeenAt: typeof record.firstSeenAt === "string" ? record.firstSeenAt : base.stats.startedAt,
        lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : base.stats.startedAt,
        lastModel: typeof record.lastModel === "string" ? record.lastModel : null,
        lastApi: isApiKindValue(record.lastApi) ? record.lastApi : null,
        models: hydrateCallerModels(record.models, base.stats.startedAt),
      };
    }
  }

  const models = source.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const [code, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      base.models[code] = {
        ...blankRecord(code),
        ...(record as Partial<ModelRecord>),
        costBreakdown: readBreakdown(record.costBreakdown),
      };
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
      costBreakdown: readBreakdown(record.costBreakdown),
      lastModel: typeof record.lastModel === "string" ? record.lastModel : null,
      lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
    };
  }
  return apis;
}

function readBreakdown(raw: unknown): CostBreakdown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return zeroBreakdown();
  const record = raw as Record<string, unknown>;
  return {
    input: numberOr(record.input, 0),
    cachedInput: numberOr(record.cachedInput, 0),
    output: numberOr(record.output, 0),
    cacheSaved: numberOr(record.cacheSaved, 0),
    estimated: Boolean(record.estimated),
  };
}

function hydrateCallerModels(raw: unknown, fallbackAt: string): Record<string, CallerModelStat> {
  const models: Record<string, CallerModelStat> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return models;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const model = key === LEGACY_CALLER_MODEL ? null : typeof record.model === "string" ? record.model : key;
    models[key] = {
      model,
      attempts: numberOr(record.attempts, 0),
      requests: numberOr(record.requests, 0),
      failures: numberOr(record.failures, 0),
      promptTokens: numberOr(record.promptTokens, 0),
      cachedPromptTokens: numberOr(record.cachedPromptTokens, 0),
      cacheTrackedPromptTokens: numberOr(record.cacheTrackedPromptTokens, 0),
      completionTokens: numberOr(record.completionTokens, 0),
      cost: numberOr(record.cost, 0),
      costBreakdown: readBreakdown(record.costBreakdown),
      firstSeenAt: typeof record.firstSeenAt === "string" ? record.firstSeenAt : fallbackAt,
      lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : fallbackAt,
      lastApi: isApiKindValue(record.lastApi) ? record.lastApi : null,
    };
  }
  return models;
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
