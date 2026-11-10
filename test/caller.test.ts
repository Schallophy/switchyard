import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identifyCaller, labelFor } from "../src/core/caller.ts";
import { StateStore } from "../src/store/state.ts";

test("readable caller tokens become readable labels", () => {
  assert.equal(labelFor("sk-opencode"), "opencode");
  assert.equal(labelFor("sk-cline"), "cline");
  assert.equal(labelFor("local"), "local");
});

test("long tokens are masked instead of stored verbatim", () => {
  const token = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
  const label = labelFor(token);
  assert.ok(label.includes("…"));
  assert.ok(!label.includes(token));
});

test("caller identities are stable and opaque", () => {
  const first = identifyCaller({ authorization: "Bearer sk-opencode" });
  const second = identifyCaller({ authorization: "Bearer sk-opencode" });
  const other = identifyCaller({ authorization: "Bearer sk-cline" });
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, other.id);
  assert.equal(first.label, "opencode");
});

test("missing or foreign authorization is anonymous", () => {
  assert.equal(identifyCaller({}).id, "anonymous");
  assert.equal(identifyCaller({ authorization: "Basic abc" }).id, "anonymous");
});

test("caller usage persists across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const caller = identifyCaller({ authorization: "Bearer sk-opencode" });
    const store = await StateStore.open({ file, codes: [] });
    store.recordCallerRequest(caller, { ok: true, failovers: 1, model: "model-a" });
    store.addCallerUsage(
      caller,
      {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedPromptTokens: 8,
        cacheReported: true,
      },
      "model-a",
    );
    store.recordCallerRequest(caller, { ok: false, failovers: 0, model: null });
    await store.flush();

    const reopened = await StateStore.open({ file, codes: [] });
    const [record] = reopened.callers();
    assert.equal(record?.label, "opencode");
    assert.equal(record?.requests, 2);
    assert.equal(record?.failures, 1);
    assert.equal(record?.failovers, 1);
    assert.equal(record?.promptTokens, 10);
    assert.equal(record?.cachedPromptTokens, 8);
    assert.equal(record?.cacheTrackedPromptTokens, 10);
    assert.equal(record?.completionTokens, 5);
    assert.equal(record?.lastModel, "model-a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache usage is counted for models and global stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const caller = identifyCaller({ authorization: "Bearer sk-opencode" });
    const store = await StateStore.open({ file, codes: ["model-a"] });
    const usage = {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 80,
      cacheReported: true,
    };
    store.markUsed("model-a", usage, 0.5);
    store.addCallerUsage(caller, usage, "model-a", 0.5);
    await store.flush();

    const reopened = await StateStore.open({ file, codes: ["model-a"] });
    const model = reopened.get("model-a");
    assert.equal(model?.promptTokens, 100);
    assert.equal(model?.cachedPromptTokens, 80);
    assert.equal(model?.cacheTrackedPromptTokens, 100);
    assert.equal(model?.cost, 0.5);
    assert.equal(reopened.stats.promptTokens, 100);
    assert.equal(reopened.stats.cachedPromptTokens, 80);
    assert.equal(reopened.stats.cacheTrackedPromptTokens, 100);
    assert.equal(reopened.stats.cost, 0.5);
    const [record] = reopened.callers();
    assert.equal(record?.cachedPromptTokens, 80);
    assert.equal(record?.cacheTrackedPromptTokens, 100);
    assert.equal(record?.cost, 0.5);

    reopened.recomputeCosts((model) => (model === "model-a" ? 2 : 0));
    assert.equal(reopened.stats.cost, 2);
    assert.equal(reopened.get("model-a")?.cost, 2);
    assert.equal(reopened.callers()[0]?.cost, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resetting usage clears counters but keeps model state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const caller = identifyCaller({ authorization: "Bearer sk-opencode" });
    const store = await StateStore.open({ file, codes: ["model-a"] });
    const usage = {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cachedPromptTokens: 80,
      cacheReported: true,
    };
    store.markUsed("model-a", usage, 1.25);
    store.recordCallerRequest(caller, { ok: true, failovers: 2, model: "model-a" });
    store.addCallerUsage(caller, usage, "model-a", 1.25);
    store.bumpRequests();
    store.bumpFailovers(2);
    store.resetUsage();
    await store.flush();

    const reopened = await StateStore.open({ file, codes: ["model-a"] });
    assert.equal(reopened.stats.requests, 0);
    assert.equal(reopened.stats.failovers, 0);
    assert.equal(reopened.stats.promptTokens, 0);
    assert.equal(reopened.stats.cachedPromptTokens, 0);
    assert.equal(reopened.stats.cacheTrackedPromptTokens, 0);
    assert.equal(reopened.stats.completionTokens, 0);
    assert.equal(reopened.stats.cost, 0);

    const model = reopened.get("model-a");
    assert.equal(model?.requests, 0);
    assert.equal(model?.failures, 0);
    assert.equal(model?.promptTokens, 0);
    assert.equal(model?.cachedPromptTokens, 0);
    assert.equal(model?.completionTokens, 0);
    assert.equal(model?.cost, 0);
    assert.equal(model?.health, "alive");
    assert.ok(model?.lastUsedAt);
    assert.deepEqual(reopened.callers(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("calibration learns provider ratios per model and tool usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const store = await StateStore.open({ file, codes: ["model-a"] });
    assert.equal(store.calibrationRatio("model-a", false), 1);

    store.observeCalibration("model-a", false, 1000, 1250);
    assert.equal(store.calibrationRatio("model-a", false), 1.25);
    // 工具样本还没出现时，先用纯文本系数兜底
    assert.equal(store.calibrationRatio("model-a", true), 1.25);

    store.observeCalibration("model-a", true, 2000, 6000);
    assert.equal(store.calibrationRatio("model-a", true), 3);
    assert.equal(store.calibrationRatio("model-a", false), 1.25);

    // 过短的请求受模板固定开销影响大，不参与校准
    store.observeCalibration("model-a", false, 20, 200);
    assert.equal(store.calibrationRatio("model-a", false), 1.25);

    // 新样本按权重靠近，而不是直接跳过去
    store.observeCalibration("model-a", false, 4000, 6000);
    const after = store.calibrationRatio("model-a", false);
    assert.ok(after > 1.25 && after < 1.5);
    await store.flush();

    const reopened = await StateStore.open({ file, codes: ["model-a"] });
    assert.equal(reopened.calibrationRatio("model-a", false), after);
    assert.equal(reopened.calibrationRatio("model-a", true), 3);
    assert.equal(reopened.calibrationRatio("model-b", false), 1);

    // 重置用量只清计数，不影响已学习的系数
    reopened.resetUsage();
    assert.equal(reopened.calibrationRatio("model-a", false), after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy state without cache fields still opens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: { "model-a": { code: "model-a", promptTokens: 50, completionTokens: 5 } },
        callers: {
          caller_a: { id: "caller_a", label: "old", promptTokens: 50, completionTokens: 5 },
        },
        catalog: { fetchedAt: null, models: [] },
        stats: { startedAt: "2026-01-01T00:00:00.000Z", requests: 1, promptTokens: 50, completionTokens: 5 },
      }),
      "utf8",
    );

    const store = await StateStore.open({ file, codes: ["model-a"] });
    assert.equal(store.stats.cachedPromptTokens, 0);
    assert.equal(store.stats.cacheTrackedPromptTokens, 0);
    assert.equal(store.stats.cost, 0);
    assert.equal(store.get("model-a")?.cachedPromptTokens, 0);
    assert.equal(store.callers()[0]?.cacheTrackedPromptTokens, 0);
    assert.equal(store.calibrationRatio("model-a", false), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog keeps provider-bound codes, including duplicate names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const store = await StateStore.open({ file, codes: [] });
    store.setCatalog([
      { id: "alpha-model", provider: "alpha" },
      { id: "beta-model", provider: "beta" },
      { id: "same-model", provider: "alpha" },
      { id: "same-model", provider: "beta" },
    ]);
    await store.flush();

    const reopened = await StateStore.open({ file, codes: [] });
    const byCode = new Map(reopened.catalog.models.map((entry) => [entry.code, entry.provider]));
    assert.equal(byCode.get("alpha/alpha-model"), "alpha");
    assert.equal(byCode.get("beta/beta-model"), "beta");
    assert.equal(byCode.get("alpha/same-model"), "alpha");
    assert.equal(byCode.get("beta/same-model"), "beta");
    assert.equal(reopened.catalog.models.length, 4);
    assert.equal(reopened.catalog.models.find((entry) => entry.code === "beta/same-model")?.upstream, "same-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a legacy catalog entry without code is rebuilt from id + provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const seed = await StateStore.open({ file, codes: [] });
    await seed.flush();

    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
    raw.catalog = {
      fetchedAt: null,
      models: [{ id: "legacy-model", family: "Other", provider: "alpha" }],
    };
    await writeFile(file, JSON.stringify(raw), "utf8");

    const reopened = await StateStore.open({ file, codes: [] });
    const entry = reopened.catalog.models[0];
    assert.equal(entry?.code, "alpha/legacy-model");
    assert.equal(entry?.upstream, "legacy-model");
    assert.equal(entry?.provider, "alpha");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy bare model records merge into provider-bound codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-state-"));
  try {
    const file = join(dir, "state.json");
    const seed = await StateStore.open({ file, codes: [] });
    seed.markUsed(
      "old-model",
      { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0, cacheReported: true },
      0.25,
    );
    seed.observeCalibration("old-model", false, 1000, 1200);
    await seed.flush();

    const reopened = await StateStore.open({ file, codes: [] });
    reopened.migrateModelCodes((code) => (code === "old-model" ? "qianwenai/old-model" : null));

    const record = reopened.get("qianwenai/old-model");
    assert.equal(reopened.get("old-model"), undefined);
    assert.equal(record?.requests, 1);
    assert.equal(record?.promptTokens, 10);
    assert.equal(record?.cost, 0.25);
    assert.equal(reopened.calibrationRatio("qianwenai/old-model", false), 1.2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
