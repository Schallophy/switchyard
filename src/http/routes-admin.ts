import { parseConfigText } from "../config/load.ts";
import { isApiKind, normalizeConfig, type ApiKind, type ContextConfig, type GatewayConfig } from "../config/schema.ts";
import { capabilitySnapshot, capabilitySourceUrl, matchCapability } from "../core/capability.ts";
import type { EventKind } from "../core/events.ts";
import { ConfigRuleError, type Runtime } from "../runtime.ts";
import { HttpError, type Ctx, type Router } from "./server.ts";

const VERSION = "0.1.0";
const EVENT_KINDS: EventKind[] = ["start", "failover", "dead", "throttle", "revive", "catalog", "config", "error"];

export function registerAdminRoutes(router: Router, runtime: Runtime): void {
  router.add("GET", "/health", (ctx) => {
    const chain = runtime.chainSnapshot();
    const keys = runtime.providerKeyInfos();
    ctx.send(
      200,
      {
        status: "ok",
        version: VERSION,
        uptimeSeconds: uptimeSeconds(runtime),
        bootedAt: runtime.bootedAt.toISOString(),
        model: runtime.activeModel(),
        models: { total: chain.models.length, alive: chain.alive, dead: chain.dead },
        providers: { total: keys.length, configured: keys.filter((item) => item.configured).length },
      },
      { "cache-control": "no-store" },
    );
  });

  router.add("GET", "/api/overview", (ctx) => {
    ctx.send(200, buildOverview(runtime));
  });

  router.add("GET", "/api/capability", async (ctx) => {
    const refresh = ctx.url.searchParams.get("refresh") === "1";
    const snapshot = await capabilitySnapshot({ refresh });
    const tracked = new Set(runtime.chainCodes());
    const models = runtime.store.catalog.models.map((entry) => {
      const match = matchCapability(snapshot.index, entry.upstream);
      const record = runtime.store.get(entry.code);
      return {
        code: entry.code,
        upstream: entry.upstream,
        family: entry.family,
        provider: entry.provider || runtime.providerIdFor(entry.code),
        tracked: tracked.has(entry.code),
        health: record?.health ?? null,
        score: match?.model.score ?? null,
        matchedSlug: match?.model.slug ?? null,
        matchedName: match?.model.name ?? null,
        reasoning: match?.model.reasoning ?? null,
        contextWindow: match?.model.contextWindow ?? null,
      };
    });

    models.sort(
      (a, b) =>
        (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) ||
        a.code.localeCompare(b.code),
    );

    ctx.send(
      200,
      {
        ok: snapshot.error === null,
        error: snapshot.error,
        source: {
          name: "Artificial Analysis",
          url: capabilitySourceUrl,
          fetchedAt: snapshot.fetchedAt,
          cached: snapshot.cached,
          total: snapshot.total,
          scored: snapshot.scored,
          matched: models.filter((model) => model.score !== null).length,
        },
        models,
      },
      { "cache-control": "no-store" },
    );
  });

  router.add("GET", "/api/events", (ctx) => {
    const limit = Number(ctx.url.searchParams.get("limit") ?? "200");
    const kindParam = ctx.url.searchParams.get("kind");
    const kind = kindParam && isEventKind(kindParam) ? kindParam : undefined;
    const safeLimit = Number.isFinite(limit) ? Math.min(400, Math.max(1, Math.trunc(limit))) : 200;
    ctx.send(200, { events: runtime.events.recent(safeLimit, kind) });
  });

  router.add("GET", "/api/live", (ctx) => streamLiveOutput(ctx, runtime));

  router.add("DELETE", "/api/live", (ctx) => {
    runtime.liveOutput.clear();
    ctx.send(200, { ok: true });
  });

  router.add("GET", "/api/live/:id/raw", (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "无效的输出编号");
    const raw = runtime.liveOutput.raw(id);
    if (!raw) throw new HttpError(404, "找不到该输出");
    ctx.send(200, { raw: raw.raw, truncated: raw.truncated });
  });

  router.add("GET", "/api/config", (ctx) => {
    ctx.send(200, {
      text: sanitizedConfigText(runtime),
      config: sanitizedConfig(runtime),
      apiKeySet: Boolean(runtime.keyInfo().configured),
      keys: runtime.providerKeyInfos(),
      key: runtime.keyInfo(),
      configPath: runtime.configPath,
      dataDir: runtime.dataDir,
    });
  });

  router.add("PUT", "/api/config", async (ctx) => {
    const body = asObject(ctx);

    let parsed: unknown;
    if (typeof body.text === "string") {
      try {
        parsed = parseConfigText(body.text);
      } catch (error) {
        ctx.send(400, {
          error: { message: (error as Error).message, type: "switchyard.config", code: "switchyard.config" },
          errors: [(error as Error).message],
        });
        return;
      }
    } else if (body.config !== undefined) {
      if (!isPlainObject(body.config)) throw new HttpError(400, "config 必须是 JSON 对象");
      parsed = mergeConfig(sanitizedConfig(runtime), body.config);
    } else {
      throw new HttpError(400, "需要提供 config（对象）或 text（字符串）");
    }

    const normalized = normalizeConfig(parsed);
    if (!normalized.ok) {
      ctx.send(400, {
        error: { message: "配置校验失败", type: "switchyard.config", code: "switchyard.config" },
        errors: normalized.errors,
      });
      return;
    }

    // 表单不回显 Key：留空的表示沿用原值，按提供商 id 逐个保留
    for (const provider of normalized.config.providers) {
      if (provider.apiKey) continue;
      const previous = runtime.config.providers.find((item) => item.id === provider.id);
      if (previous?.apiKey) provider.apiKey = previous.apiKey;
    }

    const warnings = await runtime.applyConfig(normalized.config);
    ctx.send(200, {
      ok: true,
      warnings: [...normalized.warnings, ...warnings],
      config: sanitizedConfig(runtime),
    });
  });

  router.add("PATCH", "/api/chain", async (ctx) => {
    const body = asObject(ctx);
    if (!isPlainObject(body.context)) throw new HttpError(400, "context 必须是对象");
    const context: Partial<ContextConfig> = {};
    if (body.context.window !== undefined) context.window = Number(body.context.window);
    if (typeof body.context.onOverflow === "string") {
      context.onOverflow = body.context.onOverflow as ContextConfig["onOverflow"];
    }
    const next = await guarded(ctx, () => runtime.updateChainContext(context));
    if (!next) return;
    ctx.send(200, { ok: true, context: next });
  });

  router.add("POST", "/api/chain/active", async (ctx) => {
    const body = asObject(ctx);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) throw new HttpError(400, "model 不能为空");
    const done = await guarded(ctx, async () => {
      await runtime.setActiveModel(model);
      return true;
    });
    if (!done) return;
    ctx.send(200, { ok: true, active: runtime.activeModel() });
  });

  router.add("POST", "/api/usage/reset", (ctx) => {
    runtime.resetUsage();
    ctx.send(200, { ok: true, stats: runtime.store.stats });
  });

  router.add("POST", "/api/usage/backfill-cost", (ctx) => {
    const body = asObject(ctx);
    const at = typeof body.at === "string" ? new Date(body.at) : new Date();
    if (Number.isNaN(at.getTime())) throw new HttpError(400, "at 必须是合法的 ISO 时间");
    runtime.backfillCosts(at);
    ctx.send(200, { ok: true, at: at.toISOString(), stats: runtime.store.stats });
  });

  router.add("POST", "/api/models/:code/revive", (ctx) => {
    const code = ctx.params.code ?? "";
    if (!runtime.store.get(code)) {
      ctx.send(404, { error: { message: `未知模型：${code}`, type: "switchyard.not_found", code: "switchyard.not_found" } });
      return;
    }
    runtime.revive(code);
    ctx.send(200, { ok: true, model: runtime.snapshotModel(code) });
  });

  router.add("POST", "/api/models/:code/apis", async (ctx) => {
    const code = (ctx.params.code ?? "").trim();
    if (!code) throw new HttpError(400, "缺少模型 code");
    const body = asObject(ctx);
    if (!Array.isArray(body.apis)) throw new HttpError(400, "apis 必须是数组");

    const apis: ApiKind[] = [];
    for (const entry of body.apis) {
      if (typeof entry !== "string" || !isApiKind(entry)) {
        throw new HttpError(400, `未知 API：${String(entry)}`);
      }
      if (!apis.includes(entry)) apis.push(entry);
    }
    if (apis.length === 0) throw new HttpError(400, "至少需要一个 API");

    await runtime.updateModelApis(code, apis);
    ctx.send(200, { ok: true, code, apis: runtime.apisFor(code) });
  });

  router.add("POST", "/api/chain/order", async (ctx) => {
    const body = asObject(ctx);
    const list = Array.isArray(body.models) ? body.models : [];
    const models = unique(list.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()));
    if (models.length === 0) throw new HttpError(400, "models 必须是非空数组");
    const done = await guarded(ctx, () => runtime.updateChainModels(models));
    if (done === null) return;
    ctx.send(200, { ok: true, chain: { active: runtime.activeModel(), models: runtime.chainCodes() } });
  });

  router.add("POST", "/api/chain/models", async (ctx) => {
    const body = asObject(ctx);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) throw new HttpError(400, "code 不能为空");
    const models = runtime.chainCodes();
    if (!models.includes(code)) models.push(code);
    const done = await guarded(ctx, () => runtime.updateChainModels(models));
    if (done === null) return;
    ctx.send(200, { ok: true, chain: { active: runtime.activeModel(), models: runtime.chainCodes() } });
  });

  router.add("POST", "/api/chain/models/remove", async (ctx) => {
    const body = asObject(ctx);
    const list = Array.isArray(body.models) ? body.models : [];
    const remove = new Set(
      list.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean),
    );
    if (remove.size === 0) throw new HttpError(400, "models 必须是非空数组");
    const current = runtime.chainCodes();
    const next = current.filter((code) => !remove.has(code));
    if (next.length === current.length) {
      ctx.send(200, { ok: true, removed: 0, chain: { active: runtime.activeModel(), models: current } });
      return;
    }
    await runtime.updateChainModels(next);
    ctx.send(200, {
      ok: true,
      removed: current.length - next.length,
      chain: { active: runtime.activeModel(), models: next },
    });
  });

  router.add("DELETE", "/api/chain/models/:code", async (ctx) => {
    const code = ctx.params.code ?? "";
    const models = runtime.chainCodes();
    const next = models.filter((item) => item !== code);
    if (next.length === models.length) {
      ctx.send(404, { error: { message: `模型列表中没有 ${code}`, type: "switchyard.not_found", code: "switchyard.not_found" } });
      return;
    }
    await runtime.updateChainModels(next);
    ctx.send(200, { ok: true, chain: { active: runtime.activeModel(), models: next } });
  });

  router.add("POST", "/api/catalog/refresh", async (ctx) => {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const provider = typeof body.provider === "string" ? body.provider.trim() : undefined;
    const result = await runtime.refreshCatalog(provider);
    if (!result.ok) {
      ctx.send(502, {
        error: { message: result.message ?? "模型目录刷新失败", type: "switchyard.catalog", code: "switchyard.catalog" },
      });
      return;
    }
    ctx.send(200, { ok: true, count: result.count, warnings: result.message ? [result.message] : [] });
  });

  router.add("POST", "/api/test", async (ctx) => {
    const body = asObject(ctx);
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "你好，请回复一句话。";
    const result = await runtime.test(prompt);
    ctx.send(200, result);
  });
}

function streamLiveOutput(ctx: Ctx, runtime: Runtime): Promise<void> {
  const { res } = ctx;
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();

  let closed = false;
  const send = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // 客户端断开时 write 可能抛错，交给 close 事件清理。
    }
  };

  send("snapshot", {
    sessions: runtime.liveOutput.recent(),
    limits: runtime.liveOutput.limits(),
  });
  const unsubscribe = runtime.liveOutput.subscribe((event) => send(event.type, event));
  const ping = setInterval(() => {
    if (closed || res.writableEnded) return;
    try {
      res.write(": ping\n\n");
    } catch {
      // 同上。
    }
  }, 15_000);
  ping.unref();

  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      resolve();
    };
    res.once("close", cleanup);
    res.once("error", cleanup);
    ctx.req.once("aborted", cleanup);
  });
}

function buildOverview(runtime: Runtime): Record<string, unknown> {
  const tracked = new Set(runtime.chainCodes());
  const catalog = runtime.store.catalog.models.map((entry) => {
    const record = runtime.store.get(entry.code);
    return {
      code: entry.code,
      upstream: entry.upstream,
      family: entry.family,
      tracked: tracked.has(entry.code),
      health: record?.health ?? null,
      lastStatusCode: record?.lastStatusCode ?? null,
      lastErrorCode: record?.lastErrorCode ?? null,
      apis: runtime.apisFor(entry.code),
      provider: entry.provider || runtime.providerIdFor(entry.code),
    };
  });

  return {
    app: {
      name: "Switchyard",
      version: VERSION,
      now: new Date().toISOString(),
      bootedAt: runtime.bootedAt.toISOString(),
      uptimeSeconds: uptimeSeconds(runtime),
      host: runtime.config.host,
      port: runtime.config.port,
      endpoint: `http://${runtime.config.host === "0.0.0.0" ? "127.0.0.1" : runtime.config.host}:${runtime.config.port}/v1`,
      configPath: runtime.configPath,
      dataDir: runtime.dataDir,
    },
    key: runtime.keyInfo(),
    providers: runtime.config.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      requestTimeoutMs: provider.requestTimeoutMs,
      injectStreamUsage: provider.injectStreamUsage,
    })),
    defaultProvider: runtime.config.defaultProvider,
    pricing: {
      currency: runtime.config.pricing.currency,
      unit: runtime.config.pricing.unit,
    },
    keys: runtime.providerKeyInfos(),
    ui: runtime.config.ui,
    server: runtime.config.server,
    log: runtime.config.log,
    stats: runtime.store.stats,
    chaining: runtime.chainStats(),
    callers: [...runtime.store.callers()].sort(
      (a, b) =>
        b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens) ||
        b.requests - a.requests ||
        a.label.localeCompare(b.label),
    ),
    chain: runtime.chainSnapshot(),
    output: runtime.lastOutput(),
    activeModel: runtime.activeModel(),
    catalog: { fetchedAt: runtime.store.catalog.fetchedAt, models: catalog },
    events: runtime.events.recent(120),
    warnings: runtime.warnings,
  };
}

function sanitizedConfig(runtime: Runtime): GatewayConfig {
  const clone = JSON.parse(JSON.stringify(runtime.config)) as GatewayConfig;
  for (const provider of clone.providers) provider.apiKey = "";
  return clone;
}

function sanitizedConfigText(runtime: Runtime): string {
  return `${JSON.stringify(sanitizedConfig(runtime), null, 2)}\n`;
}

async function guarded<T>(ctx: Ctx, task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ConfigRuleError) {
      ctx.send(400, {
        error: { message: error.message, type: "switchyard.config", code: "switchyard.config" },
        errors: error.details,
      });
      return null;
    }
    throw error;
  }
}

function mergeConfig(base: GatewayConfig, patch: Record<string, unknown>): Record<string, unknown> {
  return deepMerge(base as unknown as Record<string, unknown>, patch);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(ctx: Ctx): Record<string, unknown> {
  const body = ctx.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求体必须是 JSON 对象");
  return body as Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as string[]).includes(value);
}

function uptimeSeconds(runtime: Runtime): number {
  return Math.round((Date.now() - runtime.bootedAt.getTime()) / 1000);
}
