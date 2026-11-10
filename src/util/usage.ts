import type { Usage } from "../types.ts";

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cacheTokensOf(fields: Record<string, unknown>): number | null {
  const details = objectOrNull(fields.prompt_tokens_details) ?? objectOrNull(fields.input_tokens_details);
  if (details) {
    const cached = numberOrNull(details.cached_tokens);
    if (cached !== null) return cached;
  }
  return (
    numberOrNull(fields.prompt_cache_hit_tokens) ??
    numberOrNull(fields.cache_read_input_tokens) ??
    null
  );
}

export function extractUsage(node: unknown): Usage | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  let usage = record.usage;

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    const response = record.response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
      usage = (response as Record<string, unknown>).usage;
    }
  }
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const fields = usage as Record<string, unknown>;
  const prompt = numberOrNull(fields.prompt_tokens) ?? numberOrNull(fields.input_tokens);
  const completion = numberOrNull(fields.completion_tokens) ?? numberOrNull(fields.output_tokens);
  if (prompt === null && completion === null) return null;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const total = numberOrNull(fields.total_tokens) ?? promptTokens + completionTokens;
  const cached = cacheTokensOf(fields);
  return {
    promptTokens,
    completionTokens,
    totalTokens: total,
    cachedPromptTokens: cached === null ? 0 : Math.min(promptTokens, Math.max(0, cached)),
    cacheReported: cached !== null,
  };
}

export class SseUsageTracker {
  /**
   * 单行上限。Responses 的 response.completed 会把整段输出文本放进同一个
   * data 行，长回答很容易到几十 KB，所以这里不能用小阈值丢弃。
   */
  static readonly MAX_LINE_BYTES = 8 * 1024 * 1024;

  #buffer = "";
  #usage: Usage | null = null;
  #skipLine = false;

  push(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!this.#skipLine) this.#consume(line);
      this.#skipLine = false;
      index = this.#buffer.indexOf("\n");
    }

    // 只有真正异常的输入才会走到这里：丢掉这一行，避免内存无上限增长。
    if (this.#buffer.length > SseUsageTracker.MAX_LINE_BYTES) {
      this.#buffer = "";
      this.#skipLine = true;
    }
  }

  #consume(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    // 提前筛掉明显不含用量的行，避免为每个 delta 都做全文解析
    if (!payload.includes("usage")) return;
    try {
      const parsed: unknown = JSON.parse(payload);
      const usage = extractUsage(parsed);
      if (usage) this.#usage = usage;
    } catch {
      // 跨 chunk 切开的 JSON 会在后续行补齐；这里忽略解析失败
    }
  }

  get usage(): Usage | null {
    return this.#usage;
  }
}
