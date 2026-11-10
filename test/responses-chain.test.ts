import assert from "node:assert/strict";
import test from "node:test";
import {
  ResponseChainStore,
  canonicalJson,
  captureResponseId,
  chainDelta,
  chainScope,
  itemsPrefixHashes,
  responsesInputItems,
} from "../src/core/responses-chain.ts";

test("canonical json sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("input accepts a string or an item array", () => {
  assert.deepEqual(responsesInputItems("hi"), [{ role: "user", content: "hi" }]);
  assert.deepEqual(responsesInputItems([{ role: "user" }]), [{ role: "user" }]);
  assert.equal(responsesInputItems([]), null);
  assert.equal(responsesInputItems(undefined), null);
});

test("prefix hashes are stable and scoped", () => {
  const items = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
  const first = itemsPrefixHashes("scope", items);
  const second = itemsPrefixHashes("scope", items);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.ok(first[0] !== first[1]);

  const other = itemsPrefixHashes("other", items);
  assert.notEqual(other[0], first[0]);

  assert.equal(chainScope("caller", "provider", "model", null), chainScope("caller", "provider", "model", null));
  assert.notEqual(chainScope("caller", "provider", "model", null), chainScope("caller", "provider", "model", [1]));
});

test("the delta drops content the provider already stored", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { type: "function_call", name: "ls", call_id: "c1" },
    { type: "function_call_output", call_id: "c1", output: "a.txt" },
    { role: "user", content: "next" },
  ];
  assert.deepEqual(chainDelta(history, 1), [
    { type: "function_call_output", call_id: "c1", output: "a.txt" },
    { role: "user", content: "next" },
  ]);
  assert.deepEqual(chainDelta(history, 3), [
    { type: "function_call_output", call_id: "c1", output: "a.txt" },
    { role: "user", content: "next" },
  ]);
  // 只在末尾追加了新的 user，没有旧输出：仍然可以链
  assert.deepEqual(chainDelta([{ role: "user", content: "a" }, { role: "user", content: "b" }], 1), [
    { role: "user", content: "b" },
  ]);
  // 整个请求都是已有内容：不能链，必须全量重发
  assert.equal(chainDelta(history, history.length), null);
  assert.equal(chainDelta([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], 1), null);
});

test("chain entries expire and evict the least recently used", () => {
  const store = new ResponseChainStore();
  store.remember("a", "id-a", 1_000, 2, 0);
  store.remember("b", "id-b", 1_000, 2, 0);
  assert.equal(store.lookup("a", 500), "id-a");
  store.remember("c", "id-c", 1_000, 2, 500);
  assert.equal(store.size, 2);
  assert.equal(store.lookup("b", 600), null);
  assert.equal(store.lookup("a", 600), "id-a");
  assert.equal(store.lookup("a", 2_000), null);
  assert.equal(store.lookup("c", 2_000), null);
  assert.equal(store.size, 0);
});

test("captureResponseId passes bytes through and reports the id", async () => {
  const encoder = new TextEncoder();
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'data: [DONE]\n\n',
  ];
  const chunks = events.map((event) => encoder.encode(event));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const response = new Response(body);
  let captured: string | null = null;
  const wrapped = captureResponseId(response, (id) => {
    captured = id;
  });
  const text = await wrapped.text();
  assert.equal(captured, "resp_123");
  assert.equal(text, events.join(""));
});

test("captureResponseId finds the id when the event is split across chunks", async () => {
  const encoder = new TextEncoder();
  const whole = 'data: {"type":"response.created","response":{"id":"resp_split"}}\n\n';
  const parts = [whole.slice(0, 20), whole.slice(20, 55), whole.slice(55)];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  let captured: string | null = null;
  const text = await captureResponseId(new Response(body), (id) => {
    captured = id;
  }).text();
  assert.equal(captured, "resp_split");
  assert.equal(text, whole);
});

test("captureResponseId reads the id from a non-streaming json body", async () => {
  const response = new Response(JSON.stringify({ id: "resp_json", output: [] }), {
    headers: { "content-type": "application/json" },
  });
  let captured: string | null = null;
  const text = await captureResponseId(response, (id) => {
    captured = id;
  }).text();
  assert.equal(captured, "resp_json");
  assert.equal(JSON.parse(text).id, "resp_json");
});