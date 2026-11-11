import type { ApiKind } from "../config/schema.ts";

/** 展示用的工具调用；参数保持原始 JSON 字符串，由界面决定怎么呈现。 */
export interface OutputToolCall {
  name: string;
  arguments: string;
}

/**
 * 从一次完整响应里提取适合在「实时输出」页展示的文本。
 *
 * 这里只做展示用途，不参与计费或故障转移判断；所有解析都保持宽松，
 * 遇到未知结构时返回 null，而不是抛错影响正常响应。
 */
export function extractOutputText(api: ApiKind, data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;

  switch (api) {
    case "chat":
      return chatOutput(record);
    case "completions":
      return completionsOutput(record);
    case "responses":
      return responsesOutput(record);
    case "embeddings":
      return embeddingsOutput(record);
    default:
      return null;
  }
}

/** 从完整响应里取出工具调用，用于结构化展示。 */
export function extractToolCalls(api: ApiKind, data: unknown): OutputToolCall[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;

  if (api === "chat") {
    const calls: OutputToolCall[] = [];
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== "object") continue;
      const toolCalls = (message as Record<string, unknown>).tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        const fn = (call as Record<string, unknown>).function;
        if (!fn || typeof fn !== "object") continue;
        const name = (fn as Record<string, unknown>).name;
        if (typeof name !== "string" || !name) continue;
        const args = (fn as Record<string, unknown>).arguments;
        calls.push({ name, arguments: typeof args === "string" ? args : "" });
      }
    }
    return calls;
  }

  if (api === "responses") {
    const calls: OutputToolCall[] = [];
    const output = Array.isArray(record.output) ? record.output : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (entry.type !== "function_call") continue;
      if (typeof entry.name !== "string" || !entry.name) continue;
      const args = entry.arguments;
      calls.push({ name: entry.name, arguments: typeof args === "string" ? args : "" });
    }
    return calls;
  }

  return [];
}

/**
 * 流式响应是 SSE，每个 `data:` 里是一小段增量。这里按协议把增量解析成纯文本，
 * 并把跨 chunk 的半行/半段 JSON 缓存在实例里。
 */
export class SseOutputExtractor {
  readonly #api: ApiKind;
  #buffer = "";
  #hasText = false;
  #finishReason: string | null = null;
  /** 流式工具调用按调用分片下发，这里先把名字和参数拼回来。 */
  #toolCalls = new Map<string, { name: string; args: string; order: number }>();

  constructor(api: ApiKind) {
    this.#api = api;
  }

  push(chunk: string): string {
    this.#buffer += chunk;
    let out = "";

    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.#buffer);
      if (!separator) break;
      const block = this.#buffer.slice(0, separator.index);
      this.#buffer = this.#buffer.slice(separator.index + separator[0].length);
      const text = this.#block(block);
      if (text) {
        this.#hasText = true;
        out += text;
      }
    }

    return out;
  }

  /** 流结束前可能没有最后一个空行，把残留内容也解析一次。 */
  flush(): string {
    const block = this.#buffer;
    this.#buffer = "";
    if (!block.trim()) return "";
    const text = this.#block(block);
    if (text) this.#hasText = true;
    return text;
  }

  /** 流式响应结束后的完成原因，如 "stop" / "length" / "tool_calls" / "completed"；未报告则为 null。 */
  getFinishReason(): string | null {
    return this.#finishReason;
  }

  /** 已累积的工具调用，按输出顺序排列；没有则为空数组。 */
  getToolCalls(): OutputToolCall[] {
    return [...this.#toolCalls.values()]
      .sort((a, b) => a.order - b.order)
      .filter((call) => call.name.length > 0)
      .map((call) => ({ name: call.name, arguments: call.args }));
  }

  /** Chat 的工具调用按 index 分片，Responses 按 item id 分片。 */
  #collectToolCalls(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const call of value) {
      if (!call || typeof call !== "object") continue;
      const recordCall = call as Record<string, unknown>;
      const index =
        typeof recordCall.index === "number" && Number.isFinite(recordCall.index)
          ? recordCall.index
          : 0;
      const key = `chat:${index}`;
      const acc = this.#toolCalls.get(key) ?? { name: "", args: "", order: index };
      const fn = recordCall.function;
      if (fn && typeof fn === "object") {
        const fnRecord = fn as Record<string, unknown>;
        if (typeof fnRecord.name === "string" && fnRecord.name && !acc.name) {
          acc.name = fnRecord.name;
        }
        if (typeof fnRecord.arguments === "string") acc.args += fnRecord.arguments;
      }
      this.#toolCalls.set(key, acc);
    }
  }

  #block(block: string): string {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") return "";

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return "";
    }
    if (!payload || typeof payload !== "object") return "";

    const record = payload as Record<string, unknown>;

    if (this.#api === "chat") {
      const choices = Array.isArray(record.choices) ? record.choices : [];
      let out = "";
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        const delta = (choice as Record<string, unknown>).delta;
        if (!delta || typeof delta !== "object") continue;
        const deltaRecord = delta as Record<string, unknown>;
        out += textFromContent(deltaRecord.content);
        this.#collectToolCalls(deltaRecord.tool_calls);
        const fr = (choice as Record<string, unknown>).finish_reason;
        if (typeof fr === "string" && fr) this.#finishReason = fr;
      }
      return out;
    }

    if (this.#api === "completions") {
      const choices = Array.isArray(record.choices) ? record.choices : [];
      return choices
        .map((choice) => {
          if (!choice || typeof choice !== "object") return "";
          const text = (choice as Record<string, unknown>).text;
          const fr = (choice as Record<string, unknown>).finish_reason;
          if (typeof fr === "string" && fr) this.#finishReason = fr;
          return typeof text === "string" ? text : "";
        })
        .join("");
    }

    if (this.#api === "responses") {
      const type = typeof record.type === "string" ? record.type : "";

      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = record.item;
        if (item && typeof item === "object") {
          const entry = item as Record<string, unknown>;
          if (entry.type === "function_call") {
            const key = responseCallKey(record) ?? "responses:#0";
            const acc = this.#toolCalls.get(key) ?? {
              name: "",
              args: "",
              order: responseCallOrder(record),
            };
            if (typeof entry.name === "string" && entry.name) acc.name = entry.name;
            if (typeof entry.arguments === "string" && entry.arguments) {
              // done 事件里的参数是完整值，优先于分片累加的结果。
              acc.args = entry.arguments;
            }
            this.#toolCalls.set(key, acc);
          }
        }
      } else if (type === "response.function_call_arguments.delta") {
        const key = responseCallKey(record) ?? "responses:#0";
        if (typeof record.delta === "string" && record.delta) {
          const acc = this.#toolCalls.get(key) ?? {
            name: "",
            args: "",
            order: responseCallOrder(record),
          };
          acc.args += record.delta;
          this.#toolCalls.set(key, acc);
        }
      } else if (type === "response.function_call_arguments.done") {
        const key = responseCallKey(record) ?? "responses:#0";
        if (typeof record.arguments === "string") {
          const acc = this.#toolCalls.get(key) ?? {
            name: "",
            args: "",
            order: responseCallOrder(record),
          };
          acc.args = record.arguments;
          this.#toolCalls.set(key, acc);
        }
      }

      if (typeof record.delta === "string" && type.includes("output_text.delta")) return record.delta;
      if (typeof record.delta === "string" && type.includes("refusal.delta")) return record.delta;

      if (type === "response.output_text.done") {
        this.#finishReason = "done";
        if (!this.#hasText && typeof record.text === "string") return record.text;
        return "";
      }

      if (type === "response.completed") {
        this.#finishReason = "completed";
        // 有些实现只在完成事件里带完整的工具调用。
        if (this.#toolCalls.size === 0 && record.response) {
          const calls = extractToolCalls("responses", record.response);
          calls.forEach((call, index) => {
            this.#toolCalls.set(`responses:completed:${index}`, {
              name: call.name,
              args: call.arguments,
              order: index,
            });
          });
        }
        if (!this.#hasText && record.response) {
          return responsesOutput(record.response as Record<string, unknown>) ?? "";
        }
      }
    }

    return "";
  }
}

function responseCallKey(record: Record<string, unknown>): string | null {
  const itemId = record.item_id;
  if (typeof itemId === "string" && itemId) return `responses:${itemId}`;

  const item = record.item;
  if (item && typeof item === "object") {
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" && id) return `responses:${id}`;
  }

  const outputIndex = record.output_index;
  if (typeof outputIndex === "number" && Number.isFinite(outputIndex)) {
    return `responses:#${outputIndex}`;
  }
  return null;
}

function responseCallOrder(record: Record<string, unknown>): number {
  const outputIndex = record.output_index;
  if (typeof outputIndex === "number" && Number.isFinite(outputIndex)) return outputIndex;
  return 0;
}

function chatOutput(record: Record<string, unknown>): string | null {
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const parts: string[] = [];

  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const item = choice as Record<string, unknown>;
    const message = item.message;
    if (message && typeof message === "object") {
      const recordMessage = message as Record<string, unknown>;
      const content = textFromContent(recordMessage.content);
      if (content) parts.push(content);
    }
    if (typeof item.text === "string" && item.text) parts.push(item.text);
  }

  return parts.length ? parts.join("\n") : null;
}

function completionsOutput(record: Record<string, unknown>): string | null {
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const text = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const value = (choice as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
  return text || null;
}

function responsesOutput(record: Record<string, unknown>): string | null {
  if (typeof record.output_text === "string" && record.output_text) return record.output_text;

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const content = textFromContent(entry.content);
    if (content) parts.push(content);
    if (typeof entry.text === "string" && entry.text) parts.push(entry.text);
  }
  return parts.length ? parts.join("\n") : null;
}

function embeddingsOutput(record: Record<string, unknown>): string | null {
  const data = Array.isArray(record.data) ? record.data : [];
  if (data.length === 0) return null;
  const first = data[0];
  const embedding =
    first && typeof first === "object" ? (first as Record<string, unknown>).embedding : null;
  const dimensions = Array.isArray(embedding) ? embedding.length : null;
  return `${data.length} 条向量${dimensions ? ` × ${dimensions} 维` : ""}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    if (typeof record.content === "string") parts.push(record.content);
  }
  return parts.join("");
}