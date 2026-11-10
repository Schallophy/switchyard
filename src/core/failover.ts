import type { AttemptOutcome, AttemptRecord, NormalizedError } from "../types.ts";

export interface FailoverHooks {
  onDead?: (model: string, error: NormalizedError) => void;
  onInvalid?: (model: string, error: NormalizedError) => void;
  onThrottle?: (model: string, error: NormalizedError) => void;
  onSkip?: (model: string, error: NormalizedError) => void;
}

export type Attemptor = (model: string, signal?: AbortSignal) => Promise<AttemptOutcome>;

export interface FailoverInput {
  candidates: string[];
  maxAttempts: number;
  attempt: Attemptor;
  signal?: AbortSignal;
  hooks?: FailoverHooks;
}

export type FailoverResult =
  | {
      ok: true;
      model: string;
      response: Response;
      attempts: AttemptRecord[];
      failovers: number;
      latencyMs: number;
      provider: string | null;
    }
  | {
      ok: false;
      error: NormalizedError;
      attempts: AttemptRecord[];
      failovers: number;
      latencyMs: number;
      exhausted: boolean;
    };

function abortedError(): NormalizedError {
  return {
    kind: "aborted",
    label: "请求已中断",
    status: null,
    code: null,
    message: "client aborted",
    fatal: true,
    markDead: false,
    markInvalid: false,
    retryable: false,
  };
}

export function exhaustedError(attempts: AttemptRecord[]): NormalizedError {
  const detail = attempts
    .map((item) => `${item.model}: ${item.kind ?? "error"}${item.status ? ` ${item.status}` : ""}`)
    .join("; ");
  const allThrottled = attempts.length > 0 && attempts.every((item) => item.kind === "throttled");
  return {
    kind: allThrottled ? "throttled" : "exhausted",
    label: allThrottled ? "所有模型均被限流" : "所有模型均不可用",
    status: null,
    code: "switchyard.exhausted",
    message: detail ? `没有可用的模型（${detail}）` : "没有可用的模型",
    fatal: true,
    markDead: false,
    markInvalid: false,
    retryable: false,
  };
}

export async function runFailover(input: FailoverInput): Promise<FailoverResult> {
  const started = performance.now();
  const attempts: AttemptRecord[] = [];
  const candidates = input.candidates.filter((code) => typeof code === "string" && code.length > 0);
  const limit = Math.max(1, Math.min(input.maxAttempts, candidates.length));

  for (let index = 0; index < limit; index += 1) {
    const model = candidates[index];
    if (!model) continue;

    if (input.signal?.aborted) {
      return {
        ok: false,
        error: abortedError(),
        attempts,
        failovers: Math.max(0, attempts.length - 1),
        latencyMs: performance.now() - started,
        exhausted: false,
      };
    }

    const outcome = await input.attempt(model, input.signal);
    attempts.push({
      model,
      ok: outcome.ok,
      latencyMs: outcome.latencyMs,
      kind: outcome.ok ? null : outcome.error.kind,
      status: outcome.ok ? null : outcome.error.status,
      code: outcome.ok ? null : outcome.error.code,
      message: outcome.ok ? null : outcome.error.message,
    });

    if (outcome.ok) {
      return {
        ok: true,
        model,
        response: outcome.response,
        attempts,
        failovers: attempts.length - 1,
        latencyMs: performance.now() - started,
        provider: outcome.providerId ?? null,
      };
    }

    switch (outcome.error.kind) {
      case "quota_exhausted":
        input.hooks?.onDead?.(model, outcome.error);
        break;
      case "model_invalid":
        input.hooks?.onInvalid?.(model, outcome.error);
        break;
      case "throttled":
        input.hooks?.onThrottle?.(model, outcome.error);
        break;
      default:
        input.hooks?.onSkip?.(model, outcome.error);
        break;
    }

    if (outcome.error.fatal) {
      return {
        ok: false,
        error: outcome.error,
        attempts,
        failovers: Math.max(0, attempts.length - 1),
        latencyMs: performance.now() - started,
        exhausted: false,
      };
    }
  }

  return {
    ok: false,
    error: exhaustedError(attempts),
    attempts,
    failovers: Math.max(0, attempts.length - 1),
    latencyMs: performance.now() - started,
    exhausted: true,
  };
}
