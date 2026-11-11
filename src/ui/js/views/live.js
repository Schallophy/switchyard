import { api } from "../api.js";
import { esc, fmtBytes, fmtClock, fmtInt, fmtMs, fmtTokens } from "../format.js";
import { toast } from "../ui.js";

const API_LABELS = {
  chat: "Chat",
  completions: "Completions",
  responses: "Responses",
  embeddings: "Embeddings",
};

const API_TITLES = {
  chat: "Chat Completions（/v1/chat/completions）",
  completions: "Completions（/v1/completions）",
  responses: "Responses（/v1/responses）",
  embeddings: "Embeddings（/v1/embeddings）",
};

const MAX_LOCAL = 80;

const local = {
  sessions: new Map(),
  rawCache: new Map(),
  api: "all",
  query: "",
  onlyErrors: false,
  connected: false,
  autoScroll: true,
  limits: null,
};

let rootEl = null;
let source = null;
let abort = null;
let scrollFrame = 0;

export function mount(root) {
  rootEl = root;
  local.sessions.clear();
  local.rawCache.clear();
  local.api = "all";
  local.query = "";
  local.onlyErrors = false;
  local.connected = false;
  local.autoScroll = true;
  local.limits = null;

  abort = new AbortController();
  const options = { signal: abort.signal };
  root.addEventListener("click", onClick, options);
  root.addEventListener("input", onInput, options);
  root.addEventListener("change", onChange, options);
  window.addEventListener("scroll", onScroll, { passive: true, signal: abort.signal });

  paint();
  connect();

  return { update, destroy };
}

function destroy() {
  closeSource();
  abort?.abort();
  abort = null;
  rootEl = null;
  local.sessions.clear();
  local.rawCache.clear();
  if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
}

function connect() {
  closeSource();
  if (!rootEl) return;

  try {
    source = new EventSource("/api/live");
  } catch {
    local.connected = false;
    paintStatus();
    return;
  }

  source.addEventListener("open", () => {
    local.connected = true;
    paintStatus();
  });
  source.addEventListener("snapshot", (event) => {
    const data = parseEvent(event);
    if (!data) return;
    local.connected = true;
    if (data.limits) local.limits = data.limits;
    if (Array.isArray(data.sessions)) {
      // snapshot 是服务端当前的真实内容：整表替换，避免重连后残留已清理的会话。
      local.sessions.clear();
      for (const session of data.sessions) {
        if (session && typeof session.id === "number") local.sessions.set(session.id, session);
      }
      for (const id of local.rawCache.keys()) {
        if (!local.sessions.has(id)) local.rawCache.delete(id);
      }
      trimLocal();
    }
    paintStatus();
    render();
  });
  source.addEventListener("start", (event) => {
    const data = parseEvent(event);
    if (!data?.session) return;
    upsert(data.session);
    render();
  });
  source.addEventListener("delta", (event) => {
    const data = parseEvent(event);
    if (!data || typeof data.id !== "number" || typeof data.text !== "string") return;
    appendDelta(data.id, data.text);
  });
  source.addEventListener("done", (event) => {
    const data = parseEvent(event);
    if (!data?.session) return;
    upsert(data.session);
    render();
  });
  source.addEventListener("clear", () => {
    local.sessions.clear();
    local.rawCache.clear();
    render();
  });
  source.addEventListener("error", () => {
    local.connected = false;
    paintStatus();
  });
}

function closeSource() {
  source?.close();
  source = null;
}

function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function upsert(session) {
  local.sessions.set(session.id, session);
  trimLocal();
}

function trimLocal() {
  while (local.sessions.size > MAX_LOCAL) {
    const oldest = local.sessions.keys().next().value;
    if (oldest === undefined) return;
    local.sessions.delete(oldest);
  }
}

function appendDelta(id, text) {
  const session = local.sessions.get(id);
  if (!session) return;
  session.text = `${session.text || ""}${text}`;

  const pre = rootEl?.querySelector(`[data-live-id="${id}"] [data-role="text"]`);
  if (pre) {
    pre.append(document.createTextNode(text));
    const card = pre.closest(".live-item");
    if (card) card.dataset.status = "streaming";
  }
  maybeScroll();
}

/* ---------- render ---------- */

function paint() {
  if (!rootEl) return;

  rootEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">实时输出</h1>
        <p class="page-sub">查看最近经过网关的模型输出，每条都标出实际承接的模型和协议；工具调用会以 [tool_call] 标出，没有可见文本时可直接展开原始响应排查。内容只保存在内存里，刷新页面或重启进程后清空。</p>
      </div>
      <div class="page-tools">
        <span class="live-state">
          <span class="state-dot" id="live-dot" data-state="${local.connected ? "ok" : "bad"}"></span>
          <span id="live-text">${local.connected ? "实时连接" : "连接中…"}</span>
        </span>
        <button class="btn" type="button" data-action="scroll" id="live-scroll-btn">暂停滚动</button>
        <button class="btn" type="button" data-action="clear">清空</button>
      </div>
    </div>

    <dl class="statline live-summary">
      <div class="stat"><dt>最近</dt><dd id="live-count">0</dd></div>
      <div class="stat"><dt>流式中</dt><dd id="live-streaming">0</dd></div>
      <div class="stat"><dt>失败</dt><dd id="live-errors">0</dd></div>
      <div class="stat"><dt>保留</dt><dd id="live-retention" title="只保留最近的会话，且单条输出会截断">—</dd></div>
    </dl>

    <div class="events-tools live-tools">
      <div class="chips" id="live-filters">
        <button class="chip" type="button" data-live-api="all" aria-pressed="true">全部</button>
        ${Object.entries(API_LABELS)
          .map(
            ([kind, label]) =>
              `<button class="chip" type="button" data-live-api="${kind}" title="${esc(
                API_TITLES[kind],
              )}" aria-pressed="false">${label}</button>`,
          )
          .join("")}
      </div>
      <input class="input events-search" id="live-search" type="search" placeholder="搜索模型、提供商或调用方" autocomplete="off" aria-label="搜索实时输出">
      <label class="check live-errors-toggle"><input id="live-only-errors" type="checkbox"> 只看失败</label>
    </div>

    <div id="live-list"></div>
  `;

  updateScrollButton();
  render();
}

function render() {
  if (!rootEl) return;

  const items = filteredSessions();
  const all = [...local.sessions.values()];
  setText("#live-count", fmtInt(all.length));
  setText("#live-streaming", fmtInt(all.filter((session) => session.status === "streaming").length));
  setText("#live-errors", fmtInt(all.filter((session) => session.status === "error").length));
  const limits = local.limits;
  setText(
    "#live-retention",
    limits ? `${fmtInt(limits.sessions)} 条` : "—",
  );

  const list = rootEl.querySelector("#live-list");
  if (!list) return;
  list.innerHTML = items.length ? items.map(cardHtml).join("") : emptyHtml();
  for (const details of list.querySelectorAll(".live-raw[open]")) {
    loadRaw(details);
  }
  maybeScroll();
}

function filteredSessions() {
  const query = local.query.trim().toLowerCase();
  return [...local.sessions.values()].filter((session) => {
    if (local.api !== "all" && session.api !== local.api) return false;
    if (local.onlyErrors && session.status !== "error") return false;
    if (query) {
      const haystack = `${session.model || ""} ${session.provider || ""} ${session.caller || ""} ${
        session.requested || ""
      }`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function cardHtml(session) {
  const status = session.status;
  const statusLabel = status === "streaming" ? "流式中" : status === "error" ? "失败" : "完成";
  const text = session.text || (status === "streaming" ? "" : "（无文本输出）");
  const usage = session.usage;
  const meta = [
    session.stream ? "流式" : "非流式",
    session.failovers > 0 ? `切换 ${fmtInt(session.failovers)} 次` : null,
    session.latencyMs > 0 ? fmtMs(session.latencyMs) : null,
    usage ? `输入 ${fmtTokens(Math.max(0, usage.promptTokens - usage.cachedPromptTokens))} · 输出 ${fmtTokens(usage.completionTokens)}` : null,
    session.bytes > 0 ? fmtBytes(session.bytes) : null,
    session.truncated ? "已截断" : null,
    session.finishReason ? `完成：${esc(session.finishReason)}` : null,
  ]
    .filter(Boolean)
    .map((item) => `<span>${esc(item)}</span>`)
    .join("");

  return `
    <article class="live-item" data-live-id="${session.id}" data-status="${status}" data-api="${esc(
      session.api,
    )}">
      <header class="live-head">
        <time class="live-time" datetime="${esc(session.at)}">${fmtClock(session.at)}</time>
        <span class="api-badge" title="${esc(API_TITLES[session.api] ?? session.api)}">${esc(
          API_LABELS[session.api] ?? session.api,
        )}</span>
        <code class="live-model" title="${esc(session.model)}">${esc(session.model)}</code>
        <span class="live-chip">${esc(session.caller)}</span>
        ${session.provider ? `<span class="live-chip">${esc(session.provider)}</span>` : ""}
        ${
          session.requested && session.requested !== session.model && session.requested !== "auto"
            ? `<span class="live-chip">请求 ${esc(session.requested)}</span>`
            : ""
        }
        <span class="live-status" data-status="${status}">${statusLabel}</span>
        <span class="live-meta">${meta}</span>
      </header>
      ${session.error ? `<div class="live-error">${esc(session.error)}</div>` : ""}
      <pre class="live-text" data-role="text">${esc(text)}</pre>
      ${session.rawLength > 0 && status !== "streaming"
        ? `<details class="live-raw"${!session.text && !session.error ? " open" : ""} data-live-raw="${session.id}">
          <summary>${!session.text ? "原始响应（无可见文本）" : "原始响应"}</summary>
          <pre class="live-raw-text" data-role="raw">加载中…</pre>
        </details>`
        : ""
      }
    </article>
  `;
}

function emptyHtml() {
  const active = local.query || local.api !== "all" || local.onlyErrors;
  return `<div class="empty">
    <p class="empty-title">${active ? "没有匹配的输出" : "还没有实时输出"}</p>
    <p>${
      active
        ? "换一个关键词或协议筛选试试。"
        : "通过网关发起一次对话后，模型的回复会实时出现在这里。"
    }</p>
  </div>`;
}

function setText(selector, value) {
  const node = rootEl?.querySelector(selector);
  if (node) node.textContent = value;
}

function formatRaw(raw) {
  const trimmed = String(raw ?? "").trimStart();
  if (!trimmed) return "（提供商没有返回响应体）";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/** 按需取单条会话的原始响应体，并填充到 <details> 里。 */
async function loadRaw(details) {
  if (!details || details.dataset.loaded === "true") return;
  const id = Number(details.dataset.liveRaw);
  if (!Number.isInteger(id) || id <= 0) return;

  const pre = details.querySelector("[data-role='raw']");
  if (!pre) return;

  const cached = local.rawCache.get(id);
  if (cached) {
    pre.textContent = cached;
    details.dataset.loaded = "true";
    return;
  }

  details.dataset.loaded = "loading";
  try {
    const data = await api.get(`/api/live/${id}/raw`);
    const formatted = formatRaw(data?.raw ?? "");
    pre.textContent = formatted;
    local.rawCache.set(id, formatted);
    while (local.rawCache.size > MAX_LOCAL) {
      const oldest = local.rawCache.keys().next().value;
      if (oldest === undefined) break;
      local.rawCache.delete(oldest);
    }
    details.dataset.loaded = "true";
  } catch (error) {
    pre.textContent = `读取失败：${error?.message ?? error}`;
    details.dataset.loaded = "error";
  }
}

/* ---------- interaction ---------- */

function paintStatus() {
  const dot = rootEl?.querySelector("#live-dot");
  const text = rootEl?.querySelector("#live-text");
  if (dot) dot.dataset.state = local.connected ? "ok" : "bad";
  if (text) text.textContent = local.connected ? "实时连接" : "重连中…";
}

function updateScrollButton() {
  const button = rootEl?.querySelector("#live-scroll-btn");
  if (!button) return;
  button.textContent = local.autoScroll ? "暂停滚动" : "继续滚动";
  button.setAttribute("aria-pressed", String(!local.autoScroll));
}

function maybeScroll() {
  if (!rootEl || !local.autoScroll || scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!rootEl || !local.autoScroll) return;
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
}

function onScroll() {
  if (!rootEl) return;
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  if (atBottom !== local.autoScroll) {
    local.autoScroll = atBottom;
    updateScrollButton();
  }
}

function onClick(event) {
  const summary = event.target.closest(".live-raw summary");
  if (summary) {
    loadRaw(summary.closest(".live-raw"));
    return;
  }

  const chip = event.target.closest("[data-live-api]");
  if (chip) {
    local.api = chip.dataset.liveApi;
    for (const item of rootEl.querySelectorAll("[data-live-api]")) {
      item.setAttribute("aria-pressed", String(item === chip));
    }
    render();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) return;

  if (target.dataset.action === "scroll") {
    local.autoScroll = !local.autoScroll;
    updateScrollButton();
    if (local.autoScroll) maybeScroll();
    return;
  }

  if (target.dataset.action === "clear") {
    void clearAll();
  }
}

async function clearAll() {
  try {
    await api.del("/api/live");
    local.sessions.clear();
    local.rawCache.clear();
    render();
    toast("实时输出已清空", "ok");
  } catch (error) {
    toast(error.message || "清空失败", "bad");
  }
}

function onInput(event) {
  if (event.target.id !== "live-search") return;
  local.query = event.target.value;
  render();
}

function onChange(event) {
  if (event.target.id !== "live-only-errors") return;
  local.onlyErrors = event.target.checked;
  render();
}

function update() {
  // 实时输出走 EventSource，不依赖 /api/overview 的轮询。
}