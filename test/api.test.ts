import assert from "node:assert/strict";
import test from "node:test";
import type { ModelApiMap } from "../src/config/schema.ts";
import { apiKindForPath, apisFor, supportsApi } from "../src/core/api.ts";

test("endpoint paths map to their API kinds", () => {
  assert.equal(apiKindForPath("chat/completions"), "chat");
  assert.equal(apiKindForPath("completions"), "completions");
  assert.equal(apiKindForPath("responses"), "responses");
  assert.equal(apiKindForPath("embeddings"), "embeddings");
});

test("unknown paths fall back to chat", () => {
  assert.equal(apiKindForPath("audio/speech"), "chat");
  assert.equal(apiKindForPath(""), "chat");
});

test("undeclared models are treated as chat-only", () => {
  const map: ModelApiMap = { declared: ["chat", "responses"] };
  assert.deepEqual(apisFor(map, "declared"), ["chat", "responses"]);
  assert.deepEqual(apisFor(map, "unknown"), ["chat"]);
  assert.equal(supportsApi(map, "unknown", "chat"), true);
  assert.equal(supportsApi(map, "unknown", "responses"), false);
});

test("declared capabilities are honored exactly", () => {
  const map: ModelApiMap = { deep: ["responses"], embed: ["embeddings"] };
  assert.equal(supportsApi(map, "deep", "responses"), true);
  assert.equal(supportsApi(map, "deep", "chat"), false);
  assert.equal(supportsApi(map, "embed", "embeddings"), true);
  assert.equal(supportsApi(map, "embed", "responses"), false);
});
