import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "../runtime.ts";
import type { Logger } from "../util/log.ts";
import { registerAdminRoutes } from "./routes-admin.ts";
import { registerOpenAIRoutes } from "./routes-openai.ts";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const UI_ASSETS = new Set([
  "/index.html",
  "/favicon.svg",
  "/fonts.css",
  "/js/main.js",
  "/styles/tokens.css",
  "/styles/base.css",
  "/styles/shell.css",
  "/styles/components.css",
  "/styles/views.css",
]);

export class HttpError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.payload = payload;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  ip: string;
  json<T = unknown>(): T;
  send(status: number, data: unknown, headers?: Record<string, string>): void;
  sendRaw(status: number, body: string | Buffer, headers?: Record<string, string>): void;
  text(status: number, value: string, contentType?: string): void;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  keys: string[];
  pattern: RegExp;
  handler: Handler;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const source = path.replace(/\/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
      keys.push(key);
      return "/([^/]+)";
    });
    this.#routes.push({ method, keys, pattern: new RegExp(`^${source}/?$`), handler });
  }

  async dispatch(ctx: Ctx): Promise<boolean> {
    for (const route of this.#routes) {
      if (route.method !== ctx.req.method) continue;
      const match = route.pattern.exec(ctx.url.pathname);
      if (!match) continue;
      for (let index = 0; index < route.keys.length; index += 1) {
        const key = route.keys[index];
        if (!key) continue;
        ctx.params[key] = decodeURIComponent(match[index + 1] ?? "");
      }
      await route.handler(ctx);
      return true;
    }
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

export function createServer(runtime: Runtime, logger: Logger): Server {
  const router = new Router();
  registerOpenAIRoutes(router, runtime);
  registerAdminRoutes(router, runtime);

  return createHttpServer(async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const ip = req.socket.remoteAddress ?? "";
    const isApi = url.pathname.startsWith("/v1/");

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'");
    res.setHeader("x-frame-options", "SAMEORIGIN");

    if (isApi && runtime.config.server.cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-expose-headers", "x-switchyard-model, x-switchyard-provider, x-switchyard-failovers");
    }
    const ctx: Ctx = {
      req,
      res,
      url,
      params: {},
      body: undefined,
      ip,
      json<T = unknown>(): T {
        return ctx.body as T;
      },
      send(status, data, headers) {
        if (res.headersSent) return;
        res.statusCode = status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
        res.end(JSON.stringify(data));
      },
      sendRaw(status, body, headers) {
        if (res.headersSent) return;
        res.statusCode = status;
        if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
        res.end(body);
      },
      text(status, value, contentType = "text/plain; charset=utf-8") {
        if (res.headersSent) return;
        res.statusCode = status;
        res.setHeader("content-type", contentType);
        res.end(value);
      },
    };

    try {
      if (req.method === "OPTIONS" && isApi && runtime.config.server.cors) {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (isApi) {
        const token = runtime.config.gatewayToken.trim();
        if (token && !bearerMatches(req, token)) {
          ctx.send(401, {
            error: {
              message: "网关访问令牌无效",
              type: "switchyard.auth",
              code: "switchyard.unauthorized",
            },
          });
          return;
        }
      }

      ctx.body = await readBody(req, runtime.config.server.maxBodyBytes);

      if (url.pathname.startsWith("/api/") && !isLoopback(ip)) {
        ctx.send(403, { error: { message: "管理接口仅允许本机访问", type: "switchyard.forbidden", code: "switchyard.remote_admin" } });
        return;
      }

      const matched = await router.dispatch(ctx);
      if (matched) return;

      if (req.method === "GET" || req.method === "HEAD") {
        if (runtime.config.ui.enabled) {
          if (await serveStatic(ctx, url.pathname)) return;
        } else if (url.pathname === "/" || UI_ASSETS.has(url.pathname)) {
          ctx.send(404, {
            error: {
              message: "管理界面已关闭（config.json 中 ui.enabled = false），请直接编辑配置文件。",
              type: "switchyard.ui_disabled",
              code: "switchyard.ui_disabled",
            },
          });
          return;
        }
      }

      ctx.send(404, { error: { message: `未找到 ${url.pathname}`, type: "switchyard.not_found", code: "switchyard.not_found" } });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) logger.error("request failed", { method: req.method, path: url.pathname, error: message });
      if (!res.headersSent) {
        ctx.send(status, {
          error: {
            message,
            type: status >= 500 ? "switchyard.internal" : "switchyard.bad_request",
            code: status >= 500 ? "switchyard.internal" : "switchyard.bad_request",
          },
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      const duration = Math.round(performance.now() - started);
      if (isApi && req.method !== "OPTIONS") {
        logger.access(req.method ?? "GET", url.pathname, res.statusCode, duration);
      } else {
        logger.debug("http request", { method: req.method, path: url.pathname, status: res.statusCode, ms: duration });
      }
    }
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, `请求体超过 ${Math.round(limit / 1024)}KB 限制（config.json 的 server.maxBodyBytes）`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  const contentType = String(req.headers["content-type"] ?? "");
  if (contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "请求体不是合法 JSON");
    }
  }
  return text;
}

async function serveStatic(ctx: Ctx, pathname: string): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes("..")) return false;
  const file = `${UI_DIR}${relative}`;
  try {
    const content = await readFile(file);
    ctx.res.statusCode = 200;
    ctx.res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    ctx.res.setHeader("cache-control", "no-store");
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : content);
    return true;
  } catch {
    return false;
  }
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = createHash("sha256").update(match[1] ?? "").digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(provided, expected);
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}
