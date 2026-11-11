import assert from "node:assert/strict";
import test from "node:test";
import { LiveOutputLog, type LiveOutputEvent } from "../src/core/live-output.ts";

test("records streaming output and publishes start, delta and done events", () => {
  const log = new LiveOutputLog();
  const events: LiveOutputEvent[] = [];
  const unsubscribe = log.subscribe((event) => events.push(event));

  const handle = log.start({
    api: "chat",
    model: "provider/model",
    provider: "provider",
    caller: "tester",
    requested: "auto",
    stream: true,
    failovers: 1,
  });
  handle.push('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  handle.finish({ usage: { promptTokens: 3, cachedPromptTokens: 1, completionTokens: 2, totalTokens: 5, cacheReported: true }, bytes: 42, latencyMs: 123 });

  const session = log.recent()[0];
  assert.equal(session?.status, "ok");
  assert.equal(session?.text, "hello");
  assert.equal(session?.model, "provider/model");
  assert.equal(session?.provider, "provider");
  assert.equal(session?.api, "chat");
  assert.equal(session?.failovers, 1);
  assert.equal(session?.latencyMs, 123);
  assert.equal(session?.usage?.completionTokens, 2);

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "delta", "done"],
  );
  log.clear();
  assert.equal(events.at(-1)?.type, "clear");
  unsubscribe();
});

test("marks failed output and publishes the error", () => {
  const log = new LiveOutputLog();
  const handle = log.start({
    api: "responses",
    model: "provider/broken",
    provider: "provider",
    caller: "tester",
    requested: "provider/broken",
    stream: false,
  });
  handle.finish({ error: "无权限：403", latencyMs: 8 });

  const session = log.recent()[0];
  assert.equal(session?.status, "error");
  assert.equal(session?.error, "无权限：403");
  assert.equal(session?.text, "");
});

test("truncates very long output and keeps only the configured number of sessions", () => {
  const log = new LiveOutputLog({ maxSessions: 1, maxTextChars: 10 });
  const first = log.start({
    api: "completions",
    model: "p/one",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: false,
  });
  first.finish({ text: "123456789012345" });
  assert.equal(log.recent()[0]?.truncated, true);
  assert.match(log.recent()[0]?.text ?? "", /已截断/);

  const second = log.start({
    api: "chat",
    model: "p/two",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: false,
  });
  second.finish({ text: "ok" });
  assert.deepEqual(log.recent().map((session) => session.model), ["p/two"]);
});

test("a finished handle ignores later chunks", () => {
  const log = new LiveOutputLog();
  const handle = log.start({
    api: "chat",
    model: "p/model",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: true,
  });
  handle.finish({});
  handle.push('data: {"choices":[{"delta":{"content":"late"}}]}\n\n');
  assert.equal(log.recent()[0]?.text, "");
});

test("captures the raw response body alongside the extracted text", () => {
  const log = new LiveOutputLog();
  const handle = log.start({
    api: "chat",
    model: "p/model",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: true,
  });
  handle.push('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  handle.finish({ finishReason: "stop" });

  const session = log.recent()[0];
  assert.equal(session?.rawLength, 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'.length);
  assert.equal(session?.finishReason, "stop");
  const raw = log.raw(session?.id ?? 0);
  assert.ok(raw);
  assert.equal(raw?.raw, 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  assert.equal(raw?.truncated, false);
});

test("truncates and marks an over-long raw body", () => {
  const log = new LiveOutputLog({ maxRawChars: 32 });
  const handle = log.start({
    api: "completions",
    model: "p/one",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: false,
  });
  handle.finish({ raw: "a very long raw response body that exceeds thirty-two characters" });

  const session = log.recent()[0];
  assert.equal(session?.truncated, false);
  assert.equal(session?.rawLength, 32 + "\n\n…（原始响应过长，已截断）".length);
  const raw = log.raw(session?.id ?? 0);
  assert.ok(raw);
  assert.match(raw?.raw ?? "", /已截断/);
  assert.ok(raw?.truncated);
});

test("keeps streamed tool calls separate from assistant text", () => {
  const log = new LiveOutputLog();
  const handle = log.start({
    api: "chat",
    model: "p/model",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: true,
  });
  handle.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{\\"command\\":"}}]}}]}\n\n',
  );
  handle.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  );
  handle.finish({ finishReason: "tool_calls" });

  const session = log.recent()[0];
  assert.equal(session?.text, "");
  assert.deepEqual(session?.toolCalls, [{ name: "shell", arguments: '{"command":"ls"}' }]);
});

test("caps stored tool call arguments", () => {
  const log = new LiveOutputLog();
  const handle = log.start({
    api: "chat",
    model: "p/model",
    provider: "p",
    caller: "tester",
    requested: "auto",
    stream: false,
  });
  handle.finish({ toolCalls: [{ name: "write", arguments: "x".repeat(5000) }] });

  const call = log.recent()[0]?.toolCalls[0];
  assert.equal(call?.name, "write");
  assert.equal(call?.arguments.length, 4001);
  assert.match(call?.arguments ?? "", /…$/);
});

test("raw returns null for unknown session", () => {
  const log = new LiveOutputLog();
  assert.equal(log.raw(999), null);
});