import type { ChainConfig } from "../config/schema.ts";
import type { ModelRecord } from "../types.ts";
import { isThrottled } from "./meter.ts";

/**
 * - auto：使用当前选中的模型，失败后按模型列表的顺序回退
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

export function resolveRoute(model: string | undefined, chain: ChainConfig): RouteResolution {
  const requested = (model ?? "").trim();
  if (requested === "" || requested === "auto") {
    return { mode: "auto", model: activeModel(chain) };
  }
  if (chain.models.includes(requested)) {
    return { mode: "direct", model: requested };
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
  /** 从这个模型开始回退（通常是当前选中的模型）。 */
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
  const rows: Array<{ code: string; record: ModelRecord; order: number; score: number }> = [];
  const retryMs = input.retryDeadAfterMs ?? 0;

  input.chain.models.forEach((code, order) => {
    const record = input.getRecord(code);
    if (!record) return;
    if (input.accepts && !input.accepts(code)) return;
    if (record.health === "invalid") return;
    if (record.health === "dead" && !isDeadRetryDue(record, input.now, retryMs)) return;
    let score = 0;
    if (isThrottled(record, input.now)) score += 2;
    rows.push({ code, record, order, score });
  });

  rows.sort((a, b) => a.score - b.score || a.order - b.order);

  if (input.start) {
    const position = rows.findIndex((row) => row.code === input.start);
    if (position > 0) rows.push(...rows.splice(0, position));
  }

  return rows.map((row) => ({ code: row.code, record: row.record }));
}
