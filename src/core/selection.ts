import type { ChainConfig } from "../config/schema.ts";
import type { ModelRecord } from "../types.ts";
import { isThrottled } from "./meter.ts";
import { splitModelCode } from "./model-code.ts";

/**
 * - auto：从首选模型开始，失败后按模型列表的顺序回退
 * - direct：客户端点名了列表里的模型，直接发给它，不做回退
 * - passthrough：列表里没有这个模型，原样透传
 */
export type RouteMode = "auto" | "direct" | "passthrough";

export interface RouteResolution {
  mode: RouteMode;
  /** auto 时是当前选中的模型，direct / passthrough 时是客户端点名的模型。 */
  model: string | null;
}

export function activeModel(chain: ChainConfig): string | null {
  if (chain.active && chain.models.includes(chain.active)) return chain.active;
  return chain.models[0] ?? null;
}

export function resolveRoute(
  model: string | undefined,
  chain: ChainConfig,
  providers?: Array<{ id: string }>,
): RouteResolution {
  const requested = (model ?? "").trim();
  if (requested === "" || requested === "auto") {
    return { mode: "auto", model: activeModel(chain) };
  }
  if (chain.models.includes(requested)) {
    return { mode: "direct", model: requested };
  }
  // 裸模型名兼容：只在上游模型名唯一时命中，避免同名模型绑在不同提供商时选错
  if (providers && providers.length > 0) {
    const matches = chain.models.filter((code) => splitModelCode(code, providers)?.upstream === requested);
    if (matches.length === 1 && matches[0]) return { mode: "direct", model: matches[0] };
  }
  return { mode: "passthrough", model: requested };
}

export interface Candidate {
  code: string;
  record: ModelRecord;
}

export interface SelectionInput {
  chain: ChainConfig;
  getRecord: (code: string) => ModelRecord | undefined;
  now: number;
  /** 从这个模型开始回退（通常是首选模型）；不在列表里时按原顺序。 */
  start?: string | null;
  accepts?: (code: string) => boolean;
  /** dead 模型经过多少毫秒后重新参与选路；0 或省略表示不自动重试。 */
  retryDeadAfterMs?: number;
}

/** dead 模型是否已过自动重试时间（checkedAt 是标记失效的时刻）。没有时间戳时保持失效，等待手动重置。 */
export function isDeadRetryDue(record: ModelRecord, now: number, retryMs: number): boolean {
  if (record.health !== "dead" || retryMs <= 0) return false;
  const at = record.checkedAt ? Date.parse(record.checkedAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return now - at >= retryMs;
}

export function selectCandidates(input: SelectionInput): Candidate[] {
  const candidates: Candidate[] = [];
  const retryMs = input.retryDeadAfterMs ?? 0;

  for (const code of rotateFrom(input.chain.models, input.start)) {
    const record = input.getRecord(code);
    if (!record) continue;
    if (input.accepts && !input.accepts(code)) continue;
    if (record.health === "invalid") continue;
    if (record.health === "dead" && !isDeadRetryDue(record, input.now, retryMs)) continue;
    // 冷却中的模型暂时退出链路，冷却到期后自动重新参与
    if (isThrottled(record, input.now)) continue;
    candidates.push({ code, record });
  }

  return candidates;
}

/** 从 start 起把列表轮转一圈；start 不在列表里时保持原顺序。 */
function rotateFrom(models: string[], start?: string | null): string[] {
  if (!start) return models;
  const position = models.indexOf(start);
  if (position <= 0) return models;
  return [...models.slice(position), ...models.slice(0, position)];
}
