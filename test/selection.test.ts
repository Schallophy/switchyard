import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONTEXT_WINDOW, type ChainConfig } from "../src/config/schema.ts";
import { resolveRoute, selectCandidates } from "../src/core/selection.ts";
import type { ModelRecord } from "../src/types.ts";

function chain(models: string[]): ChainConfig {
  return {
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
    cost: 0,
    requests: 0,
    failures: 0,
    throttledUntil: null,
    ...patch,
  };
}

function pick(
  models: string[],
  records: Record<string, ModelRecord>,
  options: { now?: number; retryDeadAfterMs?: number } = {},
): string[] {
  return selectCandidates({
    chain: chain(models),
    getRecord: (code) => records[code],
    now: options.now ?? Date.now(),
    retryDeadAfterMs: options.retryDeadAfterMs,
  }).map((candidate) => candidate.code);
}

test("auto resolves to the first model in the list", () => {
  const resolution = resolveRoute("auto", chain(["a", "b", "c"]));
  assert.equal(resolution.mode, "auto");
  assert.equal(resolution.model, "a");
});

test("an empty model name is treated as auto", () => {
  const resolution = resolveRoute(undefined, chain(["a", "b"]));
  assert.equal(resolution.mode, "auto");
  assert.equal(resolution.model, "a");
});

test("auto resolves to null when the list is empty", () => {
  assert.equal(resolveRoute("auto", chain([])).model, null);
});

test("a model in the list is resolved as a direct target", () => {
  const resolution = resolveRoute("c", chain(["a", "b", "c"]));
  assert.equal(resolution.mode, "direct");
  assert.equal(resolution.model, "c");
});

test("unknown models pass through untouched", () => {
  const resolution = resolveRoute("some-external-model", chain(["a", "b"]));
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

test("throttled models leave the chain until the cooldown ends", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const records = {
    a: record("a", { throttledUntil: new Date(now + 60_000).toISOString() }),
    b: record("b"),
    c: record("c"),
  };
  // 冷却中的列表第一个模型让路，不再出现在候选里
  assert.deepEqual(pick(["a", "b", "c"], records, { now }), ["b", "c"]);
  // 冷却到期后自动回到链首
  assert.deepEqual(pick(["a", "b", "c"], records, { now: now + 60_001 }), ["a", "b", "c"]);
});

test("candidates keep the list order", () => {
  const records = { a: record("a"), b: record("b"), c: record("c") };
  assert.deepEqual(pick(["c", "a", "b"], records), ["c", "a", "b"]);
});

test("a dead first model yields to the next one", () => {
  const records = { a: record("a", { health: "dead" }), b: record("b"), c: record("c") };
  assert.deepEqual(pick(["a", "b", "c"], records), ["b", "c"]);
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
