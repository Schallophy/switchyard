import assert from "node:assert/strict";
import test from "node:test";
import { SseOutputExtractor, extractOutputText, extractToolCalls } from "../src/core/output-text.ts";

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

test("extracts chat text and tool calls into separate fields", () => {
  assert.equal(extractOutputText("completions", { choices: [{ text: "plain" }] }), "plain");

  const chat = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { name: "lookup", arguments: '{"q":"x"}' } }],
        },
      },
    ],
  };
  assert.equal(extractOutputText("chat", chat), null);
  assert.deepEqual(extractToolCalls("chat", chat), [{ name: "lookup", arguments: '{"q":"x"}' }]);
});

test("extracts responses output from both text and structured items", () => {
  assert.equal(extractOutputText("responses", { output_text: "final" }), "final");

  const responses = {
    output: [
      { type: "message", content: [{ type: "output_text", text: "part one" }] },
      { type: "function_call", name: "search", arguments: "{}" },
    ],
  };
  assert.equal(extractOutputText("responses", responses), "part one");
  assert.deepEqual(extractToolCalls("responses", responses), [{ name: "search", arguments: "{}" }]);
  assert.deepEqual(extractToolCalls("chat", { choices: [] }), []);
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
  assert.equal(extractor.flush(), "");
  assert.deepEqual(extractor.getToolCalls(), [{ name: "lookup", arguments: '{"q":"x"}' }]);
});

test("returns null finish reason when provider did not report one", () => {
  const extractor = new SseOutputExtractor("chat");
  extractor.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  assert.equal(extractor.getFinishReason(), null);
});