import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identifyCaller } from "../src/core/caller.ts";
import { StateStore } from "../src/store/state.ts";

const cached = {
  promptTokens: 30,
  completionTokens: 7,
  totalTokens: 37,
  cachedPromptTokens: 20,
  cacheReported: true,
};

test("usage is counted per protocol and per caller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-api-stats-"));
  try {
    const file = join(dir, "state.json");
    const caller = identifyCaller({ authorization: "Bearer sk-opencode" });
    const store = await StateStore.open({ file, codes: ["model-a"] });

    store.bumpRequests("responses");
    store.markUsed("model-a", cached, 0.5, "responses");
    store.recordCallerRequest(caller, { ok: true, failovers: 0, model: "model-a", api: "responses" });
    store.addCallerUsage(caller, cached, "model-a", 0.5, "responses");

    store.bumpRequests("chat");
    store.markUsed("model-a", { ...cached, cachedPromptTokens: 0, cacheReported: false }, 0, "chat");
    store.recordCallerRequest(caller, { ok: true, failovers: 0, model: "model-a", api: "chat" });
    store.addCallerUsage(caller, cached, "model-a", 0, "chat");
    await store.flush();

    const reopened = await StateStore.open({ file, codes: ["model-a"] });
    const { apis } = reopened.stats;

    assert.equal(apis.responses.requests, 1);
    assert.equal(apis.responses.promptTokens, 30);
    assert.equal(apis.responses.cachedPromptTokens, 20);
    assert.equal(apis.responses.cacheTrackedPromptTokens, 30);
    assert.equal(apis.responses.completionTokens, 7);
    assert.equal(apis.responses.cost, 0.5);
    assert.equal(apis.responses.lastModel, "model-a");
    assert.ok(apis.responses.lastUsedAt);

    assert.equal(apis.chat.requests, 1);
    assert.equal(apis.chat.cachedPromptTokens, 0);
    assert.equal(apis.chat.cacheTrackedPromptTokens, 0);
    assert.equal(apis.chat.cost, 0);

    assert.equal(apis.completions.requests, 0);
    assert.equal(apis.embeddings.requests, 0);
    assert.equal(reopened.stats.requests, 2);

    const [record] = reopened.callers();
    assert.equal(record?.lastApi, "chat");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state files without protocol stats hydrate to empty counters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-api-stats-"));
  try {
    const file = join(dir, "state.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {},
        calibration: {},
        catalog: { fetchedAt: null, models: [] },
        callers: {
          legacy: {
            id: "legacy",
            label: "legacy",
            requests: 3,
            failures: 0,
            failovers: 0,
            promptTokens: 90,
            cachedPromptTokens: 0,
            cacheTrackedPromptTokens: 0,
            completionTokens: 12,
            cost: 0,
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            lastModel: "model-a",
          },
        },
        stats: {
          startedAt: "2026-01-01T00:00:00.000Z",
          requests: 3,
          failovers: 0,
          promptTokens: 90,
          cachedPromptTokens: 0,
          cacheTrackedPromptTokens: 0,
          completionTokens: 12,
          cost: 0,
        },
      }),
      "utf8",
    );

    const store = await StateStore.open({ file, codes: [] });
    assert.equal(store.stats.promptTokens, 90);
    assert.equal(store.stats.apis.chat.requests, 0);
    assert.equal(store.stats.apis.responses.promptTokens, 0);
    assert.equal(store.callers()[0]?.lastApi, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reset clears protocol counters but keeps the clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-api-stats-"));
  try {
    const file = join(dir, "state.json");
    const store = await StateStore.open({ file, codes: ["model-a"] });
    store.bumpRequests("responses");
    store.markUsed("model-a", cached, 0.5, "responses");
    store.resetUsage();

    assert.equal(store.stats.apis.responses.requests, 0);
    assert.equal(store.stats.apis.responses.promptTokens, 0);
    assert.equal(store.stats.apis.responses.cost, 0);
    assert.equal(store.stats.apis.responses.lastUsedAt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});