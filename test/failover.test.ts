import assert from "node:assert/strict";
import test from "node:test";
import { runFailover } from "../src/core/failover.ts";
import type { AttemptOutcome, FailureKind, NormalizedError } from "../src/types.ts";

function failed(kind: FailureKind, patch: Partial<NormalizedError> = {}): AttemptOutcome {
  const error: NormalizedError = {
    kind,
    label: kind,
    status: 500,
    code: kind,
    message: kind,
    fatal: false,
    markDead: false,
    markInvalid: false,
    retryable: true,
    ...patch,
  };
  return { ok: false, error, latencyMs: 1 };
}

function succeeded(): AttemptOutcome {
  return { ok: true, response: new Response('{"ok":true}', { status: 200 }), latencyMs: 1 };
}

test("switches to the next model when the first one is exhausted", async () => {
  const calls: string[] = [];
  const dead: string[] = [];
  const result = await runFailover({
    candidates: ["a", "b", "c"],
    maxAttempts: 5,
    attempt: async (model) => {
      calls.push(model);
      return model === "a" ? failed("quota_exhausted", { status: 403, markDead: true }) : succeeded();
    },
    hooks: { onDead: (model) => dead.push(model) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.model, "b");
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(dead, ["a"]);
  assert.equal(result.failovers, 1);
});

test("throttled models are skipped without being marked dead", async () => {
  const calls: string[] = [];
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 4,
    attempt: async (model) => {
      calls.push(model);
      return model === "a" ? failed("throttled", { status: 429 }) : succeeded();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["a", "b"]);
});

test("fatal errors stop immediately", async () => {
  const calls: string[] = [];
  const result = await runFailover({
    candidates: ["a", "b", "c"],
    maxAttempts: 5,
    attempt: async (model) => {
      calls.push(model);
      return failed("auth", { status: 401, fatal: true });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "auth");
  assert.deepEqual(calls, ["a"]);
});

test("an exhausted chain reports every attempt", async () => {
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 5,
    attempt: async () => failed("quota_exhausted", { status: 403, markDead: true }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.exhausted, true);
  assert.equal(result.ok === false && result.error.kind, "exhausted");
  assert.equal(result.attempts.length, 2);
  assert.match(result.ok === false ? result.error.message : "", /a: quota_exhausted 403/);
});

test("attempts are capped by maxAttempts", async () => {
  const calls: string[] = [];
  await runFailover({
    candidates: ["a", "b", "c"],
    maxAttempts: 2,
    attempt: async (model) => {
      calls.push(model);
      return failed("provider");
    },
  });
  assert.deepEqual(calls, ["a", "b"]);
});

test("an already aborted request never hits the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 3,
    signal: controller.signal,
    attempt: async (model) => {
      calls.push(model);
      return succeeded();
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "aborted");
  assert.deepEqual(calls, []);
});

test("all-throttled chains surface as a throttle error", async () => {
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 5,
    attempt: async () => failed("throttled", { status: 429 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.kind, "throttled");
});

test("a first-try success reports zero failovers", async () => {
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 2,
    attempt: async () => succeeded(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.failovers, 0);
  assert.equal(result.attempts.length, 1);
});

test("the winning attempt's provider id is reported back", async () => {
  const result = await runFailover({
    candidates: ["a", "b"],
    maxAttempts: 2,
    attempt: async (model) =>
      model === "a"
        ? failed("quota_exhausted", { status: 403 })
        : { ok: true, response: new Response("{}", { status: 200 }), latencyMs: 1, providerId: "alt" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.provider, "alt");
  assert.equal(result.ok === true && result.failovers, 1);
});
