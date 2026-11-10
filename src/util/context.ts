export interface ContextEstimate {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// Keep a little headroom: the estimate is used to reject requests before they
// are forwarded, so a small over-count is safer than a small under-count.
const SAFETY_MARGIN = 1.03;

// Tokenizers such as cl100k_base / o200k_base first split text into pieces:
// words (with an optional leading space), 1-3 digit groups, punctuation runs
// and whitespace runs. Following the same split makes the estimate track real
// token counts on both prose and code, without shipping a full BPE vocabulary.
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2fa1f}]/u;
// CJK has its own alternative, so words must stop at CJK characters even when
// the two scripts are written without spaces ("用React写").
const NON_CJK_LETTER = `(?:(?!${CJK_CHAR.source})\\p{L})`;
const PIECE = new RegExp(
  `${CJK_CHAR.source}|[^\\r\\n\\p{L}\\p{N}]?${NON_CJK_LETTER}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+`,
  "gu",
);
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const NUMBER = /^\p{N}+$/u;
const WHITESPACE = /^\s+$/u;
const CAMEL_BOUNDARY = /(?<=[\p{Ll}\p{N}])(?=[\p{Lu}])/u;
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

/**
 * Number of tokens in one word. Frequent English words stay a single token for
 * a long time; rarer words split roughly every five characters. CamelCase and
 * PascalCase identifiers are scored per part, matching how BPE splits them.
 */
function wordTokens(letters: string): number {
  const parts = letters.split(CAMEL_BOUNDARY);
  if (parts.length > 1) {
    return parts.reduce((sum, part) => sum + naturalWordTokens(part.length), 0);
  }
  return naturalWordTokens(letters.length);
}

function naturalWordTokens(length: number): number {
  if (length <= 8) return 1;
  if (length <= 12) return 1.5;
  if (length <= 16) return 2.5;
  return length / 5;
}

/** Punctuation and symbols are usually merged into one or two tokens per run. */
function symbolTokens(piece: string): number {
  let tokens = 0;
  let run = 0;
  const flush = (): void => {
    if (run > 0) {
      tokens += Math.max(1, Math.round(run / 7));
      run = 0;
    }
  };

  for (const char of piece) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0x200d || MARK.test(char) || /\s/u.test(char)) continue;
    if (PICTOGRAPH.test(char)) {
      flush();
      tokens += 2;
    } else {
      run += 1;
    }
  }
  flush();
  return tokens;
}

/**
 * Approximates a tokenizer count using the same pre-tokenization shape as
 * cl100k_base / o200k_base and a calibrated per-piece estimate. CJK characters
 * count as one token each; numbers count as one token per 1-3 digits.
 *
 * This is intentionally an estimate: it is only used to reject requests that
 * are clearly over the configured context window. The provider's `usage` is
 * still the authority for exact counts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const match of text.matchAll(PIECE)) {
    const piece = match[0] ?? "";
    if (!piece) continue;

    const cp = piece.codePointAt(0) ?? 0;
    if (isCjk(cp)) {
      tokens += 1;
      continue;
    }
    if (WHITESPACE.test(piece)) {
      tokens += 1;
      continue;
    }
    if (NUMBER.test(piece)) {
      tokens += 1;
      continue;
    }
    if (LETTER.test(piece)) {
      const letters = piece.replace(/^[^\p{L}\p{M}]+/u, "").replace(/\p{M}/gu, "");
      tokens += wordTokens(letters);
      continue;
    }
    tokens += symbolTokens(piece);
  }

  return tokens > 0 ? Math.max(1, Math.round(tokens * SAFETY_MARGIN)) : 0;
}

function contentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (typeof part === "string") {
      total += estimateTokens(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "image_url" || type === "image") total += 256;
    else if (type === "input_audio") total += 512;
    else if (typeof item.text === "string") total += estimateTokens(item.text);
    else if (typeof item.content === "string") total += estimateTokens(item.content);
    else if (Array.isArray(item.content)) total += contentTokens(item.content);
    else if (typeof item.output === "string") total += estimateTokens(item.output);
    else if (typeof item.arguments === "string") total += estimateTokens(item.arguments);
  }
  return total;
}

function countJson(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return estimateTokens(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function readOutputTokens(body: Record<string, unknown>): number {
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const raw = body[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  }
  return 0;
}

/** Estimates the prompt plus any explicitly requested output tokens. */
export function estimateRequestTokens(path: string, body: Record<string, unknown>): ContextEstimate {
  let promptTokens = 0;

  if (path === "responses") {
    promptTokens += 3;
    promptTokens += contentTokens(body.input);
    promptTokens += contentTokens(body.instructions);
    promptTokens += countJson(body.tools);
    const outputTokens = readOutputTokens(body);
    return { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens };
  }

  if (path === "completions") {
    promptTokens = contentTokens(body.prompt) + 2;
  } else {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const item = message as Record<string, unknown>;
      // OpenAI's chat format spends 3 tokens per message plus one for the role.
      promptTokens += 3;
      if (typeof item.role === "string") promptTokens += estimateTokens(item.role);
      if (typeof item.name === "string") promptTokens += estimateTokens(item.name);
      promptTokens += contentTokens(item.content);
      promptTokens += countJson(item.tool_calls);
      promptTokens += countJson(item.function_call);
    }
    promptTokens += 3;
  }

  promptTokens += countJson(body.tools);
  promptTokens += countJson(body.functions);
  if (body.response_format !== undefined) promptTokens += countJson(body.response_format);

  const outputTokens = readOutputTokens(body);
  return { promptTokens, outputTokens, totalTokens: promptTokens + outputTokens };
}