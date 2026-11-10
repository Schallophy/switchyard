import type { PriceTier, PricingConfig } from "../config/schema.ts";

function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * 按本地时间选价格档。精确匹配模型 code，找不到时回退到 "*"。
 * 未定义价格或时间段未覆盖时返回 null，此时不累计成本。
 */
export function priceTierAt(pricing: PricingConfig, model: string, at: Date): PriceTier | null {
  const entry = pricing.models[model] ?? pricing.models["*"];
  if (!entry) return null;

  const minutes = at.getHours() * 60 + at.getMinutes();
  for (const tier of entry.tiers) {
    const from = clockMinutes(tier.from);
    const to = clockMinutes(tier.to);
    if (from === null || to === null) continue;
    if (from === to) return tier;
    if (from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to) return tier;
  }
  return null;
}

/** 命中缓存的部分按 cachedInput 计价，其余输入按 input，输出按 output。 */
export function usageCost(
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number },
  tier: PriceTier,
  unit: number,
): number {
  if (!(unit > 0)) return 0;
  const cached = Math.min(Math.max(0, usage.cachedPromptTokens), Math.max(0, usage.promptTokens));
  const fresh = Math.max(0, usage.promptTokens - cached);
  const output = Math.max(0, usage.completionTokens);
  return (fresh * tier.input + cached * tier.cachedInput + output * tier.output) / unit;
}