import type { PriceTier, PricingConfig } from "../config/schema.ts";
import type { CostSplit } from "../types.ts";

function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const MINUTE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** 把时刻换算成指定时区的「当天第几分钟」，夏令时由 Intl 处理。 */
function minutesInZone(at: Date, timeZone: string): number {
  let formatter = MINUTE_FORMATTERS.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      // 配置层已校验时区；这里兜底，避免未校验的对象让请求直接抛错。
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    MINUTE_FORMATTERS.set(timeZone, formatter);
  }
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(at)) {
    if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/**
 * 按模型自己的 timezone 选价格档。精确匹配模型 code，找不到时回退到 "*"。
 * 未定义价格或时间段未覆盖时返回 null，此时不累计成本。
 */
export function priceTierAt(pricing: PricingConfig, model: string, at: Date): PriceTier | null {
  const entry = pricing.models[model] ?? pricing.models["*"];
  if (!entry) return null;

  const minutes = minutesInZone(at, entry.timezone?.trim() || "UTC");
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
export function usageCostParts(
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number },
  tier: PriceTier,
  unit: number,
): CostSplit {
  if (!(unit > 0)) return { input: 0, cachedInput: 0, output: 0, cacheSaved: 0 };
  const cached = Math.min(Math.max(0, usage.cachedPromptTokens), Math.max(0, usage.promptTokens));
  const fresh = Math.max(0, usage.promptTokens - cached);
  const output = Math.max(0, usage.completionTokens);
  const savedRate = Math.max(0, tier.input - tier.cachedInput);
  return {
    input: (fresh * tier.input) / unit,
    cachedInput: (cached * tier.cachedInput) / unit,
    output: (output * tier.output) / unit,
    cacheSaved: (cached * savedRate) / unit,
  };
}

export function usageCost(
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number },
  tier: PriceTier,
  unit: number,
): number {
  const parts = usageCostParts(usage, tier, unit);
  return parts.input + parts.cachedInput + parts.output;
}
