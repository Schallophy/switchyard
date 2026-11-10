import assert from "node:assert/strict";
import test from "node:test";
import { extractUsage, SseUsageTracker } from "../src/util/usage.ts";

test("reads OpenAI-style usage", () => {
  const usage = extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
  assert.deepEqual(usage, {
    promptTokens: 12,
    completionTokens: 7,
    totalTokens: 19,
    cachedPromptTokens: 0,
    cacheReported: false,
  });
});

test("reads input/output naming", () => {
  const usage = extractUsage({ usage: { input_tokens: 5, output_tokens: 3 } });
  assert.deepEqual(usage, {
    promptTokens: 5,
    completionTokens: 3,
    totalTokens: 8,
    cachedPromptTokens: 0,
    cacheReported: false,
  });
});

test("reads OpenAI-style cached prompt tokens", () => {
  const usage = extractUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cachedPromptTokens: 80,
    cacheReported: true,
  });
});

test("reads DeepSeek prompt cache hit tokens", () => {
  const usage = extractUsage({
    usage: { prompt_tokens: 90, completion_tokens: 6, prompt_cache_hit_tokens: 70 },
  });
  assert.deepEqual(usage, {
    promptTokens: 90,
    completionTokens: 6,
    totalTokens: 96,
    cachedPromptTokens: 70,
    cacheReported: true,
  });
});

test("clamps cached tokens to the prompt total", () => {
  const usage = extractUsage({
    usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 25 } },
  });
  assert.equal(usage?.cachedPromptTokens, 20);
  assert.equal(usage?.cacheReported, true);
});

test("reads Responses usage nested under the completed response", () => {
  const usage = extractUsage({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 40,
        output_tokens: 9,
        total_tokens: 49,
        input_tokens_details: { cached_tokens: 30 },
      },
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 40,
    completionTokens: 9,
    totalTokens: 49,
    cachedPromptTokens: 30,
    cacheReported: true,
  });
});

test("returns null when usage is absent", () => {
  assert.equal(extractUsage({ choices: [] }), null);
  assert.equal(extractUsage(null), null);
});

test("extracts usage from a stream that is split across chunks", () => {
  const tracker = new SseUsageTracker();
  tracker.push('data: {"choices":[{"delta":{"content":"he');
  tracker.push('llo"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":21,');
  tracker.push('"completion_tokens":4,"total_tokens":25}}\n\ndata: [DONE]\n\n');
  assert.deepEqual(tracker.usage, {
    promptTokens: 21,
    completionTokens: 4,
    totalTokens: 25,
    cachedPromptTokens: 0,
    cacheReported: false,
  });
});

test("extracts cached tokens from a stream", () => {
  const tracker = new SseUsageTracker();
  tracker.push(
    'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":16}}}\n\n',
  );
  assert.deepEqual(tracker.usage, {
    promptTokens: 21,
    completionTokens: 4,
    totalTokens: 25,
    cachedPromptTokens: 16,
    cacheReported: true,
  });
});

test("keeps usage from a very long event line", () => {
  // Responses 的 response.completed 会把整段输出放进同一行，长回答会超过旧上限
  const body = "数".repeat(20_000);
  const line = `data: {"type":"response.completed","response":{"usage":{"input_tokens":58,"output_tokens":32,"total_tokens":90},"output":[{"type":"message","content":[{"type":"output_text","text":"${body}"}]}]}}\n\n`;
  const tracker = new SseUsageTracker();
  for (let i = 0; i < line.length; i += 4_000) tracker.push(line.slice(i, i + 4_000));
  assert.ok(Buffer.byteLength(line) > 16_384);
  assert.deepEqual(tracker.usage, {
    promptTokens: 58,
    completionTokens: 32,
    totalTokens: 90,
    cachedPromptTokens: 0,
    cacheReported: false,
  });
});

test("ignores usage-free chunks", () => {
  const tracker = new SseUsageTracker();
  tracker.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  assert.equal(tracker.usage, null);
});

test("extracts nested Responses usage from typed SSE events", () => {
  const tracker = new SseUsageTracker();
  tracker.push('event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\n');
  tracker.push(
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":17,"output_tokens":6,"total_tokens":23}}}\n\n',
  );
  assert.deepEqual(tracker.usage, {
    promptTokens: 17,
    completionTokens: 6,
    totalTokens: 23,
    cachedPromptTokens: 0,
    cacheReported: false,
  });
});