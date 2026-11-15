import assert from "node:assert/strict";
import test from "node:test";
import type { PricingConfig } from "../src/config/schema.ts";
import { priceTierAt, usageCost, usageCostParts } from "../src/core/pricing.ts";
import type { Usage } from "../src/types.ts";

const pricing: PricingConfig = {
  currency: "CNY",
  unit: 1_000_000,
  models: {
    model: {
      timezone: "Asia/Shanghai",
      tiers: [
        { from: "08:00", to: "22:00", input: 2, cachedInput: 0.2, output: 8 },
        { from: "22:00", to: "08:00", input: 1, cachedInput: 0.1, output: 4 },
      ],
    },
  },
};

function at(hour: number, minute: number): Date {
  // Asia/Shanghai 常年 UTC+8，这里构造对应的 UTC 时刻。
  return new Date(Date.UTC(2026, 10, 11, hour - 8, minute));
}

test("picks the peak tier inside 08:00–22:00", () => {
  assert.equal(priceTierAt(pricing, "model", at(8, 0))?.input, 2);
  assert.equal(priceTierAt(pricing, "model", at(21, 59))?.input, 2);
});

test("picks the off-peak tier across midnight", () => {
  assert.equal(priceTierAt(pricing, "model", at(22, 0))?.input, 1);
  assert.equal(priceTierAt(pricing, "model", at(23, 59))?.input, 1);
  assert.equal(priceTierAt(pricing, "model", at(0, 0))?.input, 1);
  assert.equal(priceTierAt(pricing, "model", at(7, 59))?.input, 1);
});

test("price tiers follow the configured timezone", () => {
  const instant = new Date("2026-11-11T00:30:00Z"); // 上海 08:30，UTC 00:30
  const utc: PricingConfig = {
    ...pricing,
    models: { model: { ...pricing.models.model!, timezone: "UTC" } },
  };
  assert.equal(priceTierAt(pricing, "model", instant)?.input, 2);
  assert.equal(priceTierAt(utc, "model", instant)?.input, 1);
});

test("price tiers follow daylight saving transitions", () => {
  const newYork: PricingConfig = {
    ...pricing,
    models: { model: { ...pricing.models.model!, timezone: "America/New_York" } },
  };
  // 2026-03-08 07:00Z 进入夏令时：06:30Z 仍是 01:30 EST，12:30Z 已是 08:30 EDT。
  assert.equal(priceTierAt(newYork, "model", new Date("2026-03-08T06:30:00Z"))?.input, 1);
  assert.equal(priceTierAt(newYork, "model", new Date("2026-03-08T12:30:00Z"))?.input, 2);
});

test("an unknown model falls back to the wildcard entry", () => {
  const withWildcard: PricingConfig = {
    ...pricing,
    models: { "*": pricing.models.model! },
  };
  assert.equal(priceTierAt(withWildcard, "other", at(9, 0))?.input, 2);
});

test("no pricing or no matching window yields null", () => {
  assert.equal(
    priceTierAt({ currency: "CNY", unit: 1_000_000, models: {} }, "model", at(9, 0)),
    null,
  );
  const gapped: PricingConfig = {
    currency: "CNY",
    unit: 1_000_000,
    models: {
      model: {
        timezone: "Asia/Shanghai",
        tiers: [{ from: "08:00", to: "22:00", input: 2, cachedInput: 0.2, output: 8 }],
      },
    },
  };
  assert.equal(priceTierAt(gapped, "model", at(23, 0)), null);
});

test("a tier with identical from/to covers the whole day", () => {
  const allDay: PricingConfig = {
    currency: "CNY",
    unit: 1_000_000,
    models: {
      model: {
        timezone: "Asia/Shanghai",
        tiers: [{ from: "00:00", to: "00:00", input: 2, cachedInput: 0.2, output: 8 }],
      },
    },
  };
  assert.equal(priceTierAt(allDay, "model", at(3, 0))?.output, 8);
  assert.equal(priceTierAt(allDay, "model", at(15, 0))?.output, 8);
});

test("cost splits fresh input, cache hits and output", () => {
  const usage: Usage = {
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cachedPromptTokens: 800,
    cacheReported: true,
  };
  const tier = { from: "00:00", to: "00:00", input: 2, cachedInput: 0.2, output: 8 };
  assert.equal(usageCost(usage, tier, 1_000_000), 1_360 / 1_000_000);
});

test("cost ignores impossible cache counts", () => {
  const usage: Usage = {
    promptTokens: 100,
    completionTokens: 0,
    totalTokens: 100,
    cachedPromptTokens: 500,
    cacheReported: true,
  };
  const tier = { from: "00:00", to: "00:00", input: 2, cachedInput: 1, output: 8 };
  assert.equal(usageCost(usage, tier, 1_000_000), (100 * 1) / 1_000_000);
});

test("cost parts split input, cache hits, output and savings", () => {
  const usage: Usage = {
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cachedPromptTokens: 800,
    cacheReported: true,
  };
  const tier = { from: "00:00", to: "00:00", input: 2, cachedInput: 0.2, output: 8 };
  const parts = usageCostParts(usage, tier, 1_000_000);

  assert.equal(parts.input, (200 * 2) / 1_000_000);
  assert.equal(parts.cachedInput, (800 * 0.2) / 1_000_000);
  assert.equal(parts.output, (100 * 8) / 1_000_000);
  assert.equal(parts.cacheSaved, (800 * 1.8) / 1_000_000);
  assert.equal(parts.input + parts.cachedInput + parts.output, usageCost(usage, tier, 1_000_000));
});

test("cost parts clamp cache counts and reject a non-positive unit", () => {
  const tier = { from: "00:00", to: "00:00", input: 2, cachedInput: 1, output: 8 };
  const clamped = usageCostParts(
    { promptTokens: 100, cachedPromptTokens: 500, completionTokens: 0 },
    tier,
    1_000_000,
  );
  assert.equal(clamped.input, 0);
  assert.equal(clamped.cachedInput, (100 * 1) / 1_000_000);
  assert.equal(clamped.cacheSaved, (100 * 1) / 1_000_000);

  const invalid = usageCostParts(
    { promptTokens: 100, cachedPromptTokens: 50, completionTokens: 10 },
    tier,
    0,
  );
  assert.deepEqual(invalid, { input: 0, cachedInput: 0, output: 0, cacheSaved: 0 });
});