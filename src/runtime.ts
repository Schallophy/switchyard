import type { ApiKind, ChainConfig, ContextConfig, GatewayConfig, ProviderConfig } from "./config/schema.ts";
import { saveConfig } from "./config/load.ts";
import { ANONYMOUS_CALLER, CONSOLE_CALLER, type CallerIdentity } from "./core/caller.ts";
import { apisFor as resolveApis, apiKindForPath, supportsApi as checkApi } from "./core/api.ts";
import { isThrottled } from "./core/meter.ts";
import { joinModelCode, splitModelCode } from "./core/model-code.ts";
import { EventLog } from "./core/events.ts";
import { LiveOutputLog } from "./core/live-output.ts";
import { runFailover, type FailoverHooks, type FailoverResult } from "./core/failover.ts";
import { priceTierAt, usageCost } from "./core/pricing.ts";
import {
  ResponseChainStore,
  captureResponseId,
  chainDelta,
  chainScope,
  itemsPrefixHashes,
  responsesInputItems,
} from "./core/responses-chain.ts";
import { isDeadRetryDue, resolveRoute, selectCandidates, type RouteMode } from "./core/selection.ts";
import { StateStore } from "./store/state.ts";
import type { AttemptRecord, AttemptOutcome, ModelRecord, NormalizedError, Usage } from "./types.ts";
import { ProviderClient, resolveKeyInfo, resolveProvider, keyInfoFor, type KeyInfo } from "./provider/client.ts";
import { estimateRequestTokens } from "./util/context.ts";
import type { Logger } from "./util/log.ts";
import { familyOf } from "./util/model.ts";
import { extractUsage } from "./util/usage.ts";

const FAILURE_LABELS: Record<string, string> = {
  quota_exhausted: "额度耗尽",
  model_invalid: "模型不存在",
  throttled: "限流中",
  auth: "认证失败",
  forbidden: "无权限",
  bad_request: "参数错误",
  provider: "上游故障",
  network: "网络错误",
  timeout: "超时",
  aborted: "已中断",
  exhausted: "全部不可用",
  context: "超出上下文",
  unknown: "未知错误",
};

export interface RuntimeOptions {
  configPath: string;
  dataDir: string;
  config: GatewayConfig;
  logger: Logger;
  warnings: string[];
}

export interface RuntimeSnapshotModel extends ModelRecord {
  apis: ApiKind[];
  /** 绑定的提供商 id。 */
  provider: string;
  /** 发给上游的模型名（去掉提供商前缀）。 */
  upstream: string;
}

export interface ChainSnapshot {
  /** auto 此刻实际会命中的模型：从列表第一个起，第一个可用（不在冷却中，且非 dead/invalid 或已到自动重试时间）的模型。 */
  effective: string | null;
  context: ChainConfig["context"];
  /** dead 模型多少分钟后自动重新参与选路；0 表示只能手动重置。 */
  retryDeadAfterMinutes: number;
  models: RuntimeSnapshotModel[];
  alive: number;
  dead: number;
}

/** 最近一次真正产出响应的模型，用于看板「当前输出」实时跟随流量。 */
export interface OutputSnapshot {
  model: string;
  provider: string | null;
  api: ApiKind;
  /** 客户端这次请求的 model 字段，可能是 auto。 */
  requested: string;
  mode: RouteMode;
  at: string;
}

/** 配置层面的规则冲突（非法模型、非法窗口等），由路由层翻译成 400。 */
export class ConfigRuleError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "ConfigRuleError";
    this.details = details;
  }
}

export interface TestResult {
  ok: boolean;
  model: string | null;
  content: string | null;
  latencyMs: number;
  usage: Usage | null;
  attempts: AttemptRecord[];
  message: string | null;
}

export interface CalibrationSample {
  /** 本地估算的 prompt token，用于和提供商的 usage.prompt_tokens 对比。 */
  estimatedPromptTokens: number;
  /** 请求是否带 tools/functions，工具定义的开销单独校准。 */
  hasTools: boolean;
}

export interface RoutedResult {
  result: FailoverResult;
  sample: CalibrationSample | null;
}

export class Runtime {
  config: GatewayConfig;
  readonly configPath: string;
  readonly dataDir: string;
  readonly logger: Logger;
  readonly store: StateStore;
  readonly events: EventLog;
  readonly liveOutput: LiveOutputLog;
  readonly client: ProviderClient;

  #bootedAt = new Date();
  #catalogError: string | null = null;
  #warnings: string[];
  #responsesChain = new ResponseChainStore();
  #chainStats = { requests: 0, hits: 0, fallbacks: 0 };
  #lastOutput: OutputSnapshot | null = null;

  private constructor(options: RuntimeOptions, store: StateStore) {
    this.config = options.config;
    this.configPath = options.configPath;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.store = store;
    this.events = new EventLog(`${options.dataDir}/events.jsonl`);
    this.liveOutput = new LiveOutputLog();
    this.client = new ProviderClient(() => this.config);
    this.#warnings = options.warnings;
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    const store = await StateStore.open({
      file: `${options.dataDir}/state.json`,
      codes: collectCodes(options.config, []),
      onError: (error) => options.logger.warn("state persistence failed", { error: error instanceof Error ? error.message : String(error) }),
    });
    const runtime = new Runtime(options, store);
    const aliases = collectModelAliases(options.config);
    if (aliases.size > 0) store.migrateModelCodes((code) => aliases.get(code) ?? null);
    // 模型只能由用户加入；目录里的候选模型不落盘
    store.pruneModels(options.config.chain.models);
    return runtime;
  }

  get bootedAt(): Date {
    return this.#bootedAt;
  }

  get catalogError(): string | null {
    return this.#catalogError;
  }

  get warnings(): string[] {
    const list = [...this.#warnings];
    if (this.#catalogError) list.push(`模型目录刷新失败：${this.#catalogError}`);
    return list;
  }

  keyInfo(): KeyInfo {
    return resolveKeyInfo(this.config);
  }

  /** 每个提供商各自的 Key 状态，看板用来显示一排 chip。 */
  providerKeyInfos(): KeyInfo[] {
    return this.config.providers.map((provider) => keyInfoFor(provider));
  }

  /** 模型绑定的提供商：code 形如 `提供商/模型名`；未带前缀的（透传请求）走默认提供商。 */
  providerFor(code: string): ProviderConfig | null {
    const parsed = splitModelCode(code, this.config.providers);
    if (parsed) return resolveProvider(this.config, parsed.provider);
    return resolveProvider(this.config);
  }

  providerIdFor(code: string): string | undefined {
    return this.providerFor(code)?.id;
  }

  /** 发给上游的模型名：去掉 `提供商/` 前缀。 */
  upstreamModelFor(code: string): string {
    return splitModelCode(code, this.config.providers)?.upstream ?? code;
  }

  /** 把用户输入的模型名归一成 `提供商/模型名`；缺提供商时返回 null。 */
  normalizeModelCode(raw: string): string | null {
    const code = raw.trim();
    const parsed = splitModelCode(code, this.config.providers);
    if (!parsed) return null;
    return joinModelCode(parsed.provider, parsed.upstream);
  }

  apisFor(code: string): ApiKind[] {
    return resolveApis(this.config.modelApis, code);
  }

  supportsApi(code: string, api: ApiKind): boolean {
    return checkApi(this.config.modelApis, code, api);
  }

  /** 列表第一个模型，也就是 auto 的起点；列表为空时为 null。 */
  primaryModel(): string | null {
    return this.config.chain.models[0] ?? null;
  }

  /** auto 此刻实际会命中的模型：按列表顺序找第一个可用（冷却中、失效、无效的除外）的模型。 */
  effectiveModel(): string | null {
    const codes = this.chainCodes();
    const retryMs = this.config.chain.retryDeadAfterMinutes * 60_000;
    const now = Date.now();
    for (const code of codes) {
      const record = this.store.get(code);
      const health = record?.health ?? "unknown";
      if (health === "invalid") continue;
      if (health === "dead" && (!record || !isDeadRetryDue(record, now, retryMs))) continue;
      if (record && isThrottled(record, now)) continue;
      return code;
    }
    return null;
  }

  chainCodes(): string[] {
    return [...this.config.chain.models];
  }

  /** 最近一次真正产出响应的模型；重启或尚无请求时为 null。 */
  lastOutput(): OutputSnapshot | null {
    return this.#lastOutput;
  }

  snapshotModel(code: string): RuntimeSnapshotModel {
    const record = this.store.get(code) ?? this.store.all()[code];
    const empty: ModelRecord = {
      code,
      family: "Other",
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
    const value = record ?? empty;
    const upstream = this.upstreamModelFor(code);
    const family = familyOf(upstream);
    return {
      ...value,
      family: family === "Other" ? value.family : family,
      apis: this.apisFor(code),
      provider: this.providerIdFor(code) ?? this.config.defaultProvider,
      upstream,
    };
  }

  chainSnapshot(): ChainSnapshot {
    const chain = this.config.chain;
    const models = chain.models.map((code) => this.snapshotModel(code));
    return {
      effective: this.effectiveModel(),
      context: chain.context,
      retryDeadAfterMinutes: chain.retryDeadAfterMinutes,
      models,
      alive: models.filter((model) => model.health === "alive").length,
      dead: models.filter((model) => model.health === "dead" || model.health === "invalid").length,
    };
  }

  hooks(): FailoverHooks {
    return {
      onDead: (model, error) => this.markDead(model, error),
      onInvalid: (model, error) => this.markInvalid(model, error),
      onThrottle: (model, error) => this.markThrottled(model, error),
      onSkip: (model, error) => this.markSkipped(model, error),
    };
  }

  markDead(model: string, error: NormalizedError): void {
    this.store.setHealth(model, "dead", {
      reason: error.label,
      lastErrorCode: error.code,
      lastStatusCode: error.status,
      lastErrorMessage: error.message,
      checkedAt: new Date().toISOString(),
    });
    this.events.push({
      kind: "dead",
      level: "warn",
      message: `${model} 已标记为不可用（${error.label}）`,
      model,
      detail: { status: error.status, code: error.code, message: error.message },
    });
    this.logger.warn(`${model} 不可用：${error.label}`, { code: error.code, status: error.status });
  }

  markInvalid(model: string, error: NormalizedError): void {
    this.store.setHealth(model, "invalid", {
      reason: error.label,
      lastErrorCode: error.code,
      lastStatusCode: error.status,
      lastErrorMessage: error.message,
      checkedAt: new Date().toISOString(),
    });
    this.events.push({
      kind: "dead",
      level: "warn",
      message: `${model} 模型不可用（${error.label}）`,
      model,
      detail: { status: error.status, code: error.code },
    });
    this.logger.warn(`${model}：${error.label}`, { code: error.code });
  }

  markThrottled(model: string, error: NormalizedError): void {
    const until = new Date(Date.now() + this.config.failover.throttleCooldownMs).toISOString();
    this.store.setHealth(model, this.store.get(model)?.health ?? "unknown", {
      throttledUntil: until,
      lastErrorCode: error.code,
      lastStatusCode: error.status,
      lastErrorMessage: error.message,
    });
    this.events.push({
      kind: "throttle",
      level: "info",
      message: `${model} 触发限流，冷却至 ${until}`,
      model,
      detail: { status: error.status, code: error.code },
    });
  }

  markSkipped(model: string, error: NormalizedError): void {
    this.logger.debug("attempt skipped", { model, kind: error.kind, status: error.status });
    const record = this.store.get(model);
    if (record?.health === "dead") {
      // 到点自动重试后仍然失败：重新计时，避免之后每次请求都先打它
      this.store.setHealth(model, "dead", {
        lastErrorCode: error.code,
        lastStatusCode: error.status,
        lastErrorMessage: error.message,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  async requestThrough(input: {
    path: string;
    model: string | undefined;
    body: Record<string, unknown>;
    signal?: AbortSignal;
    maxAttempts?: number;
    caller?: CallerIdentity;
  }): Promise<RoutedResult> {
    const api = apiKindForPath(input.path);
    const chain = this.config.chain;
    const route = resolveRoute(input.model, chain, this.config.providers);

    const hasTools =
      (Array.isArray(input.body.tools) && input.body.tools.length > 0) ||
      (Array.isArray(input.body.functions) && input.body.functions.length > 0);
    const estimate = isChatPath(input.path) ? estimateRequestTokens(input.path, input.body) : null;
    const sample: CalibrationSample | null = estimate
      ? { estimatedPromptTokens: estimate.promptTokens, hasTools }
      : null;

    const reject = (error: NormalizedError): RoutedResult => ({
      result: { ok: false, error, attempts: [], failovers: 0, latencyMs: 0, exhausted: false },
      sample,
    });

    const apiError = (message: string) =>
      reject({
        kind: "bad_request",
        label: "API 不兼容",
        status: 400,
        code: "switchyard.api_unsupported",
        message,
        fatal: true,
        markDead: false,
        markInvalid: false,
        retryable: false,
      });

    if (route.mode === "auto" && chain.models.length === 0) {
      return reject({
        kind: "exhausted",
        label: "模型列表为空",
        status: 503,
        code: "switchyard.chain_empty",
        message: "模型列表里还没有模型。请在看板的「模型」页加入模型，或在 config.json 的 chain.models 中填写。",
        fatal: true,
        markDead: false,
        markInvalid: false,
        retryable: false,
      });
    }

    if (route.model && route.mode !== "passthrough" && !this.supportsApi(route.model, api)) {
      return apiError(
        `模型 ${route.model} 未声明支持 ${api} API。请在该模型的 API 能力中启用 ${api}，或改用 auto。`,
      );
    }

    if (route.mode === "auto" && !chain.models.some((code) => this.supportsApi(code, api))) {
      return apiError(
        `模型列表中没有声明支持 ${api} API 的模型。请在配置 modelApis 中为候选模型启用 ${api}。`,
      );
    }

    if (route.mode === "passthrough" && route.model && this.config.modelApis[route.model] && !this.supportsApi(route.model, api)) {
      return apiError(`模型 ${route.model} 未声明支持 ${api} API。`);
    }

    let candidates: string[];
    if (route.mode === "auto") {
      candidates = selectCandidates({
        chain,
        getRecord: (code) => this.store.get(code),
        now: Date.now(),
        accepts: (code) => this.supportsApi(code, api),
        retryDeadAfterMs: chain.retryDeadAfterMinutes * 60_000,
      }).map((candidate) => candidate.code);
    } else {
      candidates = route.model ? [route.model] : [];
    }

    // 用实际会先尝试的模型校准过的系数来判断，避免本地估算系统性偏低时放行超限请求。
    if (estimate && chain.context.onOverflow === "reject" && candidates.length > 0) {
      const model = candidates[0] ?? "";
      const ratio = this.store.calibrationRatio(model, hasTools);
      const inputTokens = Math.round(estimate.promptTokens * ratio);
      const totalTokens = inputTokens + estimate.outputTokens;
      if (totalTokens > chain.context.window) {
        const calibration =
          ratio === 1 ? "" : `，按 ${model} 的校准系数 ×${ratio.toFixed(2)}（原始估算 ${estimate.promptTokens}）`;
        const error: NormalizedError = {
          kind: "context",
          label: "上下文超限",
          status: 400,
          code: "switchyard.context_length_exceeded",
          message:
            `请求约 ${totalTokens} tokens（输入 ${inputTokens} + 输出 ${estimate.outputTokens}${calibration}），` +
            `超过模型列表的上下文窗口 ${chain.context.window}。请缩短输入、调小 max_tokens，或调整 chain.context.window。`,
          fatal: true,
          markDead: false,
          markInvalid: false,
          retryable: false,
        };
        return reject(error);
      }
    }

    const chaining = this.config.responsesChaining;
    const chainEnabled =
      chaining.enabled &&
      input.path === "responses" &&
      candidates.length > 0 &&
      input.body.previous_response_id === undefined;

    if (input.path === "responses") {
      this.logger.debug("responses chaining", {
        enabled: chainEnabled,
        items: Array.isArray(input.body.input) ? input.body.input.length : typeof input.body.input,
        hasPrevious: input.body.previous_response_id !== undefined,
      });
    }

    let forwardBody = input.body;
    let chainItems: unknown[] | null = null;
    let chainHitKey: string | null = null;

    if (chainEnabled) {
      const items = responsesInputItems(input.body.input);
      if (items) {
        const scope = chainScope(
          (input.caller ?? ANONYMOUS_CALLER).id,
          this.providerIdFor(candidates[0] ?? "") ?? this.config.defaultProvider,
          candidates[0] ?? "",
          input.body.tools ?? null,
        );
        const hashes = itemsPrefixHashes(scope, items);
        for (let index = hashes.length - 1; index >= 0; index -= 1) {
          const key = hashes[index];
          if (!key) continue;
          const id = this.#responsesChain.lookup(key);
          if (!id) continue;
          const delta = chainDelta(items, index + 1);
          if (!delta) continue;
          forwardBody = { ...input.body, input: delta, previous_response_id: id, store: true };
          chainHitKey = key;
          break;
        }
        // 首轮也要让提供商保存，下一轮才能续接
        if (!chainHitKey) forwardBody = { ...input.body, store: true };
        chainItems = items;
        this.#chainStats.requests += 1;
        if (chainHitKey) this.#chainStats.hits += 1;
      }
    }

    const attemptWith =
      (body: Record<string, unknown>) =>
      (model: string, signal?: AbortSignal): Promise<AttemptOutcome> =>
        this.client.attempt(input.path, this.upstreamModelFor(model), body, {
          signal,
          providerId: this.providerIdFor(model),
        });

    let result = await runFailover({
      candidates,
      maxAttempts: input.maxAttempts ?? this.config.failover.maxAttempts,
      attempt: attemptWith(forwardBody),
      signal: input.signal,
      hooks: this.hooks(),
    });
    let chainServed = Boolean(chainHitKey);

    // response id 过期或无效时，退回全量请求重试一次
    if (chainHitKey && !result.ok && (result.error.status === 400 || result.error.status === 404)) {
      this.#responsesChain.delete(chainHitKey);
      chainHitKey = null;
      chainServed = false;
      this.#chainStats.fallbacks += 1;
      result = await runFailover({
        candidates,
        maxAttempts: input.maxAttempts ?? this.config.failover.maxAttempts,
        attempt: attemptWith({ ...input.body, store: true }),
        signal: input.signal,
        hooks: this.hooks(),
      });
    }

    if (chainEnabled && result.ok && chainItems) {
      const scope = chainScope(
        (input.caller ?? ANONYMOUS_CALLER).id,
        result.provider ?? this.providerIdFor(result.model) ?? this.config.defaultProvider,
        result.model,
        input.body.tools ?? null,
      );
      const hashes = itemsPrefixHashes(scope, chainItems);
      const key = hashes[hashes.length - 1];
      if (key) {
        const ttl = chaining.ttlMinutes * 60_000;
        const max = chaining.maxSessions;
        const response = captureResponseId(result.response, (id) => {
          this.#responsesChain.remember(key, id, ttl, max);
        });
        result = { ...result, response };
      }
    }

    // 链式请求的上游 prompt 只是增量，不能用它校准「全量输入」的估算
    if (result.ok) {
      this.#lastOutput = {
        model: result.model,
        provider: result.provider ?? this.providerIdFor(result.model) ?? null,
        api,
        requested: input.model?.trim() || "auto",
        mode: route.mode,
        at: new Date().toISOString(),
      };
    }

    return { result, sample: chainServed ? null : sample };
  }

  /** Responses 会话续接的命中情况，用于在 /api/overview 里观测省钱效果。 */
  chainStats(): { enabled: boolean; requests: number; hits: number; fallbacks: number; sessions: number } {
    return {
      enabled: this.config.responsesChaining.enabled,
      requests: this.#chainStats.requests,
      hits: this.#chainStats.hits,
      fallbacks: this.#chainStats.fallbacks,
      sessions: this.#responsesChain.size,
    };
  }

  recordOutcome(result: FailoverResult, caller: CallerIdentity = ANONYMOUS_CALLER, api: ApiKind = "chat"): void {
    this.store.bumpRequests(api);
    this.store.recordCallerRequest(caller, {
      ok: result.ok,
      failovers: result.failovers,
      model: result.ok ? result.model : null,
      api,
    });
    for (const attempt of result.attempts) {
      if (!attempt.ok) this.store.markFailure(attempt.model);
    }

    if (result.ok) {
      if (result.failovers > 0) {
        this.store.bumpFailovers(result.failovers);
        const from = result.attempts.find((attempt) => !attempt.ok);
        this.events.push({
          kind: "failover",
          level: "warn",
          message: from
            ? `${from.model}（${FAILURE_LABELS[from.kind ?? "unknown"]}）→ ${result.model}（切换 ${result.failovers} 次）`
            : `已切换到 ${result.model}`,
          model: result.model,
          detail: { attempts: summarizeAttempts(result.attempts) },
        });
        this.logger.info("failover succeeded", { model: result.model, failovers: result.failovers });
      }
      return;
    }

    this.store.bumpFailovers(result.failovers);
    this.events.push({
      kind: "error",
      level: "error",
      message: result.exhausted
        ? "模型列表没有可用的模型"
        : `${result.error.label}：${result.error.message}`,
      detail: { attempts: summarizeAttempts(result.attempts), kind: result.error.kind, code: result.error.code },
    });
    this.logger.warn(`请求失败：${result.error.label}`, {
      attempts: result.attempts.length,
      status: result.error.status ?? undefined,
    });
  }

  markSuccess(
    model: string,
    usage: Usage | null,
    caller: CallerIdentity = ANONYMOUS_CALLER,
    sample: CalibrationSample | null = null,
    api: ApiKind = "chat",
  ): void {
    const tier = usage ? priceTierAt(this.config.pricing, model, new Date()) : null;
    const cost = usage && tier ? usageCost(usage, tier, this.config.pricing.unit) : 0;
    this.store.markUsed(model, usage, cost, api);
    this.store.addCallerUsage(caller, usage, model, cost, api);
    if (usage && sample) {
      this.store.observeCalibration(model, sample.hasTools, sample.estimatedPromptTokens, usage.promptTokens);
    }
  }

  async refreshCatalog(target?: string): Promise<{ ok: boolean; count: number; message: string | null }> {
    const targets = target
      ? this.config.providers.filter((provider) => provider.id === target)
      : this.config.providers;
    if (targets.length === 0) {
      return { ok: false, count: 0, message: `提供商不存在：${target ?? ""}` };
    }

    const usable = targets.filter((provider) => keyInfoFor(provider).configured);
    if (usable.length === 0) {
      const message = targets.map((provider) => `${provider.id} 未配置 API Key`).join("；");
      return { ok: false, count: 0, message };
    }

    const entries: Array<{ id: string; provider: string }> = [];
    const errors: string[] = [];
    for (const provider of usable) {
      const result = await this.client.listModels(provider.id);
      if (!result.ok) {
        errors.push(`${provider.id}: ${result.message}`);
        continue;
      }
      for (const id of result.ids) entries.push({ id, provider: provider.id });
    }

    if (entries.length === 0) {
      this.#catalogError = errors.join("；") || "模型目录为空";
      this.events.push({ kind: "catalog", level: "warn", message: `模型目录刷新失败：${this.#catalogError}` });
      return { ok: false, count: 0, message: this.#catalogError };
    }

    this.store.setCatalog(entries);
    this.store.ensure(this.chainCodes());
    this.store.pruneModels(this.chainCodes());
    this.#catalogError = errors.length > 0 ? errors.join("；") : null;
    const summary =
      errors.length > 0
        ? `模型目录已更新，共 ${entries.length} 个模型（部分提供商失败：${errors.join("；")}）`
        : `模型目录已更新，共 ${entries.length} 个模型（${usable.length} 个提供商）`;
    this.events.push({ kind: "catalog", level: errors.length > 0 ? "warn" : "info", message: summary });
    return { ok: true, count: entries.length, message: errors.length > 0 ? errors.join("；") : null };
  }

  async test(prompt: string): Promise<TestResult> {
    if (!this.primaryModel()) {
      return {
        ok: false,
        model: null,
        content: null,
        latencyMs: 0,
        usage: null,
        attempts: [],
        message: "模型列表里还没有模型",
      };
    }

    const { result, sample } = await this.requestThrough({
      path: "chat/completions",
      model: "auto",
      body: {
        messages: [{ role: "user", content: prompt }],
        stream: false,
        max_tokens: 512,
      },
    });
    this.recordOutcome(result, CONSOLE_CALLER);

    if (!result.ok) {
      return {
        ok: false,
        model: null,
        content: null,
        latencyMs: Math.round(result.latencyMs),
        usage: null,
        attempts: result.attempts,
        message: `${result.error.label}：${result.error.message}`,
      };
    }

    const data: unknown = await result.response.json().catch(() => null);
    const usage = extractUsage(data);
    this.markSuccess(result.model, usage, CONSOLE_CALLER, sample);

    return {
      ok: true,
      model: result.model,
      content: extractContent(data),
      latencyMs: Math.round(result.latencyMs),
      usage,
      attempts: result.attempts,
      message: null,
    };
  }

  async updateChainModels(models: string[]): Promise<void> {
    const chain = this.config.chain;
    const next: string[] = [];
    for (const raw of models) {
      const code = this.normalizeModelCode(raw);
      if (!code) {
        throw new ConfigRuleError(`模型 ${raw} 没有指定提供商，请写成「提供商/模型名」`);
      }
      if (!next.includes(code)) next.push(code);
    }
    const previous = chain.models;
    const added = next.filter((code) => !previous.includes(code));
    const removed = previous.filter((code) => !next.includes(code));
    chain.models = next;
    this.store.ensure(next);
    this.store.pruneModels(next);
    await saveConfig(this.configPath, this.config);
    const message =
      added.length > 0 && removed.length === 0
        ? `模型列表已加入 ${added.join(", ")}`
        : removed.length > 0 && added.length === 0
          ? `模型列表已移除 ${removed.join(", ")}`
          : added.length > 0 || removed.length > 0
            ? `模型列表已更新（加入 ${added.length} 个，移除 ${removed.length} 个）`
            : "模型列表顺序已更新";
    this.events.push({ kind: "config", level: "info", message });
  }

  async updateChainContext(patch: Partial<ContextConfig>): Promise<ContextConfig> {
    const chain = this.config.chain;
    chain.context = this.#normalizeContext(patch, chain.context);
    await this.#persistConfig(`上下文窗口已更新为 ${chain.context.window}`);
    return chain.context;
  }

  async updateModelApis(code: string, apis: ApiKind[]): Promise<void> {
    const model = this.normalizeModelCode(code);
    if (!model) throw new ConfigRuleError(`模型 ${code} 没有指定提供商，请写成「提供商/模型名」`);
    this.config.modelApis[model] = [...apis];
    await saveConfig(this.configPath, this.config);
    this.events.push({
      kind: "config",
      level: "info",
      message: `${model} 的 API 能力已更新为 ${apis.join(" / ")}`,
      model,
      detail: { apis },
    });
  }

  #normalizeContext(patch: Partial<ContextConfig> | undefined, fallback: ContextConfig): ContextConfig {
    if (!patch) return { ...fallback };
    const window = patch.window === undefined ? fallback.window : Number(patch.window);
    if (!Number.isFinite(window) || window < 1_000 || window > 10_000_000) {
      throw new ConfigRuleError("context.window 必须是 1000 到 10000000 之间的数字");
    }
    const onOverflow = patch.onOverflow ?? fallback.onOverflow;
    if (onOverflow !== "reject" && onOverflow !== "passthrough") {
      throw new ConfigRuleError("context.onOverflow 只能是 reject / passthrough");
    }
    return { window: Math.round(window), onOverflow };
  }

  async #persistConfig(message: string, warnings: string[] = []): Promise<void> {
    await saveConfig(this.configPath, this.config);
    this.events.push({ kind: "config", level: "info", message });
    for (const warning of warnings) this.logger.info("config", { warning });
  }

  async applyConfig(next: GatewayConfig, options: { persist?: boolean } = {}): Promise<string[]> {
    const previousPort = this.config.port;
    const previousHost = this.config.host;
    this.config = next;
    if (!process.env.SWITCHYARD_LOG_LEVEL) this.logger.setLevel(next.log.level);
    this.logger.setRotation(next.log.maxBytes, next.log.maxFiles);
    if (options.persist !== false) await saveConfig(this.configPath, next);
    this.store.ensure(this.chainCodes());
    this.store.pruneModels(this.chainCodes());
    this.events.push({
      kind: "config",
      level: "info",
      message: options.persist === false ? "配置已从文件重新加载" : "配置已保存",
    });
    const warnings: string[] = [];
    if (previousPort !== next.port) warnings.push("端口变更需要重启进程后生效");
    if (previousHost !== next.host) warnings.push("监听地址变更需要重启进程后生效");
    return warnings;
  }

  resetUsage(): void {
    this.store.resetUsage();
    this.events.push({ kind: "config", level: "info", message: "用量统计已重置" });
  }

  /** 用指定时刻命中的价格档重算已有 token 的成本（历史数据没有逐请求时间）。 */
  backfillCosts(at: Date): void {
    this.store.recomputeCosts((model, usage) => {
      if (!model) return 0;
      const tier = priceTierAt(this.config.pricing, model, at);
      return tier ? usageCost(usage, tier, this.config.pricing.unit) : 0;
    });
    this.events.push({
      kind: "config",
      level: "info",
      message: `成本已按 ${at.toLocaleString("zh-CN")} 的单价重算`,
    });
  }

  revive(code: string): void {
    this.store.setHealth(code, "unknown", {
      reason: null,
      lastErrorCode: null,
      lastStatusCode: null,
      lastErrorMessage: null,
      throttledUntil: null,
      checkedAt: null,
    });
    this.events.push({ kind: "revive", level: "info", message: `${code} 已重置为待检测`, model: code });
  }

  async bootstrap(): Promise<void> {
    this.events.push({
      kind: "start",
      level: "info",
      message: `Switchyard 已启动，${this.chainCodes().length} 个模型 / ${this.config.providers.length} 个提供商 · 当前 ${this.primaryModel() ?? "未选择"}`,
      detail: { providers: this.config.providers.map((provider) => provider.id) },
    });

    const infos = this.providerKeyInfos();
    const ready = infos.filter((item) => item.configured);
    if (ready.length === 0) {
      this.logger.info("所有提供商都未配置 API Key，/v1 请求会返回 503 switchyard.no_key", {
        providers: infos.map((item) => item.id).join(", "),
        hint: ".env / config.json 的 providers[].apiKey",
      });
      return;
    }
    const missing = infos.filter((item) => !item.configured);
    if (missing.length > 0) {
      this.logger.warn("部分提供商没有 Key，路由到它们的请求会返回 503", {
        missing: missing.map((item) => item.id).join(", "),
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([this.store.flush(), this.events.flush()]);
  }
}

function isChatPath(path: string): boolean {
  return path === "chat/completions" || path === "completions" || path === "responses";
}

function collectCodes(config: GatewayConfig, extra: string[]): string[] {
  const codes = new Set<string>(extra);
  for (const code of config.chain.models) codes.add(code);
  return [...codes];
}

/**
 * 旧状态文件里的裸模型名 → 新的 `提供商/模型名`。只有在上游模型名唯一时才能无歧义迁移，
 * 同名模型挂在两个提供商下时保持原样，避免把用量记到错误的模型上。
 */
function collectModelAliases(config: GatewayConfig): Map<string, string> {
  const byUpstream = new Map<string, string[]>();
  for (const code of config.chain.models) {
    const parsed = splitModelCode(code, config.providers);
    if (!parsed) continue;
    const list = byUpstream.get(parsed.upstream) ?? [];
    list.push(code);
    byUpstream.set(parsed.upstream, list);
  }
  const aliases = new Map<string, string>();
  for (const [upstream, codes] of byUpstream) {
    if (codes.length === 1 && codes[0]) aliases.set(upstream, codes[0]);
  }
  return aliases;
}

function summarizeAttempts(attempts: AttemptRecord[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    model: attempt.model,
    ok: attempt.ok,
    kind: attempt.kind,
    status: attempt.status,
    code: attempt.code,
    latencyMs: attempt.latencyMs,
  }));
}

function extractContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const choices = (data as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  const message = record.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  if (typeof record.text === "string") return record.text;
  return null;
}
