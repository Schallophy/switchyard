import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseConfigText, saveConfig } from "../src/config/load.ts";
import { defaultConfig } from "../src/config/schema.ts";
import type { NormalizedError } from "../src/types.ts";
import type { Logger } from "../src/util/log.ts";

test("config text tolerates comments and trailing commas", () => {
  const text = `{
    // 行注释
    "version": 1,
    /* 块注释 */
    "port": 8788,
    "chain": {
      "active": "a",
      "models": ["a", "b",],
    },
  }`;
  const parsed = parseConfigText(text) as Record<string, unknown>;
  assert.equal(parsed.port, 8788);
  assert.deepEqual((parsed.chain as Record<string, unknown>).models, ["a", "b"]);
});

test("comment markers inside strings are preserved", () => {
  const parsed = parseConfigText('{"baseUrl":"http://x//y","note":"/* keep */","q":"a,]"}' /* trailing */) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.baseUrl, "http://x//y");
  assert.equal(parsed.note, "/* keep */");
  assert.equal(parsed.q, "a,]");
});

test("broken json still fails with a config error", () => {
  assert.throws(() => parseConfigText("{ nope"), ConfigError);
  assert.throws(() => parseConfigText('{"a": 1,, }'), ConfigError);
});

test("a commented config file loads through loadConfig", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-config-"));
  const file = join(dir, "config.json");
  await saveConfig(file, defaultConfig());
  const raw = await readFile(file, "utf8");
  const commented = raw.replace('"version": 1,', '"version": 1, // hand written\n  "note": "ignored?" ,');
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, commented, "utf8");

  // 未知字段不报错，注释不会破坏解析
  const loaded = await loadConfig(file);
  assert.equal(loaded.created, false);
  assert.equal(loaded.config.port, 8788);
  assert.deepEqual(loaded.config.chain.models, []);
});

test("saved config is strict json and round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-config-"));
  const file = join(dir, "config.json");
  const config = defaultConfig();
  config.chain.models = ["dashscope/a", "dashscope/b"];
  config.chain.context = { window: 64_000, onOverflow: "passthrough" };
  config.server.maxBodyBytes = 1_048_576;
  config.log.level = "debug";
  await saveConfig(file, config);

  const text = await readFile(file, "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
  const saved = JSON.parse(text) as Record<string, any>;
  assert.ok(!("active" in saved.chain));
  const loaded = await loadConfig(file);
  assert.deepEqual(loaded.config.chain.models, ["dashscope/a", "dashscope/b"]);
  assert.deepEqual(loaded.config.chain.context, { window: 64_000, onOverflow: "passthrough" });
  assert.equal(loaded.config.server.maxBodyBytes, 1_048_576);
  assert.equal(loaded.config.log.level, "debug");
});

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  access: () => undefined,
  flush: async () => undefined,
  setLevel: () => undefined,
  setRotation: () => undefined,
  child: () => logger,
};

async function makeRuntime() {
  const { Runtime } = await import("../src/runtime.ts");
  const dir = await mkdtemp(join(tmpdir(), "switchyard-runtime-"));
  const config = defaultConfig();
  const runtime = await Runtime.create({
    configPath: join(dir, "config.json"),
    dataDir: dir,
    config,
    logger,
    warnings: [],
  });
  await saveConfig(join(dir, "config.json"), config);
  return { runtime, dir };
}

type SavedChain = { chain: { models: string[]; context: { window: number; onOverflow: string } } };

test("updating the model list dedupes and persists the order", async () => {
  const { runtime, dir } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b", "dashscope/a"]);

  assert.deepEqual(runtime.chainCodes(), ["dashscope/a", "dashscope/b"]);
  assert.equal(runtime.primaryModel(), "dashscope/a");

  const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as Record<string, any>;
  assert.deepEqual(saved.chain.models, ["dashscope/a", "dashscope/b"]);
  assert.ok(!("active" in saved.chain));
  await runtime.shutdown();
});

test("auto always starts from the first model in the list", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b"]);

  const calls: string[] = [];
  runtime.client.attempt = async (_path, model) => {
    calls.push(model);
    return { ok: true, response: new Response("{}"), latencyMs: 1, providerId: "dashscope" };
  };
  const body = { messages: [{ role: "user", content: "hi" }] };

  await runtime.requestThrough({ path: "chat/completions", model: "auto", body });
  assert.deepEqual(calls, ["a"]);

  await runtime.updateChainModels(["dashscope/b", "dashscope/a"]);
  calls.length = 0;
  await runtime.requestThrough({ path: "chat/completions", model: "auto", body });
  assert.deepEqual(calls, ["b"], "重排后 auto 从新的第一个模型开始");

  await runtime.shutdown();
});

test("removing the first model promotes the next one", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b", "dashscope/c"]);
  assert.equal(runtime.primaryModel(), "dashscope/a");

  await runtime.updateChainModels(["dashscope/b", "dashscope/c"]);
  assert.equal(runtime.primaryModel(), "dashscope/b");
  await runtime.shutdown();
});

test("the effective model walks the list from the top, skipping unavailable entries", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b", "dashscope/c"]);
  assert.equal(runtime.effectiveModel(), "dashscope/a");

  runtime.store.setHealth("dashscope/a", "dead", { reason: "额度已耗尽" });
  assert.equal(runtime.effectiveModel(), "dashscope/b");

  runtime.store.setHealth("dashscope/b", "invalid", { reason: "模型不存在" });
  assert.equal(runtime.effectiveModel(), "dashscope/c");

  runtime.store.setHealth("dashscope/c", "dead", { reason: "额度已耗尽" });
  assert.equal(runtime.effectiveModel(), null);

  await runtime.shutdown();
});

test("the effective model skips models in cooldown", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b", "dashscope/c"]);
  assert.equal(runtime.effectiveModel(), "dashscope/a");

  runtime.store.setHealth("dashscope/a", "alive", {
    reason: "限流",
    throttledUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(runtime.effectiveModel(), "dashscope/b", "冷却中的第一个模型让路");

  const calls: string[] = [];
  runtime.client.attempt = async (_path, model) => {
    calls.push(model);
    return { ok: true, response: new Response("{}"), latencyMs: 1, providerId: "dashscope" };
  };
  const body = { messages: [{ role: "user", content: "hi" }] };
  const cooling = await runtime.requestThrough({ path: "chat/completions", model: "auto", body });
  assert.equal(cooling.result.ok, true);
  assert.deepEqual(calls, ["b"], "auto 不会先打冷却中的模型");

  // 冷却结束后自动重新入链，并回到列表第一位
  runtime.store.setHealth("dashscope/a", "alive", {
    reason: null,
    throttledUntil: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.equal(runtime.effectiveModel(), "dashscope/a");
  const reheated = await runtime.requestThrough({ path: "chat/completions", model: "auto", body });
  assert.equal(reheated.result.ok, true);
  assert.deepEqual(calls, ["b", "a"]);

  await runtime.shutdown();
});

test("the current output follows the model that actually responded", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b"]);
  assert.equal(runtime.lastOutput(), null);

  const quota: NormalizedError = {
    kind: "quota_exhausted",
    label: "额度耗尽",
    status: 403,
    code: "AllocationQuota",
    message: "quota",
    fatal: false,
    markDead: true,
    markInvalid: false,
    retryable: true,
  };
  let failA = true;
  runtime.client.attempt = async (_path, model) => {
    if (model === "a" && failA) {
      failA = false;
      return { ok: false, error: quota, latencyMs: 1 };
    }
    return { ok: true, response: new Response("{}"), latencyMs: 1, providerId: "dashscope" };
  };

  const auto = await runtime.requestThrough({
    path: "chat/completions",
    model: "auto",
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(auto.result.ok, true);
  assert.equal(runtime.lastOutput()?.model, "dashscope/b", "记录真实承接的模型，而不是列表第一个");
  assert.equal(runtime.lastOutput()?.mode, "auto");
  assert.equal(runtime.lastOutput()?.requested, "auto");
  assert.equal(runtime.lastOutput()?.provider, "dashscope");

  const direct = await runtime.requestThrough({
    path: "chat/completions",
    model: "dashscope/a",
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(direct.result.ok, true);
  assert.equal(runtime.lastOutput()?.model, "dashscope/a");
  assert.equal(runtime.lastOutput()?.mode, "direct");
  assert.equal(runtime.lastOutput()?.requested, "dashscope/a");

  await runtime.shutdown();
});

test("a retried dead model that fails again goes back to waiting", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b"]);
  runtime.store.setHealth("dashscope/a", "dead", {
    reason: "额度已耗尽",
    checkedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
  });
  assert.equal(runtime.effectiveModel(), "dashscope/a", "过期失效模型会先被尝试");

  runtime.markSkipped("dashscope/a", {
    kind: "forbidden",
    label: "无权限",
    status: 403,
    code: "Forbidden",
    message: "forbidden",
    fatal: false,
    markDead: false,
    markInvalid: false,
    retryable: true,
  });
  assert.equal(runtime.effectiveModel(), "dashscope/b", "再次失败后重新计时，让出位置");
  await runtime.shutdown();
});

test("the context guard applies the learned calibration ratio", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a", "dashscope/b"]);
  await runtime.updateChainContext({ window: 1000 });

  const body = { messages: [{ role: "user", content: "word ".repeat(400) }] };
  // 让 a 学到 5 倍偏差：本地估算 400 左右，按系数会超过 1000
  runtime.store.observeCalibration("dashscope/a", false, 1000, 5000);

  const capped = await runtime.requestThrough({ path: "chat/completions", model: "dashscope/a", body });
  assert.equal(capped.result.ok, false);
  assert.equal(capped.result.error.code, "switchyard.context_length_exceeded");
  assert.equal(capped.sample?.hasTools, false);

  const uncapped = await runtime.requestThrough({ path: "chat/completions", model: "dashscope/b", body });
  assert.equal(uncapped.result.ok, false);
  if (!uncapped.result.ok) {
    assert.notEqual(uncapped.result.error.code, "switchyard.context_length_exceeded");
  }

  await runtime.shutdown();
});

test("markSuccess accumulates cost from the configured price tier", async () => {
  const { runtime } = await makeRuntime();
  await runtime.updateChainModels(["dashscope/a"]);
  runtime.config.pricing = {
    currency: "CNY",
    unit: 1_000_000,
    models: {
      "dashscope/a": {
        tiers: [
          { from: "00:00", to: "00:00", input: 2, cachedInput: 0.2, output: 8 },
        ],
      },
    },
  };

  runtime.markSuccess("dashscope/a", {
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cachedPromptTokens: 800,
    cacheReported: true,
  });

  assert.equal(runtime.store.stats.cost, 1_360 / 1_000_000);
  assert.equal(runtime.store.get("dashscope/a")?.cost, 1_360 / 1_000_000);
  assert.equal(runtime.store.callers()[0]?.cost, 1_360 / 1_000_000);

  // 没有价格配置的模型不计成本
  runtime.markSuccess("dashscope/b", {
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cachedPromptTokens: 0,
    cacheReported: true,
  });
  assert.equal(runtime.store.stats.cost, 1_360 / 1_000_000);

  await runtime.shutdown();
});

test("context updates validate the window and persist", async () => {
  const { runtime, dir } = await makeRuntime();
  const next = await runtime.updateChainContext({ window: 64_000, onOverflow: "passthrough" });

  assert.deepEqual(next, { window: 64_000, onOverflow: "passthrough" });
  const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as SavedChain;
  assert.deepEqual(saved.chain.context, { window: 64_000, onOverflow: "passthrough" });

  await assert.rejects(() => runtime.updateChainContext({ window: 999 }), /context\.window/);
  await runtime.shutdown();
});

test("a strict-json legacy config is migrated and written back on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-config-"));
  const file = join(dir, "config.json");
  const { writeFile } = await import("node:fs/promises");
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.chain = { active: "qwen3.8-27b", models: ["qwen3.8-27b"] };
  raw.modelProviders = { "qwen3.8-27b": "dashscope" };
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  const loaded = await loadConfig(file);
  assert.equal(loaded.persisted, true);
  assert.deepEqual(loaded.config.chain.models, ["dashscope/qwen3.8-27b"]);

  const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  assert.deepEqual(saved.chain.models, ["dashscope/qwen3.8-27b"]);
  assert.ok(!("active" in saved.chain));
  assert.ok(!("modelProviders" in saved));

  // 第二次启动不应再产生迁移提示
  const again = await loadConfig(file);
  assert.equal(again.persisted, false);
  assert.deepEqual(again.migrations, []);
});

test("a commented config is not rewritten, only reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-config-"));
  const file = join(dir, "config.json");
  const { writeFile } = await import("node:fs/promises");
  const text = `{
  // 手写注释不能丢
  "providers": [{ "id": "dashscope", "baseUrl": "https://example.com/v1" }],
  "chain": { "models": ["qwen3.8-27b"] },
  "modelProviders": { "qwen3.8-27b": "dashscope" },
}
`;
  await writeFile(file, text, "utf8");

  const loaded = await loadConfig(file);
  assert.equal(loaded.persisted, false);
  assert.ok(loaded.migrations.length > 0);
  assert.deepEqual(loaded.config.chain.models, ["dashscope/qwen3.8-27b"]);
  assert.equal(await readFile(file, "utf8"), text);
});

test("applying a reloaded config does not rewrite the file", async () => {
  const { runtime, dir } = await makeRuntime();
  const file = join(dir, "config.json");
  const before = await readFile(file, "utf8");
  const next = JSON.parse(JSON.stringify(runtime.config)) as typeof runtime.config;
  next.chain.context.window = 128_000;
  const warnings = await runtime.applyConfig(next, { persist: false });
  assert.deepEqual(warnings, []);
  assert.equal(runtime.config.chain.context.window, 128_000);
  assert.equal(await readFile(file, "utf8"), before);
  await runtime.shutdown();
});
