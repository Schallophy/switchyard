import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, type GatewayConfig } from "../src/config/schema.ts";
import { ProviderClient, keyInfoFor, resolveProvider } from "../src/provider/client.ts";

function twoProviderConfig(): GatewayConfig {
  const config = defaultConfig();
  config.providers = [
    {
      id: "alpha",
      label: "Alpha",
      baseUrl: "https://alpha.example/v1",
      apiKeyEnv: "SWITCHYARD_TEST_ALPHA_KEY",
      apiKey: "",
      requestTimeoutMs: 1000,
      injectStreamUsage: true,
    },
    {
      id: "beta",
      label: "Beta",
      baseUrl: "https://beta.example/v1",
      apiKeyEnv: "SWITCHYARD_TEST_BETA_KEY",
      apiKey: "sk-beta-inline",
      requestTimeoutMs: 1000,
      injectStreamUsage: false,
    },
  ];
  config.defaultProvider = "beta";
  config.modelProviders = { "alpha-model": "alpha" };
  delete process.env.SWITCHYARD_TEST_ALPHA_KEY;
  delete process.env.SWITCHYARD_TEST_BETA_KEY;
  return config;
}

function stubFetch(): {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: unknown }) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("the default provider is used when no id is given", async () => {
  const stub = stubFetch();
  try {
    const client = new ProviderClient(twoProviderConfig);
    const outcome = await client.attempt("chat/completions", "m", { messages: [] });
    assert.equal(outcome.ok, true);
    assert.equal(stub.calls[0].url, "https://beta.example/v1/chat/completions");
    assert.equal(stub.calls[0].headers.authorization, "Bearer sk-beta-inline");
  } finally {
    stub.restore();
  }
});

test("an explicit provider id overrides the default", async () => {
  const stub = stubFetch();
  try {
    const config = twoProviderConfig();
    config.providers[0].apiKey = "sk-alpha-inline";
    const client = new ProviderClient(() => config);
    const outcome = await client.attempt("chat/completions", "alpha-model", { messages: [] }, { providerId: "alpha" });
    assert.equal(outcome.ok, true);
    assert.equal(stub.calls[0].url, "https://alpha.example/v1/chat/completions");
    assert.equal(stub.calls[0].headers.authorization, "Bearer sk-alpha-inline");
  } finally {
    stub.restore();
  }
});

test("an unknown provider id fails before any network call", async () => {
  const stub = stubFetch();
  try {
    const client = new ProviderClient(twoProviderConfig);
    const outcome = await client.attempt("chat/completions", "m", { messages: [] }, { providerId: "ghost" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.error.code, "switchyard.provider_unknown");
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("an provider without a key fails as switchyard.no_key without calling out", async () => {
  const stub = stubFetch();
  try {
    const client = new ProviderClient(twoProviderConfig);
    const outcome = await client.attempt("chat/completions", "m", { messages: [] }, { providerId: "alpha" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.error.code, "switchyard.no_key");
    assert.match(outcome.ok === false ? outcome.error.message : "", /alpha/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("key origin is reported per provider", () => {
  const config = twoProviderConfig();
  const alpha = resolveProvider(config, "alpha");
  const beta = resolveProvider(config, "beta");
  assert.ok(alpha && beta);
  assert.deepEqual(keyInfoFor(alpha), {
    id: "alpha",
    label: "Alpha",
    configured: false,
    source: "none",
    masked: "",
  });
  assert.equal(keyInfoFor(beta).source, "config");
  assert.equal(keyInfoFor(beta).configured, true);
});

test("listModels talks to the requested provider", async () => {
  const stub = stubFetch();
  try {
    const config = twoProviderConfig();
    config.providers[0].apiKey = "sk-alpha-inline";
    const client = new ProviderClient(() => config);
    const result = await client.listModels("alpha");
    assert.equal(result.ok, true);
    assert.equal(stub.calls[0].url, "https://alpha.example/v1/models");
  } finally {
    stub.restore();
  }
});
