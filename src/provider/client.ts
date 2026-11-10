import type { GatewayConfig, ProviderConfig } from "../config/schema.ts";
import { classifyHttpError, classifyNetworkError, parseErrorPayload } from "../core/classify.ts";
import type { AttemptOutcome } from "../types.ts";

const VERSION = "0.1.0";

export interface KeyInfo {
  id: string;
  label: string;
  configured: boolean;
  source: "env" | "config" | "none";
  masked: string;
}

export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••";
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export function resolveProvider(config: GatewayConfig, id?: string): ProviderConfig | null {
  const wanted = (id ?? config.defaultProvider).trim().toLowerCase();
  const found = config.providers.find((item) => item.id === wanted);
  if (found) return found;
  if (id !== undefined) return null;
  return config.providers[0] ?? null;
}

export function keyInfoFor(provider: ProviderConfig): KeyInfo {
  const envName = provider.apiKeyEnv.trim();
  if (envName) {
    const value = process.env[envName]?.trim();
    if (value) {
      return { id: provider.id, label: provider.label, configured: true, source: "env", masked: maskKey(value) };
    }
  }
  const inline = provider.apiKey.trim();
  if (inline) {
    return { id: provider.id, label: provider.label, configured: true, source: "config", masked: maskKey(inline) };
  }
  return { id: provider.id, label: provider.label, configured: false, source: "none", masked: "" };
}

export function resolveKeyInfo(config: GatewayConfig): KeyInfo {
  const provider = resolveProvider(config);
  if (!provider) {
    return { id: config.defaultProvider, label: config.defaultProvider, configured: false, source: "none", masked: "" };
  }
  return keyInfoFor(provider);
}

export function resolveApiKey(provider: ProviderConfig): string | null {
  const info = keyInfoFor(provider);
  if (!info.configured) return null;
  if (info.source === "env") return process.env[provider.apiKeyEnv.trim()]?.trim() ?? null;
  return provider.apiKey.trim() || null;
}

export interface AttemptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 用哪个提供商发这个请求；缺省走 defaultProvider。 */
  providerId?: string;
}

export class ProviderClient {
  #getConfig: () => GatewayConfig;

  constructor(getConfig: () => GatewayConfig) {
    this.#getConfig = getConfig;
  }

  async attempt(
    path: string,
    model: string,
    body: Record<string, unknown>,
    options: AttemptOptions = {},
  ): Promise<AttemptOutcome> {
    const config = this.#getConfig();
    const provider = resolveProvider(config, options.providerId);
    if (!provider) {
      return {
        ok: false,
        latencyMs: 0,
        error: {
          kind: "provider",
          label: "提供商不存在",
          status: null,
          code: "switchyard.provider_unknown",
          message: `模型没有可用的提供商配置（providerId: ${options.providerId ?? config.defaultProvider}）`,
          fatal: true,
          markDead: false,
          markInvalid: false,
          retryable: false,
        },
      };
    }

    const key = resolveApiKey(provider);
    if (!key) {
      return {
        ok: false,
        latencyMs: 0,
        error: {
          kind: "auth",
          label: "未配置 API Key",
          status: null,
          code: "switchyard.no_key",
          message: `提供商 ${provider.id} 没有 Key：环境变量 ${provider.apiKeyEnv || "（未配置名称）"} 与 providers[].apiKey 均为空。`,
          fatal: true,
          markDead: false,
          markInvalid: false,
          retryable: false,
        },
      };
    }

    const url = `${provider.baseUrl}/${path.replace(/^\/+/, "")}`;
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? provider.requestTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${key}`,
          "user-agent": `switchyard/${VERSION}`,
        },
        body: JSON.stringify({ ...body, model }),
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - started);
      if (response.ok) return { ok: true, response, latencyMs, providerId: provider.id };

      const raw = await response.text().catch(() => "");
      return { ok: false, latencyMs, error: classifyHttpError(response.status, parseErrorPayload(raw)) };
    } catch (error) {
      const aborted = options.signal?.aborted === true;
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: classifyNetworkError(error, timedOut && !aborted, aborted),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listModels(providerId?: string): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
    const config = this.#getConfig();
    const provider = resolveProvider(config, providerId);
    if (!provider) return { ok: false, message: `提供商不存在：${providerId ?? config.defaultProvider}` };
    const key = resolveApiKey(provider);
    if (!key) return { ok: false, message: `提供商 ${provider.id} 未配置 API Key` };

    try {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key}`,
          "user-agent": `switchyard/${VERSION}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        const payload = parseErrorPayload(raw);
        return { ok: false, message: `${response.status} ${payload.code ?? ""} ${payload.message}`.trim() };
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== "object") return { ok: false, message: "提供商返回了非预期的模型目录" };
      const list = (data as Record<string, unknown>).data;
      if (!Array.isArray(list)) return { ok: true, ids: [] };
      const ids: string[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const id = (item as Record<string, unknown>).id;
        if (typeof id === "string" && id.trim().length > 0 && !ids.includes(id.trim())) ids.push(id.trim());
      }
      return { ok: true, ids };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
