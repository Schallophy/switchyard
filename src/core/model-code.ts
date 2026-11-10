export interface ParsedModelCode {
  provider: string;
  /** 发给上游的模型名，不含提供商标识。 */
  upstream: string;
}

/**
 * 模型 code 的格式是 `提供商id/上游模型名`。提供商 id 只允许小写字母、数字与 . _ -
 * （不含斜杠），所以按「id + /」做最长前缀匹配即可，上游模型名里带斜杠也没问题。
 */
export function splitModelCode(code: string, providers: Array<{ id: string }>): ParsedModelCode | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  let best: { id: string } | null = null;
  for (const provider of providers) {
    if (!provider.id) continue;
    if (!trimmed.startsWith(`${provider.id}/`)) continue;
    if (!best || provider.id.length > best.id.length) best = provider;
  }
  if (!best) return null;
  const upstream = trimmed.slice(best.id.length + 1).trim();
  if (!upstream) return null;
  return { provider: best.id, upstream };
}

export function joinModelCode(providerId: string, upstream: string): string {
  return `${providerId.trim()}/${upstream.trim().replace(/^\/+/, "")}`;
}