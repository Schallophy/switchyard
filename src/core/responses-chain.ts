import { createHash } from "node:crypto";

interface ChainEntry {
  id: string;
  expiresAt: number;
}

/**
 * 记录「对话前缀哈希 → response id」。只存在内存里：进程重启或条目过期时，
 * 自动退回全量请求，不影响正确性。
 */
export class ResponseChainStore {
  #entries = new Map<string, ChainEntry>();

  get size(): number {
    return this.#entries.size;
  }

  lookup(key: string, now = Date.now()): string | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return null;
    }
    // LRU：重新插入，淘汰时优先丢弃最久未用的
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.id;
  }

  remember(key: string, id: string, ttlMs: number, maxEntries: number, now = Date.now()): void {
    this.#entries.delete(key);
    this.#entries.set(key, { id, expiresAt: now + Math.max(1_000, ttlMs) });
    this.prune(now, maxEntries);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  prune(now = Date.now(), maxEntries = Number.POSITIVE_INFINITY): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    while (this.#entries.size > maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** 稳定序列化：对象键排序，保证同样的内容得到同样的哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 会话作用域：同一调用方、提供商、模型和工具集才允许复用 response id。 */
export function chainScope(callerId: string, providerId: string, model: string, tools: unknown): string {
  return `${callerId}|${providerId}|${model}|${hashJson(tools ?? null)}`;
}

/** 把 input 统一成数组；字符串视为一条 user 消息。 */
export function responsesInputItems(input: unknown): unknown[] | null {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) && input.length > 0 ? input : null;
}

/**
 * 依次计算每个前缀的滚动哈希。第 i 个结果覆盖 items[0..i]。
 * scope 把调用方、提供商、模型和 tools 签名一起绑定，避免跨会话误用 response id。
 */
export function itemsPrefixHashes(scope: string, items: unknown[]): string[] {
  const out: string[] = [];
  let previous = hashJson({ scope });
  for (const item of items) {
    previous = createHash("sha256").update(previous).update("\n").update(canonicalJson(item)).digest("hex");
    out.push(`${scope}\u0000${previous}`);
  }
  return out;
}

function isStoredOutput(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "function_call" || type === "reasoning" || type === "item_reference") return true;
  return record.role === "assistant";
}

/**
 * 命中前缀 matchedLength 后，客户端会再次带上模型上一轮的输出；
 * 这些内容平台已经存过，必须丢掉，只发送真正新增的 user / 工具结果。
 */
export function chainDelta(items: unknown[], matchedLength: number): unknown[] | null {
  const rest = items.slice(matchedLength).filter((item) => !isStoredOutput(item));
  return rest.length > 0 ? rest : null;
}

/**
 * 透传响应流，同时从 `response.created`（或非流式 JSON）里抓取 response id。
 * 不改写任何字节，客户端拿到的内容与原来一致。
 */
export function captureResponseId(response: Response, onId: (id: string) => void): Response {
  const body = response.body;
  if (!body) return response;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let settled = false;
  let sawSse = false;

  const inspectSse = (): void => {
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (line.startsWith("data:")) {
        sawSse = true;
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const event = JSON.parse(payload) as {
              type?: string;
              response?: { id?: string };
              id?: string;
            };
            const id = typeof event.response?.id === "string" ? event.response.id : event.type === "response.created" ? event.id : undefined;
            if (typeof id === "string" && id) {
              settled = true;
              onId(id);
              return;
            }
          } catch {
            // 非 JSON 行忽略
          }
        }
      }
      index = pending.indexOf("\n");
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!settled && !sawSse && pending.trim()) {
          try {
            const payload = JSON.parse(pending) as { id?: string };
            if (typeof payload.id === "string" && payload.id) {
              settled = true;
              onId(payload.id);
            }
          } catch {
            // 非 JSON 响应体
          }
        }
        controller.close();
        return;
      }
      if (!settled && value && value.byteLength > 0) {
        pending += decoder.decode(value, { stream: true });
        inspectSse();
        if (!settled && pending.length > 65536) settled = true;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, { status: response.status, statusText: response.statusText });
}