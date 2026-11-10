import assert from "node:assert/strict";
import test from "node:test";
import { classifyHttpError, classifyNetworkError, parseErrorPayload } from "../src/core/classify.ts";

test("403 FreeTierOnly is classified as a dead model, not a fatal error", () => {
  const payload = parseErrorPayload(
    JSON.stringify({ error: { code: "AllocationQuota.FreeTierOnly", message: "The free tier resource is exhausted." } }),
  );
  const error = classifyHttpError(403, payload);
  assert.equal(error.kind, "quota_exhausted");
  assert.equal(error.markDead, true);
  assert.equal(error.fatal, false);
  assert.equal(error.code, "AllocationQuota.FreeTierOnly");
});

test("403 with a Chinese exhausted message is also treated as dead", () => {
  const error = classifyHttpError(403, { code: null, message: "当前模型的免费额度已经用尽" });
  assert.equal(error.kind, "quota_exhausted");
  assert.equal(error.markDead, true);
});

test("429 throttling never poisons model health", () => {
  const error = classifyHttpError(429, {
    code: "Throttling.AllocationQuota",
    message: "Requests rate limit exceeded, please try again later.",
  });
  assert.equal(error.kind, "throttled");
  assert.equal(error.markDead, false);
  assert.equal(error.markInvalid, false);
  assert.equal(error.fatal, false);
});

test("404 ModelNotFound invalidates only that model", () => {
  const error = classifyHttpError(404, { code: "ModelNotFound", message: "The model does not exist." });
  assert.equal(error.kind, "model_invalid");
  assert.equal(error.markInvalid, true);
  assert.equal(error.fatal, false);
});

test("a bare 404 is treated as a wiring problem, not a model problem", () => {
  const error = classifyHttpError(404, { code: null, message: "Cannot GET /v1/chat/completions" });
  assert.equal(error.kind, "provider");
  assert.equal(error.markInvalid, false);
});

test("401 stops failover", () => {
  const error = classifyHttpError(401, { code: "InvalidApiKey", message: "Invalid API-key provided." });
  assert.equal(error.kind, "auth");
  assert.equal(error.fatal, true);
});

test("403 AccessDenied skips the model without marking it dead", () => {
  const error = classifyHttpError(403, { code: "AccessDenied", message: "User is not authorized to access this model." });
  assert.equal(error.kind, "forbidden");
  assert.equal(error.markDead, false);
  assert.equal(error.fatal, false);
});

test("400 InvalidParameter can fail over to another model", () => {
  const error = classifyHttpError(400, { code: "InvalidParameter", message: "enable_thinking is not supported." });
  assert.equal(error.kind, "bad_request");
  assert.equal(error.fatal, false);
});

test("5xx is a retryable provider failure", () => {
  const error = classifyHttpError(503, { code: null, message: "service unavailable" });
  assert.equal(error.kind, "provider");
  assert.equal(error.retryable, true);
});

test("network and timeout errors are retryable; client aborts are fatal", () => {
  assert.equal(classifyNetworkError(new Error("ECONNRESET"), false, false).kind, "network");
  assert.equal(classifyNetworkError(new Error("aborted"), true, false).kind, "timeout");
  assert.equal(classifyNetworkError(new Error("aborted"), false, true).kind, "aborted");
  assert.equal(classifyNetworkError(new Error("aborted"), false, true).fatal, true);
});

test("payload parser handles both nested and flat error shapes", () => {
  const nested = parseErrorPayload('{"error":{"message":"boom","code":"X"}}');
  assert.equal(nested.code, "X");
  assert.equal(nested.message, "boom");

  const flat = parseErrorPayload('{"code":"Y","message":"bang"}');
  assert.equal(flat.code, "Y");
  assert.equal(flat.message, "bang");

  const plain = parseErrorPayload("gateway timeout");
  assert.equal(plain.code, null);
  assert.equal(plain.message, "gateway timeout");
});
