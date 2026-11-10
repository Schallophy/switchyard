import type { ServerResponse } from "node:http";
import type { Usage } from "../types.ts";
import { SseUsageTracker } from "../util/usage.ts";

export interface PipeOptions {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface PipeResult {
  usage: Usage | null;
  bytes: number;
  error: string | null;
}

export async function pipeSse(res: ServerResponse, provider: Response, options: PipeOptions = {}): Promise<PipeResult> {
  const tracker = new SseUsageTracker();
  const reader = provider.body?.getReader();
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) res.setHeader(key, value);
  }
  res.flushHeaders();

  if (!reader) {
    res.end();
    return { usage: null, bytes: 0, error: null };
  }

  const decoder = new TextDecoder();
  let idleTimer: NodeJS.Timeout | null = null;
  let error: string | null = null;
  let bytes = 0;

  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => cancel();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(cancel, idleTimeoutMs);
    idleTimer.unref();
  };
  resetIdle();

  try {
    for (;;) {
      if (res.destroyed) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      bytes += value.byteLength;
      tracker.push(decoder.decode(value, { stream: true }));
      await writeChunk(res, Buffer.from(value));
      resetIdle();
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!res.writableEnded) res.end();
  }

  return { usage: tracker.usage, bytes, error };
}

function writeChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  const flushed = res.write(chunk);
  if (flushed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}
