import { api } from "./api.js";
import { fmtUptime, tickCountdowns } from "./format.js";
import { parseRoute, replaceRoute } from "./router.js";
import { setConfig, setOverview, store } from "./store.js";
import { toast } from "./ui.js";
import * as eventsView from "./views/events.js";
import * as liveView from "./views/live.js";
import * as modelsView from "./views/models.js";
import * as rankView from "./views/rank.js";
import * as settingsView from "./views/settings.js";
import * as usageView from "./views/usage.js";

const MODULES = {
  models: modelsView,
  rank: rankView,
  usage: usageView,
  live: liveView,
  events: eventsView,
  settings: settingsView,
};

const TITLES = {
  models: "模型",
  rank: "排行",
  usage: "用量",
  live: "输出",
  events: "事件",
  settings: "设置",
};

const POLL_MS = 2000;

const root = document.getElementById("view");
const gatewayDot = document.getElementById("gateway-dot");
const gatewayState = document.getElementById("gateway-state");
const headProto = document.getElementById("head-proto");
const footEndpoint = document.getElementById("foot-endpoint");
const footVersion = document.getElementById("foot-version");

const API_LABELS = {
  chat: "Chat",
  completions: "Completions",
  responses: "Responses",
  embeddings: "Embeddings",
};

const API_TITLES = {
  chat: "Chat Completions（/v1/chat/completions）",
  completions: "Completions（/v1/completions，旧版文本补全）",
  responses: "Responses（/v1/responses）",
  embeddings: "Embeddings（/v1/embeddings）",
};

let handle = null;
let route = null;
let pollTimer = null;
let tickTimer = null;

/** 最近一次请求走的协议：取 lastUsedAt 最新的那个。 */
function latestProtocol(apis) {
  if (!apis || typeof apis !== "object") return null;
  let latest = null;
  for (const [kind, stat] of Object.entries(apis)) {
    const at = stat?.lastUsedAt ? Date.parse(stat.lastUsedAt) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    if (!latest || at > latest.at) latest = { kind, at };
  }
  return latest?.kind ?? null;
}

function paintShell() {
  const data = store.data;

  if (!data) {
    gatewayDot.dataset.state = "bad";
    gatewayState.innerHTML = "<strong>无法连接</strong>";
    gatewayState.title = store.lastError?.message || "";
    footEndpoint.textContent = "—";
    footVersion.textContent = "—";
    headProto.hidden = true;
    return;
  }

  const protocol = latestProtocol(data.stats?.apis);
  headProto.hidden = protocol === null;
  if (protocol) {
    headProto.textContent = API_LABELS[protocol] ?? protocol;
    headProto.dataset.api = protocol;
    headProto.title = `最近一次请求：${API_TITLES[protocol] ?? protocol}`;
  }

  if (store.connection) {
    gatewayDot.dataset.state = "ok";
    gatewayState.innerHTML = `<strong>运行中</strong><span class="head-uptime"> · ${fmtUptime(
      data.app.uptimeSeconds,
    )}</span>`;
    gatewayState.title = "";
  } else {
    gatewayDot.dataset.state = "bad";
    gatewayState.innerHTML = "<strong>连接中断</strong>";
    gatewayState.title = store.lastError?.message || "";
  }

  footEndpoint.textContent = data.app.endpoint || "—";
  footVersion.textContent = `v${data.app.version}`;
}

function paintNav() {
  for (const link of document.querySelectorAll(".nav a[data-nav]")) {
    if (link.dataset.nav === route?.view) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

async function refresh() {
  try {
    const data = await api.get("/api/overview");
    setOverview(data);
    store.connection = true;
    store.lastError = null;
    paintShell();
    handle?.update?.();
    return data;
  } catch (error) {
    store.connection = false;
    store.lastError = error;
    paintShell();
    return null;
  }
}

async function loadConfig() {
  try {
    const meta = await api.get("/api/config");
    setConfig(meta);
    handle?.update?.();
    return meta;
  } catch (error) {
    if (!store.config) store.lastError = error;
    return null;
  }
}

function renderRoute() {
  const next = parseRoute();
  if (next.canonical) replaceRoute(next.canonical);

  if (handle?.destroy) handle.destroy();
  handle = null;
  route = next;

  root.replaceChildren();
  paintNav();
  document.title = `${TITLES[next.view]} · Switchyard`;

  handle = MODULES[next.view].mount(root, {
    route: next,
    refresh,
    loadConfig,
    navigate(path) {
      if (window.location.hash !== path) window.location.hash = path;
    },
  });
}

function onHashChange() {
  renderRoute();
  window.scrollTo(0, 0);
}

async function boot() {
  renderRoute();
  paintShell();

  await Promise.allSettled([refresh(), loadConfig()]);
  paintShell();

  pollTimer = window.setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);

  tickTimer = window.setInterval(() => tickCountdowns(document), 1000);

  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="copy-endpoint"]');
  if (!button) return;

  const value = store.data?.app?.endpoint;
  if (!value) {
    toast("接入地址尚未就绪", "warn");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    toast("接入地址已复制", "ok");
  } catch {
    toast("复制失败，请手动选择地址", "bad");
  }
});

boot();

void pollTimer;
void tickTimer;