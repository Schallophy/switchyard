import type { NormalizedError } from "../types.ts";

export interface ErrorPayload {
  code: string | null;
  message: string;
}

const MAX_MESSAGE = 600;

const FREE_TIER = /FreeTierOnly|free[\s_-]*tier|free[\s_-]*quota|试用额度|免费额度/i;
const ALLOCATION_QUOTA = /^AllocationQuota/i;
const THROTTLE = /Throttling|RateLimit|rate[\s_-]*limit|too many requests|请求过于频繁|限流/i;
const AUTH = /InvalidApiKey|Authentication|Unauthorized|InvalidAccessKey|SignatureDoesNotMatch|InvalidCredential/i;
const MODEL_MISSING = /ModelNotFound|ModelNotExist|model.*(does not exist|not exist|not found|invalid|not supported)/i;
const PERMISSION = /AccessDenied|Forbidden|not\s*authori[sz]ed|not\s*activated|ModelNotOpen|no\s*permission/i;

export function cleanMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
}

export function parseErrorPayload(raw: string): ErrorPayload {
  const text = (raw ?? "").trim();
  if (!text) return { code: null, message: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { code: null, message: cleanMessage(text) };
    }
    const root = parsed as Record<string, unknown>;
    let code: string | null = null;
    let message = "";

    const nested = root.error;
    if (typeof nested === "string") {
      message = nested;
    } else if (nested && typeof nested === "object") {
      const record = nested as Record<string, unknown>;
      if (typeof record.code === "string") code = record.code;
      if (typeof record.message === "string") message = record.message;
      if (!code && typeof record.type === "string") code = record.type;
    }

    if (!code && typeof root.code === "string") code = root.code;
    if (!message && typeof root.message === "string") message = root.message;
    if (!message && typeof root.msg === "string") message = root.msg;
    if (!message && typeof root.detail === "string") message = root.detail;

    return { code, message: cleanMessage(message || code || text) };
  } catch {
    return { code: null, message: cleanMessage(text) };
  }
}

interface Flags {
  fatal: boolean;
  markDead: boolean;
  markInvalid: boolean;
  retryable: boolean;
}

function build(
  kind: NormalizedError["kind"],
  label: string,
  status: number | null,
  payload: ErrorPayload,
  flags: Flags,
): NormalizedError {
  return {
    kind,
    label,
    status,
    code: payload.code,
    message: payload.message,
    fatal: flags.fatal,
    markDead: flags.markDead,
    markInvalid: flags.markInvalid,
    retryable: flags.retryable,
  };
}

export function classifyHttpError(status: number, payload: ErrorPayload): NormalizedError {
  const code = payload.code ?? "";
  const blob = `${code} ${payload.message}`;

  if (status === 429 || THROTTLE.test(blob)) {
    return build("throttled", "触发限流", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }

  if (status === 403 && (FREE_TIER.test(blob) || ALLOCATION_QUOTA.test(code))) {
    return build("quota_exhausted", "额度已耗尽", status, payload, {
      fatal: false,
      markDead: true,
      markInvalid: false,
      retryable: true,
    });
  }

  if (status === 401 || AUTH.test(blob)) {
    return build("auth", "API Key 无效", status, payload, {
      fatal: true,
      markDead: false,
      markInvalid: false,
      retryable: false,
    });
  }

  if (MODEL_MISSING.test(blob)) {
    return build("model_invalid", "模型不可用", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: true,
      retryable: true,
    });
  }

  if (status === 403) {
    return build("forbidden", PERMISSION.test(blob) ? "无访问权限" : "请求被拒绝", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }

  if (status === 404) {
    // A bare 404 usually means the base URL is wrong, not that the model is gone.
    return build("provider", "提供商地址异常", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }

  if (status === 400 || status === 422) {
    return build("bad_request", "请求参数错误", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }

  if (status >= 500) {
    return build("provider", "提供商服务异常", status, payload, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }

  return build("unknown", "未知错误", status, payload, {
    fatal: false,
    markDead: false,
    markInvalid: false,
    retryable: true,
  });
}

export function classifyNetworkError(error: unknown, timedOut: boolean, clientAborted: boolean): NormalizedError {
  if (clientAborted) {
    return build("aborted", "请求已中断", null, { code: null, message: "client aborted" }, {
      fatal: true,
      markDead: false,
      markInvalid: false,
      retryable: false,
    });
  }
  if (timedOut) {
    return build("timeout", "请求超时", null, { code: null, message: "provider timeout" }, {
      fatal: false,
      markDead: false,
      markInvalid: false,
      retryable: true,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return build("network", "网络错误", null, { code: null, message: cleanMessage(message) }, {
    fatal: false,
    markDead: false,
    markInvalid: false,
    retryable: true,
  });
}
