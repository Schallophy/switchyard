import { api } from "../api.js";
import {
  EVENT_KINDS,
  dayKey,
  dayLabel,
  esc,
  eventTone,
  fmtClock,
} from "../format.js";
import { store } from "../store.js";

const POLL_MS = 5000;

const local = {
  kind: "all",
  query: "",
  paused: false,
  events: [],
  loaded: false,
  loading: false,
  error: null,
};

let rootEl = null;
let abort = null;
let timer = null;
let mounted = false;

export function mount(root) {
  rootEl = root;
  mounted = true;
  local.kind = "all";
  local.query = "";
  local.paused = false;
  local.events = store.data?.events ? [...store.data.events] : [];
  local.loaded = Boolean(store.data);
  local.loading = false;
  local.error = null;

  abort = new AbortController();
  root.addEventListener("click", onClick, { signal: abort.signal });
  root.addEventListener("input", onInput, { signal: abort.signal });

  paint();
  load();

  timer = window.setInterval(() => {
    if (!local.paused && !document.hidden) load();
  }, POLL_MS);

  return { update, destroy };
}

function destroy() {
  mounted = false;
  abort?.abort();
  abort = null;
  window.clearInterval(timer);
  timer = null;
  rootEl = null;
  local.events = [];
}

async function load() {
  if (!mounted || local.loading) return;
  local.loading = true;

  try {
    const data = await api.get("/api/events?limit=400");
    local.events = Array.isArray(data?.events) ? data.events : [];
    local.error = null;
  } catch (error) {
    local.error = error.message;
  } finally {
    local.loading = false;
    local.loaded = true;
    paintBody();
  }
}

function paint() {
  if (!rootEl) return;

  rootEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">事件</h1>
        <p class="page-sub">切换、失效、限流与配置变更的完整记录</p>
      </div>
      <div class="page-tools">
        <span class="live-state">
          <span class="state-dot" id="live-dot" data-state="${liveState()}"></span>
          <span id="live-text">${liveText()}</span>
        </span>
        <button class="btn" type="button" data-action="pause" id="pause-btn">${
          local.paused ? "继续实时" : "暂停实时"
        }</button>
      </div>
    </div>

    <div class="events-tools">
      <div class="chips" id="event-filters">
        <button class="chip" type="button" data-kind="all" aria-pressed="${
          local.kind === "all"
        }">全部</button>
        ${EVENT_KINDS.map(
          ([kind, label]) =>
            `<button class="chip" type="button" data-kind="${kind}" aria-pressed="${
              local.kind === kind
            }">${label}</button>`,
        ).join("")}
      </div>
      <input class="input events-search" id="event-search" type="search" placeholder="搜索事件内容或模型" value="${esc(
        local.query,
      )}" autocomplete="off">
    </div>

    <div id="events-body">${bodyHtml()}</div>
  `;
}

function liveState() {
  if (local.paused) return "paused";
  return local.error ? "bad" : "ok";
}

function liveText() {
  if (local.paused) return "已暂停";
  if (local.error) return "连接中断";
  return "实时";
}

function paintLive() {
  const dot = rootEl?.querySelector("#live-dot");
  const text = rootEl?.querySelector("#live-text");
  const button = rootEl?.querySelector("#pause-btn");
  if (dot) dot.dataset.state = liveState();
  if (text) text.textContent = liveText();
  if (button) button.textContent = local.paused ? "继续实时" : "暂停实时";
}

function paintBody() {
  const body = rootEl?.querySelector("#events-body");
  if (!body) return;
  body.innerHTML = bodyHtml();
}

function bodyHtml() {
  if (!local.loaded) {
    return `<div class="sk-stack" aria-busy="true" aria-label="载入中" style="margin-top:20px">
      <div class="sk" style="height:44px"></div>
      <div class="sk" style="height:44px"></div>
      <div class="sk" style="height:44px"></div>
    </div>`;
  }

  if (local.error) {
    return `<div class="notice" data-tone="bad" style="margin-top:20px">
      <div>
        <p class="notice-title">读取事件失败</p>
        <p>${esc(local.error)}</p>
        <p style="margin-top:8px"><button class="link-btn" type="button" data-action="retry">重试</button></p>
      </div>
    </div>`;
  }

  const events = filterEvents();
  if (!events.length) {
    return `<div class="empty">
      <p class="empty-title">没有匹配的事件</p>
      <p>${
        local.kind === "all" && !local.query
          ? "事件会在启动、切换、失效、恢复和配置变更时记录。"
          : "换一个类型或关键词试试。"
      }</p>
    </div>`;
  }

  return groupEvents(events);
}

function filterEvents() {
  const query = local.query.trim().toLowerCase();

  return local.events.filter((event) => {
    if (local.kind !== "all" && event.kind !== local.kind) return false;
    if (query) {
      const haystack = `${event.message || ""} ${event.model || ""} ${event.chain || ""} ${
        event.kind || ""
      }`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function groupEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = dayKey(event.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  return [...groups.entries()]
    .map(
      ([key, items]) => `
      <section class="event-day">
        <h2 class="event-day-head">
          <strong>${esc(dayLabel(key))}</strong>
          <span>${esc(key)}</span>
          <span>·</span>
          <span>${items.length} 条</span>
        </h2>
        <div class="event-list">
          ${items.map(eventHtml).join("")}
        </div>
      </section>`,
    )
    .join("");
}

function eventHtml(event) {
  const meta = [event.model || "", event.chain && event.chain !== event.model ? event.chain : ""]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="event" data-tone="${eventTone(event.kind)}">
      <time class="event-time" datetime="${esc(event.at)}">${fmtClock(event.at)}</time>
      <span class="event-dot" aria-hidden="true"></span>
      <div class="event-main">
        <p class="event-msg">${esc(event.message)}</p>
        ${meta ? `<p class="event-meta">${esc(meta)}</p>` : ""}
      </div>
    </article>
  `;
}

function onClick(event) {
  const chip = event.target.closest("[data-kind]");
  if (chip) {
    local.kind = chip.dataset.kind;
    for (const item of rootEl.querySelectorAll("[data-kind]")) {
      item.setAttribute("aria-pressed", String(item === chip));
    }
    paintBody();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "pause") {
    local.paused = !local.paused;
    paintLive();
    if (!local.paused) load();
    return;
  }

  if (action === "retry") {
    local.error = null;
    local.loaded = false;
    paintBody();
    load();
    return;
  }
}

function onInput(event) {
  if (event.target.id !== "event-search") return;
  local.query = event.target.value;
  paintBody();
}

function update() {
  // 事件页自己按 5 秒轮询完整历史；这里保持连接状态即可。
  if (local.error && store.connection) {
    local.error = null;
    paintLive();
    paintBody();
  }
}