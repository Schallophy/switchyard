export type ModelHealth = "unknown" | "alive" | "dead" | "invalid";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** promptTokens 中命中上下文缓存的部分。 */
  cachedPromptTokens: number;
  /** 提供商是否返回了缓存明细；用于区分「0 命中」和「未上报」。 */
  cacheReported: boolean;
}

/** 一次请求的成本构成；三项相加就是该次请求的成本。 */
export interface CostSplit {
  /** 未命中缓存的输入成本。 */
  input: number;
  /** 命中缓存的输入成本。 */
  cachedInput: number;
  /** 输出成本。 */
  output: number;
  /** 缓存相对全价输入省下的金额。 */
  cacheSaved: number;
}

export interface CostBreakdown extends CostSplit {
  /** 历史数据按 token 比例折算，只有部分或全部为估算时为 true。 */
  estimated: boolean;
}

export interface ModelRecord {
  code: string;
  family: string;
  health: ModelHealth;
  reason: string | null;
  lastErrorCode: string | null;
  lastStatusCode: number | null;
  lastErrorMessage: string | null;
  checkedAt: string | null;
  lastUsedAt: string | null;
  promptTokens: number;
  cachedPromptTokens: number;
  /** 提供商上报过缓存明细的 prompt token 数，用作缓存命中率的分母。 */
  cacheTrackedPromptTokens: number;
  completionTokens: number;
  /** 按 pricing 配置估算的累计成本（配置币种）。 */
  cost: number;
  costBreakdown: CostBreakdown;
  requests: number;
  failures: number;
  throttledUntil: string | null;
}

export type FailureKind =
  | "quota_exhausted"
  | "model_invalid"
  | "throttled"
  | "auth"
  | "forbidden"
  | "bad_request"
  | "provider"
  | "network"
  | "timeout"
  | "aborted"
  | "exhausted"
  | "context"
  | "unknown";

export interface NormalizedError {
  kind: FailureKind;
  label: string;
  status: number | null;
  code: string | null;
  message: string;
  fatal: boolean;
  markDead: boolean;
  markInvalid: boolean;
  retryable: boolean;
}

export interface AttemptOk {
  ok: true;
  response: Response;
  latencyMs: number;
  /** 实际承接这次请求的提供商 id。 */
  providerId?: string;
}

export interface AttemptFail {
  ok: false;
  error: NormalizedError;
  latencyMs: number;
}

export type AttemptOutcome = AttemptOk | AttemptFail;

export interface AttemptRecord {
  model: string;
  ok: boolean;
  latencyMs: number;
  kind: FailureKind | null;
  status: number | null;
  code: string | null;
  message: string | null;
}
