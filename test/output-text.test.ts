import assert from "node:assert/strict";
import test from "node:test";
import { SseOutputExtractor, extractOutputText } from "../src/core/output-text.ts";

test("extracts chat completions text, including content parts", () => {
  assert.equal(
    extractOutputText("chat", { choices: [{ message: { content: "hello" } }] }),
    "hello",
  );
  assert.equal(
    extractOutputText("chat", {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        },
      ],
    }),
    "hello world",
  );
});

test("extracts legacy completions and tool calls", () => {
  assert.equal(extractOutputText("completions", { choices: [{ text: "plain" }] }), "plain");
  assert.equal(
    extractOutputText("chat", {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ function: { name: "lookup", arguments: '{"q":"x"}' } }],
          },
        },
      ],
    }),
    '[tool_call] lookup({"q":"x"})',
  );
});

test("extracts responses output from both text and structured items", () => {
  assert.equal(extractOutputText("responses", { output_text: "final" }), "final");
  assert.equal(
    extractOutputText("responses", {
      output: [
        { type: "message", content: [{ type: "output_text", text: "part one" }] },
        { type: "function_call", name: "search", arguments: "{}" },
      ],
    }),
    'part one\n[tool_call] search({})',
  );
});

test("summarizes embedding results instead of showing raw vectors", () => {
  assert.equal(
    extractOutputText("embeddings", { data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4] }] }),
    "2 条向量 × 3 维",
  );
  assert.equal(extractOutputText("embeddings", {}), null);
});

test("parses chat SSE deltas split across chunks", () => {
  const extractor = new SseOutputExtractor("chat");
  assert.equal(extractor.push('data: {"choices":[{"delta":{"content":"he'), "");
  assert.equal(extractor.push('llo"}}]}\n\n'), "hello");
  assert.equal(extractor.push('data: {"choices":[{"delta":{"content":"!"}}]}\n\n'), "!");
  assert.equal(extractor.push("data: [DONE]\n\n"), "");
});

test("parses responses SSE deltas and does not duplicate the done event", () => {
  const extractor = new SseOutputExtractor("responses");
  assert.equal(
    extractor.push('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'),
    "Hi",
  );
  assert.equal(
    extractor.push('data: {"type":"response.output_text.done","text":"Hi"}\n\n'),
    "",
  );
});

test("falls back to the completed responses payload when there are no deltas", () => {
  const extractor = new SseOutputExtractor("responses");
  assert.equal(
    extractor.push('data: {"type":"response.completed","response":{"output_text":"final"}}\n\n'),
    "final",
  );
});

test("ignores malformed SSE data", () => {
  const extractor = new SseOutputExtractor("chat");
  assert.equal(extractor.push("data: nope\n\n"), "");
  assert.equal(extractor.push(": keep-alive\n\n"), "");
});

test("reports chat finish reason from the last delta block", () => {
  const extractor = new SseOutputExtractor("chat");
  extractor.push('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n');
  assert.equal(extractor.getFinishReason(), "stop");
});

test("reports completions finish reason", () => {
  const extractor = new SseOutputExtractor("completions");
  extractor.push('data: {"choices":[{"text":"hi","finish_reason":"length"}]}\n\n');
  assert.equal(extractor.getFinishReason(), "length");
});

test("reports responses completion status", () => {
  const extractor = new SseOutputExtractor("responses");
  assert.equal(
    extractor.push('data: {"type":"response.completed","response":{"output_text":"final"}}\n\n'),
    "final",
  );
  assert.equal(extractor.getFinishReason(), "completed");
});

test("assembles chat tool calls streamed across deltas", () => {
  const extractor = new SseOutputExtractor("chat");
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":""}}]}}]}\n\n',
  );
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}\n\n',
  );
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  );
  assert.equal(extractor.push("data: [DONE]\n\n"), "");
  assert.equal(extractor.flush(), '[tool_call] lookup({"q":"x"})');
  assert.equal(extractor.flush(), "");
});

test("returns null finish reason when provider did not report one", () => {
  const extractor = new SseOutputExtractor("chat");
  extractor.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  assert.equal(extractor.getFinishReason(), null);
});