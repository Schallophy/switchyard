import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONTEXT_WINDOW, type ChainConfig } from "../src/config/schema.ts";
import { activeModel, resolveRoute, selectCandidates } from "../src/core/selection.ts";
import type { ModelRecord } from "../src/types.ts";

function chain(models: string[], active = models[0] ?? ""): ChainConfig {
  return {
    active,
    models,
    context: { window: DEFAULT_CONTEXT_WINDOW, onOverflow: "reject" },
    retryDeadAfterMinutes: 0,
  };
}

function record(code: string, patch: Partial<ModelRecord> = {}): ModelRecord {
  return {
    code,
    family: "Test",
    health: "alive",
    reason: null,
    lastErrorCode: null,
    lastStatusCode: null,
    lastErrorMessage: null,
    checkedAt: null,
    lastUsedAt: null,
    promptTokens: 0,
    cachedPromptTokens: 0,
    cacheTrackedPromptTokens: 0,
    completionTokens: 0,
    requests: 0,
    failures: 0,
    throttledUntil: null,
    ...patch,
  };
}

function pick(
  models: string[],
  records: Record<string, ModelRecord>,
  options: { start?: string | null; now?: number; retryDeadAfterMs?: number } = {},
): string[] {
  return selectCandidates({
    chain: chain(models),
    getRecord: (code) => records[code],
    now: options.now ?? Date.now(),
    start: options.start,
    retryDeadAfterMs: options.retryDeadAfterMs,
  }).map((candidate) => candidate.code);
}

test("activeModel returns the selected model", () => {
  assert.equal(activeModel(chain(["a", "b", "c"], "b")), "b");
});

test("activeModel falls back to the first model when active is invalid", () => {
  assert.equal(activeModel(chain(["a", "b"], "nope")), "a");
  assert.equal(activeModel(chain([])), null);
});

test("auto resolves to the active model", () => {
  const resolution = resolveRoute("auto", chain(["a", "b", "c"], "b"));
  assert.equal(resolution.mode, "auto");
  assert.equal(resolution.model, "b");
});

test("an empty model name is treated as auto", () => {
  const resolution = resolveRoute(undefined, chain(["a", "b"], "b"));
  assert.equal(resolution.mode, "auto");
  assert.equal(resolution.model, "b");
});

test("a model in the list is resolved as a direct target", () => {
  const resolution = resolveRoute("c", chain(["a", "b", "c"], "b"));
  assert.equal(resolution.mode, "direct");
  assert.equal(resolution.model, "c");
});

test("unknown models pass through untouched", () => {
  const resolution = resolveRoute("some-external-model", chain(["a", "b"], "b"));
  assert.equal(resolution.mode, "passthrough");
  assert.equal(resolution.model, "some-external-model");
});

test("dead and invalid models are excluded", () => {
  const records = {
    a: record("a", { health: "dead" }),
    b: record("b"),
    c: record("c", { health: "invalid" }),
  };
  assert.deepEqual(pick(["a", "b", "c"], records), ["b"]);
});

test("a dead model returns once its retry interval has elapsed", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const records = {
    a: record("a", { health: "dead", checkedAt: new Date(now - 23 * 3_600_000).toISOString() }),
    b: record("b"),
  };
  // 24h 窗口：还差 1 小时，继续跳过
  assert.deepEqual(pick(["a", "b"], records, { now, retryDeadAfterMs: 24 * 3_600_000 }), ["b"]);
  // 12h 窗口：已过期，重新排到 b 前面
  assert.deepEqual(pick(["a", "b"], records, { now, retryDeadAfterMs: 12 * 3_600_000 }), ["a", "b"]);
  // 未开启自动重试
  assert.deepEqual(pick(["a", "b"], records, { now }), ["b"]);
});

test("invalid models never come back automatically", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const records = {
    a: record("a", { health: "invalid", checkedAt: new Date(now - 365 * 24 * 3_600_000).toISOString() }),
    b: record("b"),
  };
  assert.deepEqual(pick(["a", "b"], records, { now, retryDeadAfterMs: 60_000 }), ["b"]);
});

test("throttled models are deprioritized but still usable", () => {
  const now = Date.now();
  const records = {
    a: record("a", { throttledUntil: new Date(now + 60_000).toISOString() }),
    b: record("b"),
    c: record("c"),
  };
  assert.deepEqual(pick(["a", "b", "c"], records, { now }), ["b", "c", "a"]);
});

test("starting from a model rotates the list from that point", () => {
  const records = { a: record("a"), b: record("b"), c: record("c") };
  assert.deepEqual(pick(["a", "b", "c"], records, { start: "b" }), ["b", "c", "a"]);
});

test("starting from a dead model begins at the next usable model", () => {
  const records = { a: record("a"), b: record("b", { health: "dead" }), c: record("c") };
  assert.deepEqual(pick(["a", "b", "c"], records, { start: "b" }), ["a", "c"]);
});

test("an empty list yields no candidates", () => {
  assert.deepEqual(pick([], {}), []);
});

test("an accepts filter excludes models without the requested API", () => {
  const records: Record<string, ModelRecord> = { a: record("a"), b: record("b"), c: record("c") };
  const picked = selectCandidates({
    chain: chain(["a", "b", "c"]),
    getRecord: (code) => records[code],
    now: Date.now(),
    accepts: (code) => code === "b",
  }).map((candidate) => candidate.code);
  assert.deepEqual(picked, ["b"]);
});

test("accepts runs before health so a dead unsupported model is simply absent", () => {
  const records: Record<string, ModelRecord> = { a: record("a", { health: "dead" }), b: record("b") };
  const picked = selectCandidates({
    chain: chain(["a", "b"]),
    getRecord: (code) => records[code],
    now: Date.now(),
    accepts: (code) => code === "a",
  }).map((candidate) => candidate.code);
  assert.deepEqual(picked, []);
});
