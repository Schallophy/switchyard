import assert from "node:assert/strict";
import test from "node:test";
import type { PricingConfig } from "../src/config/schema.ts";
import { priceTierAt, usageCost } from "../src/core/pricing.ts";
import type { Usage } from "../src/types.ts";

const pricing: PricingConfig = {
  currency: "CNY",
  unit: 1_000_000,
  models: {
    model: {
      tiers: [
        { from: "08:00", to: "22:00", input: 2, cachedInput: 0.2, output: 8 },
        { from: "22:00", to: "08:00", input: 1, cachedInput: 0.1, output: 4 },
      ],
    },
  },
};

function at(hour: number, minute: number): Date {
  return new Date(2026, 10, 11, hour, minute, 0);
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

test("an unknown model falls back to the wildcard entry", () => {
  const withWildcard: PricingConfig = {
    ...pricing,
    models: { "*": pricing.models.model! },
  };
  assert.equal(priceTierAt(withWildcard, "other", at(9, 0))?.input, 2);
});

test("no pricing or no matching window yields null", () => {
  assert.equal(priceTierAt({ currency: "CNY", unit: 1_000_000, models: {} }, "model", at(9, 0)), null);
  const gapped: PricingConfig = {
    currency: "CNY",
    unit: 1_000_000,
    models: { model: { tiers: [{ from: "08:00", to: "22:00", input: 2, cachedInput: 0.2, output: 8 }] } },
  };
  assert.equal(priceTierAt(gapped, "model", at(23, 0)), null);
});

test("a tier with identical from/to covers the whole day", () => {
  const allDay: PricingConfig = {
    currency: "CNY",
    unit: 1_000_000,
    models: { model: { tiers: [{ from: "00:00", to: "00:00", input: 2, cachedInput: 0.2, output: 8 }] } },
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