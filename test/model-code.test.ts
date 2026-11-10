import assert from "node:assert/strict";
import test from "node:test";
import { joinModelCode, splitModelCode } from "../src/core/model-code.ts";
import { resolveRoute } from "../src/core/selection.ts";
import type { ChainConfig } from "../src/config/schema.ts";

const providers = [{ id: "qianwenai" }, { id: "dashscope" }];

const chain: ChainConfig = {
  active: "qianwenai/vanchin/deepseek-v4.1-flash-1017",
  models: ["qianwenai/vanchin/deepseek-v4.1-flash-1017", "dashscope/qwen3.8-max"],
  context: { window: 100_000, onOverflow: "reject" },
  retryDeadAfterMinutes: 1_440,
};

test("model codes split on the provider id prefix", () => {
  assert.deepEqual(splitModelCode("qianwenai/qwen3.8-max", providers), {
    provider: "qianwenai",
    upstream: "qwen3.8-max",
  });
  // 上游模型名本身可以带斜杠
  assert.deepEqual(splitModelCode("dashscope/vanchin/deepseek-v4.1-flash", providers), {
    provider: "dashscope",
    upstream: "vanchin/deepseek-v4.1-flash",
  });
});

test("model codes need a known provider prefix", () => {
  assert.equal(splitModelCode("qwen3.8-max", providers), null);
  assert.equal(splitModelCode("ghost/qwen3.8-max", providers), null);
  assert.equal(splitModelCode("qianwenai/", providers), null);
});

test("joinModelCode builds the same shape", () => {
  assert.equal(joinModelCode("qianwenai", "qwen3.8-max"), "qianwenai/qwen3.8-max");
  assert.equal(joinModelCode("qianwenai", "/qwen3.8-max"), "qianwenai/qwen3.8-max");
});

test("a unique bare model name still routes to its bound model", () => {
  const route = resolveRoute("qwen3.8-max", chain, providers);
  assert.deepEqual(route, { mode: "direct", model: "dashscope/qwen3.8-max" });
});

test("an ambiguous bare model name falls through to passthrough", () => {
  const both: ChainConfig = {
    ...chain,
    models: ["qianwenai/shared-model", "dashscope/shared-model"],
  };
  assert.deepEqual(resolveRoute("shared-model", both, providers), {
    mode: "passthrough",
    model: "shared-model",
  });
});

test("full codes route directly and auto picks the active model", () => {
  assert.deepEqual(resolveRoute("dashscope/qwen3.8-max", chain, providers), {
    mode: "direct",
    model: "dashscope/qwen3.8-max",
  });
  assert.deepEqual(resolveRoute("auto", chain, providers), {
    mode: "auto",
    model: "qianwenai/vanchin/deepseek-v4.1-flash-1017",
  });
});