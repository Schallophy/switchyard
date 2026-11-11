import { identifyCaller } from "../core/caller.ts";
import { apiKindForPath } from "../core/api.ts";
import { extractOutputText, extractToolCalls } from "../core/output-text.ts";
import type { ApiKind } from "../config/schema.ts";
import type { Runtime } from "../runtime.ts";
import type { AttemptRecord, NormalizedError } from "../types.ts";
import { extractUsage } from "../util/usage.ts";
import { HttpError, type Ctx, type Router } from "./server.ts";
import { pipeSse } from "./sse.ts";

export function registerOpenAIRoutes(router: Router, runtime: Runtime): void {
  router.add("GET", "/v1/models", (ctx) => {
    const created = Math.floor(Date.now() / 1000);
    const chain = runtime.config.chain;
    const primary = runtime.primaryModel();
    const apisOf = (models: string[]): string[] => [...new Set(models.flatMap((code) => runtime.apisFor(code)))];
    const data: Array<Record<string, unknown>> = [
      {
        id: "auto",
        object: "model",
        created,
        owned_by: "switchyard",
        description: primary ? "从列表第一个模型开始，失败时按优先级回退" : "模型列表为空",
        context_length: chain.context.window,
        apis: apisOf(chain.models),
        provider: primary ? runtime.providerIdFor(primary) : runtime.config.defaultProvider,
        active: primary,
      },
    ];

    for (const code of runtime.chainCodes()) {
      const record = runtime.store.get(code);
      if (!record || record.health === "dead" || record.health === "invalid") continue;
      data.push({
        id: code,
        object: "model",
        created,
        owned_by: "switchyard",
        context_length: chain.context.window,
        apis: runtime.apisFor(code),
        provider: runtime.providerIdFor(code),
        upstream: runtime.upstreamModelFor(code),
        active: code === primary,
      });
    }

    ctx.send(200, { object: "list", data });
  });

  router.add("POST", "/v1/chat/completions", (ctx) => proxy(ctx, runtime, "chat/completions"));
  router.add("POST", "/v1/completions", (ctx) => proxy(ctx, runtime, "completions"));
  router.add("POST", "/v1/responses", (ctx) => proxy(ctx, runtime, "responses"));
  router.add("POST", "/v1/embeddings", (ctx) => proxy(ctx, runtime, "embeddings"));
}

function proxy(ctx: Ctx, runtime: Runtime, path: string): Promise<void> {
  const started = performance.now();
  const payload = ctx.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }

  const api = apiKindForPath(path);
  const body = payload as Record<string, unknown>;
  const requested = typeof body.model === "string" ? body.model : "auto";
  const stream = body.stream === true;
  const caller = identifyCaller(ctx.req.headers);

  const forward: Record<string, unknown> = { ...body };
  delete forward.model;
  if (
    stream &&
    path === "chat/completions" &&
    runtime.providerFor(requested)?.injectStreamUsage === true &&
    forward.stream_options === undefined
  ) {
    forward.stream_options = { include_usage: true };
  }

  const controller = new AbortController();
  const abort = (): void => {
    if (!ctx.res.writableEnded) controller.abort();
  };
  ctx.res.on("close", abort);

  return runtime
    .requestThrough({ path, model: requested, body: forward, signal: controller.signal, caller })
    .then(async ({ result, sample }) => {
      runtime.recordOutcome(result, caller, api);

      if (!result.ok) {
        const lastAttempt = result.attempts[result.attempts.length - 1];
        const failedModel = lastAttempt?.model ?? requested;
        runtime.liveOutput
          .start({
            api,
            model: failedModel,
            provider: runtime.providerIdFor(failedModel) ?? null,
            caller: caller.label,
            requested,
            stream,
            failovers: result.failovers,
          })
          .finish({
            error: `${result.error.label}：${result.error.message}`,
            latencyMs: Math.round(performance.now() - started),
          });

        ctx.res.off("close", abort);
        if (result.error.kind === "aborted") {
          ctx.res.destroy();
          return;
        }
        const status = errorStatus(result.error);
        const headers: Record<string, string> = {};
        if (status === 429) headers["retry-after"] = "5";
        if (status === 503) headers["retry-after"] = "30";
        ctx.send(
          status,
          {
            error: {
              message: result.error.message || result.error.label,
              type: `switchyard.${result.error.kind}`,
              code: result.error.code ?? `switchyard.${result.error.kind}`,
              param: null,
              attempts: summarize(result.attempts),
            },
          },
          headers,
        );
        return;
      }

      if (!stream) {
        const text = await result.response.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
        const usage = extractUsage(parsed);
        const finishReason = extractFinishReason(api, parsed);
        runtime.markSuccess(result.model, usage, caller, sample, api);
        runtime.liveOutput
          .start({
            api,
            model: result.model,
            provider: result.provider ?? runtime.providerIdFor(result.model) ?? null,
            caller: caller.label,
            requested,
            stream: false,
            failovers: result.failovers,
          })
          .finish({
            text: extractOutputText(api, parsed),
            toolCalls: extractToolCalls(api, parsed),
            finishReason,
            raw: text,
            usage,
            bytes: Buffer.byteLength(text),
            latencyMs: Math.round(performance.now() - started),
          });
        ctx.res.off("close", abort);
        ctx.sendRaw(200, text, {
          "content-type": "application/json; charset=utf-8",
          "x-switchyard-model": result.model,
          "x-switchyard-provider": result.provider ?? "",
          "x-switchyard-failovers": String(result.failovers),
        });
        return;
      }

      const live = runtime.liveOutput.start({
        api,
        model: result.model,
        provider: result.provider ?? runtime.providerIdFor(result.model) ?? null,
        caller: caller.label,
        requested,
        stream: true,
        failovers: result.failovers,
      });

      const piped = await pipeSse(ctx.res, result.response, {
        idleTimeoutMs: 120_000,
        signal: controller.signal,
        headers: {
          "x-switchyard-model": result.model,
          "x-switchyard-provider": result.provider ?? "",
          "x-switchyard-failovers": String(result.failovers),
        },
        onData: (chunk) => live.push(chunk),
      });
      runtime.markSuccess(result.model, piped.usage, caller, sample, api);
      live.finish({
        usage: piped.usage,
        bytes: piped.bytes,
        latencyMs: Math.round(performance.now() - started),
        error: piped.error,
      });
      ctx.res.off("close", abort);
      if (piped.error) {
        runtime.logger.warn("stream interrupted", { model: result.model, error: piped.error });
      }
    })
    .catch((error: unknown) => {
      ctx.res.off("close", abort);
      throw error;
    });
}

function errorStatus(error: NormalizedError): number {
  switch (error.kind) {
    case "auth":
      // 网关自己没配提供商 Key 不是客户端的认证失败，用 503 更准确
      return error.code === "switchyard.no_key" ? 503 : 401;
    case "bad_request":
      return 400;
    case "context":
      return 400;
    case "forbidden":
      return 403;
    case "throttled":
      return 429;
    case "provider":
      return 502;
    case "exhausted":
      return 503;
    case "aborted":
      return 499;
    default:
      return 503;
  }
}

/** 从非流式完整响应里提取完成原因，用于「输出」页展示。 */
function extractFinishReason(api: ApiKind, parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  if (api === "chat" || api === "completions") {
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first = choices[0];
    if (first && typeof first === "object") {
      const fr = (first as Record<string, unknown>).finish_reason;
      if (typeof fr === "string" && fr) return fr;
    }
    return null;
  }

  if (api === "responses") {
    const output = Array.isArray(record.output) ? record.output : [];
    const first = output[0];
    if (first && typeof first === "object") {
      const st = (first as Record<string, unknown>).status;
      if (typeof st === "string" && st) return st;
    }
    const st = record.status;
    if (typeof st === "string" && st) return st;
    return null;
  }

  return null;
}

function summarize(attempts: AttemptRecord[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    model: attempt.model,
    ok: attempt.ok,
    kind: attempt.kind,
    status: attempt.status,
    code: attempt.code,
    latencyMs: attempt.latencyMs,
  }));
}
