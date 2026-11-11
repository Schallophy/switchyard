import { createHash } from "node:crypto";

export interface CallerIdentity {
  id: string;
  label: string;
}

export const ANONYMOUS_CALLER: CallerIdentity = { id: "anonymous", label: "匿名" };
export const CONSOLE_CALLER: CallerIdentity = { id: "console", label: "看板自测" };

export function identifyCaller(headers: Record<string, string | string[] | undefined>): CallerIdentity {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token) return ANONYMOUS_CALLER;
  const id = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return { id, label: labelFor(token) };
}

/**
 * Short, readable labels like `sk-opencode` become `opencode`; long or opaque
 * tokens stay masked so the full key never lands in state.json or the dashboard.
 */
export function labelFor(token: string): string {
  const body = token.startsWith("sk-") ? token.slice(3) : token;
  if (/^[A-Za-z0-9._-]{1,24}$/.test(body)) return body;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
