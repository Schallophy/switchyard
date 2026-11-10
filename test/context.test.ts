import assert from "node:assert/strict";
import test from "node:test";
import { estimateRequestTokens, estimateTokens } from "../src/util/context.ts";

test("CJK characters count as one token each", () => {
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("   "), 1);
});

test("English text follows tokenizer-like word pieces", () => {
  assert.equal(estimateTokens("hello"), 1);
  assert.equal(estimateTokens("hello world"), 2);
  assert.equal(estimateTokens("The quick brown fox"), 4);
  assert.equal(estimateTokens("a b c"), 3);
  assert.equal(estimateTokens("Respond with JSON."), 4);
});

test("numbers and punctuation use tokenizer-like grouping", () => {
  assert.equal(estimateTokens("1234567890"), 4);
  assert.equal(estimateTokens("3.141592653589793"), 7);
  assert.equal(estimateTokens("hello, world!"), 4);
  assert.equal(estimateTokens("--- === ***"), 3);
});

test("identifiers are split on case boundaries", () => {
  assert.equal(estimateTokens("getUserName"), 3);
  assert.equal(estimateTokens("XMLHttpRequest"), 2);
  assert.equal(estimateTokens("snake_case_identifier"), 4);
});

test("mixed CJK and Latin text keeps separate pieces", () => {
  assert.equal(estimateTokens("用 React 写一个登录页"), 9);
});

test("chat estimates include message overhead and max_tokens", () => {
  const estimate = estimateRequestTokens("chat/completions", {
    messages: [{ role: "user", content: "你好" }],
    max_tokens: 100,
  });
  assert.equal(estimate.promptTokens, 9);
  assert.equal(estimate.outputTokens, 100);
  assert.equal(estimate.totalTokens, 109);
});

test("max_completion_tokens is used when max_tokens is absent", () => {
  const estimate = estimateRequestTokens("chat/completions", {
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 50,
  });
  assert.equal(estimate.promptTokens, 8);
  assert.equal(estimate.outputTokens, 50);
  assert.equal(estimate.totalTokens, 58);
});

test("image parts get a flat allowance", () => {
  const estimate = estimateRequestTokens("chat/completions", {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ],
  });
  assert.equal(estimate.promptTokens, 264);
});

test("completions estimates use the prompt field", () => {
  const estimate = estimateRequestTokens("completions", { prompt: "hello" });
  assert.equal(estimate.promptTokens, 3);
  assert.equal(estimate.outputTokens, 0);
});

test("tool definitions are counted toward the prompt", () => {
  const withoutTools = estimateRequestTokens("chat/completions", { messages: [] });
  const withTools = estimateRequestTokens("chat/completions", {
    messages: [],
    tools: [{ type: "function", function: { name: "lookup", description: "look up a record" } }],
  });
  assert.ok(withTools.promptTokens > withoutTools.promptTokens);
});

test("responses estimates read instructions, input and max_output_tokens", () => {
  const estimate = estimateRequestTokens("responses", {
    instructions: "讲中文",
    input: "你好",
    max_output_tokens: 64,
  });
  assert.equal(estimate.promptTokens, 8);
  assert.equal(estimate.outputTokens, 64);
  assert.equal(estimate.totalTokens, 72);
});

test("responses input items count text and tool output", () => {
  const estimate = estimateRequestTokens("responses", {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call_output", call_id: "call_1", output: "lookup done" },
    ],
  });
  assert.equal(estimate.promptTokens, 6);
  assert.equal(estimate.outputTokens, 0);
});