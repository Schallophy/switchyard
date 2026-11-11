import type { ApiKind } from "../config/schema.ts";
import type { Usage } from "../types.ts";
import { SseOutputExtractor } from "./output-text.ts";

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_TEXT_CHARS = 32_000;
const TRUNCATED_MARKER = "\n\n…（输出过长，已截断）";

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
  usage: Usage | null;
  bytes: number;
  latencyMs: number;
  failovers: number;
  error: string | null;
  truncated: boolean;
}

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
  usage?: Usage | null;
  bytes?: number;
  latencyMs?: number;
  failovers?: number;
  error?: string | null;
}

export interface LiveOutputLimits {
  sessions: number;
  textChars: number;
}

export type LiveOutputEvent =
  | { type: "start"; session: LiveOutputSession }
  | { type: "delta"; id: number; text: string }
  | { type: "done"; session: LiveOutputSession }
  | { type: "clear" };

type Listener = (event: LiveOutputEvent) => void;

/**
 * 进程内的实时输出环形缓冲。只保存最近的会话和截断后的文本，
 * 不写 state.json / events.jsonl，进程重启即清空。
 */
export class LiveOutputLog {
  readonly #maxSessions: number;
  readonly #maxTextChars: number;
  #sessions: LiveOutputSession[] = [];
  #nextId = 1;
  #listeners = new Set<Listener>();

  constructor(options: { maxSessions?: number; maxTextChars?: number } = {}) {
    this.#maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.#maxTextChars = Math.max(8, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
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

  recent(limit = this.#maxSessions): LiveOutputSession[] {
    const safe = Math.max(1, Math.min(this.#maxSessions, Math.trunc(limit) || this.#maxSessions));
    return this.#sessions.slice(-safe).map(cloneSession);
  }

  limits(): LiveOutputLimits {
    return { sessions: this.#maxSessions, textChars: this.#maxTextChars };
  }

  clear(): void {
    this.#sessions = [];
    this.#emit({ type: "clear" });
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

  /** @internal 由 LiveOutputHandle 调用。 */
  complete(session: LiveOutputSession, patch: LiveOutputFinish): void {
    if (typeof patch.text === "string" && patch.text) {
      this.append(session, patch.text);
    }

    session.status = patch.error ? "error" : "ok";
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

  /** 输入一段原始 SSE 文本；内部会解析成可见的增量。 */
  push(chunk: string): void {
    if (this.#finished) return;
    const text = this.#extractor.push(chunk);
    if (text) this.#log.append(this.#session, text);
  }

  finish(patch: LiveOutputFinish = {}): void {
    if (this.#finished) return;
    this.#finished = true;
    const tail = this.#extractor.flush();
    if (tail) this.#log.append(this.#session, tail);
    this.#log.complete(this.#session, patch);
  }
}

function cloneSession(session: LiveOutputSession): LiveOutputSession {
  return {
    ...session,
    usage: session.usage ? { ...session.usage } : null,
  };
}