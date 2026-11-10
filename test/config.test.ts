import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, normalizeConfig } from "../src/config/schema.ts";

test("the shipped defaults validate cleanly", () => {
  const result = normalizeConfig(defaultConfig());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.config.chain.models, []);
  assert.equal(result.config.chain.active, "");
});

test("active defaults to the first model", () => {
  const config = defaultConfig();
  config.chain.models = ["a", "b"];
  const result = normalizeConfig(config);
  assert.equal(result.ok, true);
  assert.equal(result.config.chain.active, "a");
});

test("an active model outside the list falls back to the first model", () => {
  const config = defaultConfig();
  config.chain.models = ["a", "b"];
  config.chain.active = "c";
  const result = normalizeConfig(config);
  assert.equal(result.ok, true);
  assert.equal(result.config.chain.active, "a");
  assert.ok(result.warnings.some((warning) => warning.includes("当前模型")));
});

test("invalid ports and urls are rejected", () => {
  const config = defaultConfig();
  config.port = 99_999;
  config.providers[0].baseUrl = "ftp://example.com";
  const result = normalizeConfig(config);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test("the model list may start empty and gets a warning", () => {
  const config = defaultConfig();
  config.chain.models = [];
  const result = normalizeConfig(config);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.chain.models, []);
  assert.ok(result.warnings.some((warning) => warning.includes("还没有任何模型")));
});

test("duplicate models inside the list are deduplicated", () => {
  const config = defaultConfig();
  config.chain.models = ["a", "a", "b"];
  const result = normalizeConfig(config);
  assert.deepEqual(result.config.chain.models, ["a", "b"]);
  assert.equal(result.config.chain.active, "a");
});

test("a legacy chains[] config migrates to a single model list", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.chain;
  raw.chains = [
    { name: "text", purpose: "tools", models: ["a"], context: { window: 64_000, onOverflow: "passthrough" } },
    { name: "main", purpose: "default", models: ["b", "c"], context: { window: 128_000, onOverflow: "reject" } },
  ];
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.chain.models, ["b", "c"]);
  assert.equal(result.config.chain.active, "b");
  assert.deepEqual(result.config.chain.context, { window: 128_000, onOverflow: "reject" });
  assert.ok(result.warnings.some((warning) => warning.includes("合并")));
});

test("context windows default to 256K and accept overrides", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.chain.context;
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.chain.context, { window: 256_000, onOverflow: "reject" });

  raw.chain.context = { window: 64_000, onOverflow: "passthrough" };
  const overridden = normalizeConfig(raw);
  assert.deepEqual(overridden.config.chain.context, { window: 64_000, onOverflow: "passthrough" });
});

test("dead models retry after a day by default and the window is configurable", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.chain.retryDeadAfterMinutes;
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.equal(result.config.chain.retryDeadAfterMinutes, 1_440);

  raw.chain.retryDeadAfterMinutes = 0;
  assert.equal(normalizeConfig(raw).config.chain.retryDeadAfterMinutes, 0);

  raw.chain.retryDeadAfterMinutes = 10_080;
  assert.equal(normalizeConfig(raw).config.chain.retryDeadAfterMinutes, 10_080);

  raw.chain.retryDeadAfterMinutes = -1;
  assert.equal(normalizeConfig(raw).ok, false);
});

test("invalid context settings are rejected", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.chain.context = { window: 999, onOverflow: "truncate" };
  const result = normalizeConfig(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("context.window")));
  assert.ok(result.errors.some((error) => error.includes("onOverflow")));
});

test("a non-object context block is rejected", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.chain.context = "256k";
  const result = normalizeConfig(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("context")));
});

test("env-provided api key names survive normalization", () => {
  const config = defaultConfig();
  config.providers[0].apiKeyEnv = "DASHSCOPE_API_KEY";
  const result = normalizeConfig(config);
  assert.equal(result.config.providers[0].apiKeyEnv, "DASHSCOPE_API_KEY");
});

test("chain models default to chat capability when modelApis is absent", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.chain.models = ["qwen3.8-flash", "kimi-k3"];
  delete raw.modelApis;
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.modelApis["qwen3.8-flash"], ["chat"]);
  assert.deepEqual(result.config.modelApis["kimi-k3"], ["chat"]);
});

test("modelApis entries are deduplicated and ordered canonically", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.modelApis["kimi-k3.1-pro"] = ["responses", "chat", "responses"];
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.modelApis["kimi-k3.1-pro"], ["chat", "responses"]);
});

test("unknown or empty modelApis entries are rejected", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.chain.models = ["kimi-k3.1-pro", "qwen3.8-27b"];
  raw.modelApis["kimi-k3.1-pro"] = ["telepathy"];
  raw.modelApis["qwen3.8-27b"] = [];
  const result = normalizeConfig(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("telepathy")));
  assert.ok(result.errors.some((error) => error.includes("qwen3.8-27b")));
  assert.deepEqual(result.config.modelApis["qwen3.8-27b"], ["chat"]);
});

test("ui / server / log blocks fall back to safe defaults", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.ui;
  delete raw.server;
  delete raw.log;
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.ui, { enabled: true });
  assert.equal(result.config.server.maxBodyBytes, 16 * 1024 * 1024);
  assert.equal(result.config.server.cors, true);
  assert.deepEqual(result.config.log, { level: "info", file: "" });
});

test("invalid server / ui / log settings are rejected", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.server = { maxBodyBytes: 12 };
  raw.ui = { enabled: "yes" };
  raw.log = { level: "verbose" };
  const result = normalizeConfig(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("server.maxBodyBytes")));
  assert.ok(result.errors.some((error) => error.includes("log.level")));
  // ui.enabled 不是布尔值时回落到默认值，而不是把服务拖垮
  assert.equal(result.config.ui.enabled, true);
});

test("a legacy single upstream block is migrated into providers", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.providers;
  delete raw.defaultProvider;
  raw.upstream = {
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "EXAMPLE_KEY",
    apiKey: "sk-inline",
    requestTimeoutMs: 5000,
    injectStreamUsage: false,
  };
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes("迁移")));
  assert.equal(result.config.providers.length, 1);
  assert.equal(result.config.providers[0].id, "default");
  assert.equal(result.config.providers[0].baseUrl, "https://api.example.com/v1");
  assert.equal(result.config.providers[0].apiKey, "sk-inline");
  assert.equal(result.config.defaultProvider, "default");
});

test("multiple providers keep their order and ids", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.providers = [
    { id: "dashscope", baseUrl: "https://dashscope.example/v1", apiKeyEnv: "A" },
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "B" },
  ];
  raw.defaultProvider = "openai";
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.providers.map((item) => item.id), ["dashscope", "openai"]);
  assert.equal(result.config.providers[1].label, "OpenAI");
  assert.equal(result.config.defaultProvider, "openai");
});

test("duplicate or malformed provider ids are rejected", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.providers = [
    { id: "a", baseUrl: "https://a.example/v1" },
    { id: "a", baseUrl: "https://b.example/v1" },
    { id: "Bad Id", baseUrl: "https://c.example/v1" },
  ];
  const result = normalizeConfig(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("重复")));
  assert.ok(result.errors.some((error) => error.includes("id 只能使用")));
});

test("an unknown defaultProvider falls back to the first one", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.defaultProvider = "nope";
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.equal(result.config.defaultProvider, result.config.providers[0].id);
  assert.ok(result.warnings.some((warning) => warning.includes("defaultProvider")));
});

test("modelProviders must point at a known provider", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.modelProviders = { "qwen3.8-27b": "dashscope" };
  const ok = normalizeConfig(raw);
  assert.equal(ok.ok, true);
  assert.equal(ok.config.modelProviders["qwen3.8-27b"], "dashscope");

  raw.modelProviders = { "qwen3.8-27b": "nowhere" };
  const bad = normalizeConfig(raw);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.includes("不存在的提供商")));
});

test("the intermediate modelUpstreams key is migrated to modelProviders", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  delete raw.modelProviders;
  raw.modelUpstreams = { "qwen3.8-27b": "dashscope" };
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes("modelUpstreams")));
  assert.equal(result.config.modelProviders["qwen3.8-27b"], "dashscope");
});

test("the intermediate upstreams array is migrated to providers", () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  const providers = raw.providers;
  delete raw.providers;
  delete raw.defaultProvider;
  raw.upstreams = providers;
  raw.defaultUpstream = providers[0].id;
  const result = normalizeConfig(raw);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes("upstreams")));
  assert.deepEqual(result.config.providers.map((item) => item.id), providers.map((item: any) => item.id));
  assert.equal(result.config.defaultProvider, providers[0].id);
});
