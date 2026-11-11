import type { ApiKind } from "../config/schema.ts";
import type { Usage } from "../types.ts";
import { SseOutputExtractor, type OutputToolCall } from "./output-text.ts";

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_TEXT_CHARS = 32_000;
const DEFAULT_MAX_RAW_CHARS = 128_000;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_CALL_ARGS = 4_000;
const TRUNCATED_MARKER = "\n\n…（输出过长，已截断）";
const RAW_TRUNCATED_MARKER = "\n\n…（原始响应过长，已截断）";

export type LiveOutputStatus = "streaming" | "ok" | "error";

export interface LiveOutputSession {
  id: number;
  at: string;
  api: ApiKind;
  model: string;
  provider: string | null;
  caller: string;
  requested: string;
  stream: boolean;
  status: LiveOutputStatus;
  text: string;
  toolCalls: OutputToolCall[];
  finishReason: string | null;
  raw: string;
  rawTruncated: boolean;
  usage: Usage | null;
  bytes: number;
  latencyMs: number;
  failovers: number;
  error: string | null;
  truncated: boolean;
}

/** 对外暴露的快照：原始响应体不下发，只暴露长度与截断标记。 */
export type LiveOutputView = Omit<LiveOutputSession, "raw"> & { rawLength: number };

export interface LiveOutputStart {
  api: ApiKind;
  model: string;
  provider: string | null;
  caller: string;
  requested: string;
  stream: boolean;
  failovers?: number;
}

export interface LiveOutputFinish {
  text?: string | null;
  toolCalls?: OutputToolCall[] | null;
  finishReason?: string | null;
  raw?: string | null;
  usage?: Usage | null;
  bytes?: number;
  latencyMs?: number;
  failovers?: number;
  error?: string | null;
}

export interface LiveOutputLimits {
  sessions: number;
  textChars: number;
  rawChars: number;
}

export type LiveOutputEvent =
  | { type: "start"; session: LiveOutputView }
  | { type: "delta"; id: number; text: string }
  | { type: "done"; session: LiveOutputView }
  | { type: "clear" };

type Listener = (event: LiveOutputEvent) => void;

/**
 * 进程内的实时输出环形缓冲。只保存最近的会话和截断后的文本，
 * 不写 state.json / events.jsonl，进程重启即清空。
 */
export class LiveOutputLog {
  readonly #maxSessions: number;
  readonly #maxTextChars: number;
  readonly #maxRawChars: number;
  #sessions: LiveOutputSession[] = [];
  #nextId = 1;
  #listeners = new Set<Listener>();

  constructor(options: { maxSessions?: number; maxTextChars?: number; maxRawChars?: number } = {}) {
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.#maxTextChars = Math.max(8, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
    this.#maxRawChars = Math.max(1, options.maxRawChars ?? DEFAULT_MAX_RAW_CHARS);
  }

  start(input: LiveOutputStart): LiveOutputHandle {
    const session: LiveOutputSession = {
      id: this.#nextId,
      at: new Date().toISOString(),
      api: input.api,
      model: input.model,
      provider: input.provider,
      caller: input.caller,
      requested: input.requested,
      stream: input.stream,
      status: "streaming",
      text: "",
      toolCalls: [],
      finishReason: null,
      raw: "",
      rawTruncated: false,
      usage: null,
      bytes: 0,
      latencyMs: 0,
      failovers: input.failovers ?? 0,
      error: null,
      truncated: false,
    };
    this.#nextId += 1;
    this.#sessions.push(session);
    this.#trim();
    this.#emit({ type: "start", session: cloneSession(session) });
    return new LiveOutputHandle(this, session);
  }

  recent(limit = this.#maxSessions): LiveOutputView[] {
    const safe = Math.max(1, Math.min(this.#maxSessions, Math.trunc(limit) || this.#maxSessions));
    return this.#sessions.slice(-safe).map(cloneSession);
  }

  limits(): LiveOutputLimits {
    return { sessions: this.#maxSessions, textChars: this.#maxTextChars, rawChars: this.#maxRawChars };
  }

  clear(): void {
    this.#sessions = [];
    this.#emit({ type: "clear" });
  }

  /** @internal 由 LiveOutputHandle 调用。 */
  raw(id: number): { raw: string; truncated: boolean } | null {
    const session = this.#sessions.find((session) => session.id === id);
    if (!session) return null;
    return { raw: session.raw, truncated: session.rawTruncated };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** @internal 由 LiveOutputHandle 调用。 */
  append(session: LiveOutputSession, text: string): void {
    if (!text) return;
    if (session.truncated) return;

    const remaining = this.#maxTextChars - session.text.length;
    if (remaining <= 0) {
      session.truncated = true;
      session.text += TRUNCATED_MARKER;
      this.#emit({ type: "delta", id: session.id, text: TRUNCATED_MARKER });
      return;
    }

    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    session.text += slice;
    this.#emit({ type: "delta", id: session.id, text: slice });

    if (slice.length < text.length) {
      session.truncated = true;
      session.text += TRUNCATED_MARKER;
      this.#emit({ type: "delta", id: session.id, text: TRUNCATED_MARKER });
    }
  }

  /** @internal 由 LiveOutputHandle 调用：累积未经解析的上游原始文本。 */
  captureRaw(session: LiveOutputSession, chunk: string): void {
    if (!chunk || session.rawTruncated) return;

    const remaining = this.#maxRawChars - session.raw.length;
    if (remaining <= 0) {
      session.rawTruncated = true;
      session.raw += RAW_TRUNCATED_MARKER;
      return;
    }

    const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    session.raw += slice;

    if (slice.length < chunk.length) {
      session.rawTruncated = true;
      session.raw += RAW_TRUNCATED_MARKER;
    }
  }

  /** @internal 由 LiveOutputHandle 调用。 */
  complete(session: LiveOutputSession, patch: LiveOutputFinish): void {
    if (typeof patch.text === "string" && patch.text) {
      this.append(session, patch.text);
    }
    if (typeof patch.raw === "string" && patch.raw) {
      this.captureRaw(session, patch.raw);
    }

    session.status = patch.error ? "error" : "ok";
    session.toolCalls = trimToolCalls(patch.toolCalls ?? []);
    session.finishReason = patch.finishReason ?? null;
    session.usage = patch.usage ?? null;
    session.bytes = patch.bytes ?? session.bytes;
    session.latencyMs = patch.latencyMs ?? session.latencyMs;
    session.failovers = patch.failovers ?? session.failovers;
    session.error = patch.error ?? null;
    this.#emit({ type: "done", session: cloneSession(session) });
    this.#trim();
  }

  #trim(): void {
    while (this.#sessions.length > this.#maxSessions) {
      const index = this.#sessions.findIndex((session) => session.status !== "streaming");
      if (index < 0) return;
      this.#sessions.splice(index, 1);
    }
  }

  #emit(event: LiveOutputEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // 看板断线不应该影响网关本身。
      }
    }
  }
}

export class LiveOutputHandle {
  readonly id: number;
  readonly #log: LiveOutputLog;
  readonly #session: LiveOutputSession;
  readonly #extractor: SseOutputExtractor;
  #finished = false;

  constructor(log: LiveOutputLog, session: LiveOutputSession) {
    this.id = session.id;
    this.#log = log;
    this.#session = session;
    this.#extractor = new SseOutputExtractor(session.api);
  }

  /** 输入一段原始 SSE 文本；内部会解析成可见的增量，并原样缓存原始响应。 */
  push(chunk: string): void {
    if (this.#finished) return;
    this.#log.captureRaw(this.#session, chunk);
    const text = this.#extractor.push(chunk);
    if (text) this.#log.append(this.#session, text);
  }

  /** 流式响应结束后的完成原因，未报告则为 null。 */
  getFinishReason(): string | null {
    return this.#extractor.getFinishReason();
  }

  /** 流式响应结束后收集到的工具调用。 */
  getToolCalls(): OutputToolCall[] {
    return this.#extractor.getToolCalls();
  }

  finish(patch: LiveOutputFinish = {}): void {
    if (this.#finished) return;
    this.#finished = true;
    const tail = this.#extractor.flush();
    if (tail) this.#log.append(this.#session, tail);
    this.#log.complete(this.#session, {
      text: patch.text,
      toolCalls: patch.toolCalls ?? this.getToolCalls(),
      finishReason: patch.finishReason ?? this.getFinishReason(),
      raw: patch.raw,
      usage: patch.usage,
      bytes: patch.bytes,
      latencyMs: patch.latencyMs,
      failovers: patch.failovers,
      error: patch.error,
    });
  }
}

function cloneSession(session: LiveOutputSession): LiveOutputView {
  const { raw, ...rest } = session;
  return {
    ...rest,
    rawLength: raw.length,
    toolCalls: session.toolCalls.map((call) => ({ ...call })),
    usage: session.usage ? { ...session.usage } : null,
    finishReason: session.finishReason ?? null,
  };
}

/** 工具调用参数可能很大，快照里只保留前几个、每段截断，完整内容仍可看原始响应。 */
function trimToolCalls(calls: OutputToolCall[]): OutputToolCall[] {
  return calls.slice(0, MAX_TOOL_CALLS).map((call) => ({
    name: call.name,
    arguments:
      call.arguments.length > MAX_TOOL_CALL_ARGS
        ? `${call.arguments.slice(0, MAX_TOOL_CALL_ARGS)}…`
        : call.arguments,
  }));
}