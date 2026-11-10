import { api } from "../api.js";
import {
  countdownHtml,
  esc,
  fmtAgo,
  fmtClock,
  fmtDateTime,
  fmtInt,
  fmtMinutes,
  fmtMs,
  fmtMoney,
  fmtPercent,
  fmtTokens,
  fmtWindow,
  statusOf,
  tickCountdowns,
} from "../format.js";
import { replaceRoute } from "../router.js";
import { store } from "../store.js";
import { closeMenu, confirmDialog, openDialog, openMenu, toast } from "../ui.js";

const API_ORDER = ["chat", "responses", "completions", "embeddings"];

const API_LABELS = {
  chat: "Chat",
  responses: "Responses",
  completions: "Completions",
  embeddings: "Embeddings",
};

const FAILURE_LABELS = {
  quota_exhausted: "额度耗尽",
  model_invalid: "模型不存在",
  throttled: "限流",
  auth: "鉴权失败",
  forbidden: "无权限",
  bad_request: "请求错误",
  provider: "上游错误",
  network: "网络错误",
  timeout: "超时",
  aborted: "已中止",
  exhausted: "全部失败",
  context: "上下文超限",
  unknown: "未知错误",
};

const local = {
  batch: false,
  selected: new Set(),
  dragging: null,
  test: { prompt: "你好，请回复一句话。", running: false, result: null, error: null },
  add: { query: "", filter: "untracked", selected: new Set() },
};

let rootEl = null;
let viewCtx = null;
let signature = "";
let eventSignature = "";
let configSignature = "";
let abort = null;

export function mount(root, ctx) {
  rootEl = root;
  viewCtx = ctx;

  local.batch = false;
  local.selected.clear();
  local.dragging = null;

  abort = new AbortController();
  const options = { signal: abort.signal };
  root.addEventListener("click", onClick, options);
  root.addEventListener("change", onChange, options);
  root.addEventListener("keydown", onKeyDown, options);
  root.addEventListener("dragstart", onDragStart, options);
  root.addEventListener("dragover", onDragOver, options);
  root.addEventListener("dragleave", onDragLeave, options);
  root.addEventListener("drop", onDrop, options);
  root.addEventListener("dragend", clearDrag, options);

  paint();

  if (ctx.route.openAdd) {
    replaceRoute("#/models");
    openAddSheet(ctx);
  }

  return { update, destroy };
}

function destroy() {
  abort?.abort();
  abort = null;
  closeMenu();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  rootEl = null;
  viewCtx = null;
  signature = "";
  eventSignature = "";
}

/* ---------- render ---------- */

function paint() {
  if (!rootEl) return;
  const data = store.data;

  if (!data) {
    rootEl.innerHTML = skeletonHtml();
    signature = "";
    eventSignature = "";
    return;
  }

  if (!data.chain.models.length) {
    rootEl.innerHTML = emptyHtml();
    signature = "";
    eventSignature = "";
    return;
  }

  const chain = data.chain;
  rootEl.innerHTML = `
    <h1 class="sr-only">模型</h1>
    <section class="output" aria-labelledby="output-label">
      <div class="output-main" id="output-main">${outputMainHtml(data)}</div>
      <div class="output-actions">
        <button class="btn" type="button" data-action="test">发送测试</button>
        <button class="btn primary" type="button" data-action="add">添加模型</button>
      </div>
    </section>

    <dl class="statline" id="statline">${statsHtml(data)}</dl>

    <div class="models-grid">
      <section class="rail-wrap" aria-labelledby="rail-title">
        <div class="sec-head">
          <h2 class="sec-title" id="rail-title">路由</h2>
          <span class="sec-hint">从上到下依次回退</span>
          <div class="sec-tools rail-tools">${railTools()}</div>
        </div>
        <ol class="rail" id="rail">
          ${chain.models.map((model, index) => rowHtml(model, index, data)).join("")}
        </ol>
        <button class="rail-add" type="button" data-action="add">
          <span class="plus" aria-hidden="true">+</span>
          <span>添加模型</span>
        </button>
      </section>

      <aside class="side">
        ${policyHtml(data)}
        ${recentHtml(data)}
      </aside>
    </div>
  `;

  signature = railSignature(chain);
  eventSignature = eventsSignature(data);
  configSignature = configSignatureNow();
  tickCountdowns(rootEl);
}

function outputMainHtml(data) {
  const chain = data.chain;
  const current = chain.models.find((model) => model.code === chain.effective) || null;
  const status = statusOf(current, chain);
  const note =
    chain.active && chain.effective && chain.active !== chain.effective
      ? `<p class="output-note">首选 ${esc(chain.active)} 暂不可用，恢复后自动切回</p>`
      : "";

  return `
    <div class="output-label" id="output-label">当前输出</div>
    <div class="output-code" id="out-code">${esc(chain.effective || "没有可用模型")}</div>
    <div class="output-meta">
      <span class="status-text" data-tone="${status.tone}">${esc(status.text)}</span>
      ${countdownHtml(status)}
      ${
        current
          ? `<span class="dot-sep" aria-hidden="true">·</span><span>${esc(providerLabel(current, data))}</span>`
          : ""
      }
    </div>
    ${note}
  `;
}

function statsHtml(data) {
  const stats = data.stats;
  const tokens = inputTokens(stats) + (stats.completionTokens || 0);
  return [
    ["请求", fmtInt(stats.requests)],
    ["切换", fmtInt(stats.failovers)],
    ["Tokens", fmtTokens(tokens)],
    ["缓存率", fmtPercent(cacheRate(stats))],
    ["成本", fmtMoney(stats.cost, currencyOf(data))],
    ["可用", `${data.chain.alive} / ${data.chain.models.length}`],
  ]
    .map(([key, value]) => `<div class="stat"><dt>${key}</dt><dd>${value}</dd></div>`)
    .join("");
}

function currencyOf(data) {
  return data?.pricing?.currency || "CNY";
}

function railTools() {
  if (!local.batch) {
    return `<button class="btn ghost sm" type="button" data-action="batch">批量管理</button>`;
  }

  const count = local.selected.size;
  return `
    <span class="batch-count">已选 ${count}</span>
    <button class="link-btn" type="button" data-action="select-all">全选</button>
    <button class="link-btn" type="button" data-action="select-none">清除</button>
    <button class="btn danger sm" type="button" data-action="bulk-remove" ${count ? "" : "disabled"}>移出所选</button>
    <button class="btn sm" type="button" data-action="batch-done">完成</button>
  `;
}

function rowHtml(model, index, data) {
  const status = statusOf(model, data.chain);
  const current = data.chain.effective === model.code;
  const selected = local.selected.has(model.code);
  const batch = local.batch;

  const grip = batch
    ? `<label class="rail-check"><input type="checkbox" value="${esc(model.code)}" data-action="select-row" ${
        selected ? "checked" : ""
      } aria-label="选择 ${esc(model.code)}"></label>`
    : `<span class="rail-grip" draggable="true" title="拖动调整优先级" aria-hidden="true"><span></span></span>`;

  return `
    <li class="rail-row${current ? " is-current" : ""}" data-code="${esc(model.code)}" data-tone="${status.tone}">
      ${grip}
      <span class="rail-rank">${String(index + 1).padStart(2, "0")}</span>
      <span class="rail-track" aria-hidden="true"><i class="rail-node"></i></span>
      <button class="rail-main" type="button" data-action="detail" data-code="${esc(model.code)}">
        <span class="rail-code">${esc(model.code)}</span>
        <span class="rail-meta">${esc(metaLine(model, data))}</span>
      </button>
      <span class="rail-status">
        <span class="rail-status-text" data-tone="${status.tone}" data-status="${esc(model.code)}">${esc(
          status.text,
        )}</span>
        ${countdownHtml(status)}
      </span>
      <span class="rail-act">
        ${
          batch
            ? ""
            : `<button class="icon-btn" type="button" data-action="row-menu" data-code="${esc(
                model.code,
              )}" aria-label="${esc(model.code)} 的操作菜单" aria-haspopup="menu">⋯</button>`
        }
      </span>
    </li>
  `;
}

function metaLine(model, data) {
  return [
    model.family || "Other",
    providerLabel(model, data),
    `${fmtInt(model.requests)} 次请求`,
    `${fmtTokens(tokensOf(model))} tokens`,
  ].join(" · ");
}

/** 模型 code 形如 `提供商/模型名`；取最长的提供商 id 前缀。 */
function providerIdFromCode(code, data) {
  const providers = [...(data.providers || [])].sort((a, b) => b.id.length - a.id.length);
  return providers.find((provider) => code?.startsWith(`${provider.id}/`))?.id || "";
}

function providerLabel(model, data) {
  const id = model?.provider || providerIdFromCode(model?.code, data) || data.defaultProvider;
  const provider = (data.providers || []).find((item) => item.id === id);
  return provider ? provider.label || provider.id : id || "默认提供商";
}

function tokensOf(model) {
  return inputTokens(model) + (model.completionTokens || 0);
}

function inputTokens(row) {
  return Math.max(0, (row.promptTokens || 0) - (row.cachedPromptTokens || 0));
}

function cacheRate(row) {
  const tracked = row.cacheTrackedPromptTokens || 0;
  if (tracked <= 0) return null;
  return Math.min(1, Math.max(0, (row.cachedPromptTokens || 0) / tracked));
}

function policyHtml(data) {
  const chain = data.chain;
  const config = store.config?.config;
  const failover = config?.failover;
  const cooldown =
    failover && Number.isFinite(Number(failover.throttleCooldownMs))
      ? Number(failover.throttleCooldownMs) >= 60_000
        ? `${Number(failover.throttleCooldownMs) / 60_000} 分钟`
        : `${Math.round(Number(failover.throttleCooldownMs) / 1000)} 秒`
      : "—";

  const rows = [
    [
      "上下文",
      `${fmtWindow(chain.context.window)} · ${chain.context.onOverflow === "reject" ? "超出拒绝" : "超出透传"}`,
    ],
    [
      "失效重试",
      chain.retryDeadAfterMinutes > 0 ? `${fmtMinutes(chain.retryDeadAfterMinutes)}后` : "手动重置",
    ],
    ["限流冷却", cooldown],
    ["最多尝试", failover ? `${failover.maxAttempts} 个模型` : "—"],
  ];

  return `
    <section class="side-sec">
      <div class="sec-head">
        <h2 class="sec-title">链路策略</h2>
        <a class="policy-link" href="#/settings/failover">调整</a>
      </div>
      <dl class="policy">
        ${rows
          .map(
            ([key, value]) =>
              `<div class="policy-row"><dt class="policy-key">${key}</dt><dd class="policy-val">${esc(
                value,
              )}</dd></div>`,
          )
          .join("")}
      </dl>
    </section>
  `;
}

function recentHtml(data) {
  return `
    <section class="side-sec">
      <div class="sec-head">
        <h2 class="sec-title">最近事件</h2>
        <a class="sec-link" href="#/events">查看全部</a>
      </div>
      <div class="mini-events" id="mini-events">${miniEventsHtml(data)}</div>
    </section>
  `;
}

function miniEventsHtml(data) {
  const events = (data.events || []).slice(0, 7);
  if (!events.length) return `<p class="muted-note">暂无事件</p>`;
  return events
    .map(
      (event) => `
      <div class="mini-event">
        <span class="mini-time">${fmtClock(event.at)}</span>
        <span class="mini-msg" title="${esc(event.message)}">${esc(event.message)}</span>
      </div>`,
    )
    .join("");
}

function skeletonHtml() {
  const rows = Array.from({ length: 4 }, () => `<div class="sk" style="height:64px"></div>`).join("");
  return `
    <div class="sk-stack" aria-busy="true" aria-label="载入中">
      <div class="sk" style="width:150px;height:12px"></div>
      <div class="sk" style="width:min(380px,70%);height:28px"></div>
      <div class="sk" style="width:240px;height:12px"></div>
      <div class="sk" style="height:1px;margin:16px 0"></div>
      ${rows}
    </div>
  `;
}

function emptyHtml() {
  return `
    <div class="empty-page">
      <h1 class="page-title">模型</h1>
      <p class="page-sub">auto 请求会从列表最上方开始，失败时依次回退。</p>
      <div class="empty">
        <p class="empty-title">还没有模型</p>
        <p>添加一个模型后，auto 请求会从它开始。免费模型排在前面，额度用完再回退到付费模型。</p>
        <div class="empty-actions">
          <button class="btn primary" type="button" data-action="add">添加模型</button>
          <button class="btn" type="button" data-action="test">发送测试</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------- polling update ---------- */

function railSignature(chain) {
  return [
    chain.active,
    chain.effective,
    local.batch ? "1" : "0",
    ...chain.models.map(
      (model) =>
        `${model.code}:${model.health}:${model.throttledUntil || ""}:${model.checkedAt || ""}:${
          model.failures || 0
        }`,
    ),
  ].join("|");
}

function eventsSignature(data) {
  const first = data.events?.[0];
  return first ? `${first.id}:${data.events.length}` : "0";
}

function configSignatureNow() {
  const config = store.config?.config;
  return config
    ? `${config.failover?.maxAttempts}:${config.failover?.throttleCooldownMs}`
    : "none";
}

function update() {
  if (!rootEl) return;
  const data = store.data;
  if (!data) return;

  if (!rootEl.querySelector(".output") && !rootEl.querySelector(".empty-page")) {
    paint();
    return;
  }

  if (!data.chain.models.length) {
    if (!rootEl.querySelector(".empty-page")) paint();
    return;
  }

  if (rootEl.querySelector(".empty-page")) {
    paint();
    return;
  }

  const output = rootEl.querySelector("#output-main");
  if (output) output.innerHTML = outputMainHtml(data);

  const statline = rootEl.querySelector("#statline");
  if (statline) statline.innerHTML = statsHtml(data);

  const nextSignature = railSignature(data.chain);
  const nextConfigSignature = configSignatureNow();
  if (nextSignature !== signature) {
    if (local.dragging) return;

    const focusedCode = document.activeElement?.closest?.(".rail-row")?.dataset.code;
    const rail = rootEl.querySelector("#rail");
    if (rail) {
      rail.innerHTML = data.chain.models.map((model, index) => rowHtml(model, index, data)).join("");
      if (focusedCode) {
        rail
          .querySelector(`.rail-row[data-code="${escapeSelector(focusedCode)}"] .rail-main`)
          ?.focus({ preventScroll: true });
      }
    }

    const tools = rootEl.querySelector(".rail-tools");
    if (tools) tools.innerHTML = railTools();

    const side = rootEl.querySelector(".side");
    if (side) side.innerHTML = policyHtml(data) + recentHtml(data);

    signature = nextSignature;
    eventSignature = eventsSignature(data);
    configSignature = nextConfigSignature;
  } else {
    updateCounts(data);

    if (nextConfigSignature !== configSignature) {
      const side = rootEl.querySelector(".side");
      if (side) side.innerHTML = policyHtml(data) + recentHtml(data);
      configSignature = nextConfigSignature;
      eventSignature = eventsSignature(data);
    } else {
      const nextEvents = eventsSignature(data);
      if (nextEvents !== eventSignature) {
        const host = rootEl.querySelector("#mini-events");
        if (host) host.innerHTML = miniEventsHtml(data);
        eventSignature = nextEvents;
      }
    }
  }

  tickCountdowns(rootEl);
}

function updateCounts(data) {
  for (const row of rootEl.querySelectorAll(".rail-row")) {
    const model = data.chain.models.find((item) => item.code === row.dataset.code);
    const meta = row.querySelector(".rail-meta");
    if (model && meta) meta.textContent = metaLine(model, data);
  }
}

function escapeSelector(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

/* ---------- actions ---------- */

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const code = target.dataset.code;

  switch (action) {
    case "add":
      event.preventDefault();
      openAddSheet(viewCtx);
      break;
    case "test":
      event.preventDefault();
      openTest(viewCtx);
      break;
    case "batch":
      local.batch = true;
      local.selected.clear();
      signature = "";
      update();
      break;
    case "batch-done":
      local.batch = false;
      local.selected.clear();
      signature = "";
      update();
      break;
    case "select-all":
      for (const model of store.data.chain.models) local.selected.add(model.code);
      refreshBatch();
      break;
    case "select-none":
      local.selected.clear();
      refreshBatch();
      break;
    case "bulk-remove":
      bulkRemove(viewCtx);
      break;
    case "row-menu":
      openRowMenu(target, code, viewCtx);
      break;
    case "detail":
      openDetail(code, viewCtx);
      break;
    default:
      break;
  }
}

function onChange(event) {
  const input = event.target;
  if (input.dataset.action !== "select-row") return;

  if (input.checked) local.selected.add(input.value);
  else local.selected.delete(input.value);

  refreshTools();
}

function refreshTools() {
  const tools = rootEl?.querySelector(".rail-tools");
  if (tools) tools.innerHTML = railTools();
}

function refreshBatch() {
  if (!store.data) return;
  const rail = rootEl?.querySelector("#rail");
  if (rail) rail.innerHTML = store.data.chain.models.map((model, index) => rowHtml(model, index, store.data)).join("");
  refreshTools();
}

function openRowMenu(anchor, code, ctx) {
  const data = store.data;
  const model = data?.chain.models.find((item) => item.code === code);
  if (!model) return;

  const resetDisabled = !(
    model.health === "dead" ||
    model.health === "invalid" ||
    Boolean(model.throttledUntil)
  );

  openMenu(anchor, [
    {
      label: "设为当前输出",
      disabled: data.chain.active === code,
      action: () => setActive(code, ctx),
    },
    {
      label: "重置状态",
      disabled: resetDisabled,
      action: () => revive(code, ctx),
    },
    { label: "编辑 API 能力", action: () => openApis(code, ctx) },
    { separator: true },
    { label: "移出列表", danger: true, action: () => removeOne(code, ctx) },
  ]);
}

async function setActive(code, ctx) {
  try {
    await api.post("/api/chain/active", { model: code });
    toast(`当前输出已设为 ${code}`, "ok");
    await ctx.refresh();
  } catch (error) {
    toast(error.message, "bad", "设置失败");
  }
}

async function revive(code, ctx) {
  try {
    await api.post(`/api/models/${encodeURIComponent(code)}/revive`);
    toast(`${code} 已重置为未检测`, "ok");
    await ctx.refresh();
  } catch (error) {
    toast(error.message, "bad", "重置失败");
  }
}

async function removeOne(code, ctx) {
  const ok = await confirmDialog({
    title: "移出模型",
    message: `${code} 将从列表移除，auto 不再尝试它。`,
    confirmText: "移出",
    tone: "danger",
  });
  if (!ok) return;

  try {
    await api.del(`/api/chain/models/${encodeURIComponent(code)}`);
    toast(`已移出 ${code}`, "ok");
    await ctx.refresh();
    paint();
  } catch (error) {
    toast(error.message, "bad", "移出失败");
  }
}

async function bulkRemove(ctx) {
  const codes = [...local.selected];
  if (!codes.length) return;

  const ok = await confirmDialog({
    title: `移出 ${codes.length} 个模型`,
    message: codes.join("、"),
    confirmText: "移出",
    tone: "danger",
  });
  if (!ok) return;

  try {
    await api.post("/api/chain/models/remove", { models: codes });
    toast(`已移出 ${codes.length} 个模型`, "ok");
    if (codes.length >= store.data.chain.models.length) local.batch = false;
    local.selected.clear();
    signature = "";
    await ctx.refresh();
    paint();
  } catch (error) {
    toast(error.message, "bad", "移出失败");
  }
}

/* ---------- reorder ---------- */

function onKeyDown(event) {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  const row = event.target.closest(".rail-row");
  if (!row) return;

  event.preventDefault();
  moveBy(row.dataset.code, event.key === "ArrowUp" ? -1 : 1, viewCtx);
}

function moveBy(code, delta, ctx) {
  const models = [...store.data.chain.models];
  const from = models.findIndex((model) => model.code === code);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= models.length) return;

  const [item] = models.splice(from, 1);
  models.splice(to, 0, item);
  applyOrder(models, ctx);
}

function onDragStart(event) {
  const grip = event.target.closest(".rail-grip");
  if (!grip) return;

  const row = grip.closest(".rail-row");
  if (!row) return;

  local.dragging = row.dataset.code;
  row.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", local.dragging);
}

function onDragOver(event) {
  if (!local.dragging) return;
  const row = event.target.closest(".rail-row");
  if (!row || row.dataset.code === local.dragging) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";

  const rect = row.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  clearDropMarks();
  row.classList.add(after ? "drop-after" : "drop-before");
}

function onDragLeave(event) {
  const row = event.target.closest(".rail-row");
  if (row) row.classList.remove("drop-before", "drop-after");
}

function onDrop(event) {
  if (!local.dragging) return;
  const row = event.target.closest(".rail-row");
  if (!row) return;

  event.preventDefault();
  const target = row.dataset.code;
  const after = row.classList.contains("drop-after");

  const models = [...store.data.chain.models];
  const from = models.findIndex((model) => model.code === local.dragging);
  if (from < 0) return;

  const [item] = models.splice(from, 1);
  const to = models.findIndex((model) => model.code === target);
  if (to < 0) models.push(item);
  else models.splice(after ? to + 1 : to, 0, item);

  const ctx = viewCtx;
  clearDrag();
  applyOrder(models, ctx);
}

function clearDrag() {
  local.dragging = null;
  clearDropMarks();
  for (const row of rootEl?.querySelectorAll(".rail-row") || []) {
    row.classList.remove("is-dragging");
  }
}

function clearDropMarks() {
  for (const row of rootEl?.querySelectorAll(".rail-row.drop-before, .rail-row.drop-after") || []) {
    row.classList.remove("drop-before", "drop-after");
  }
}

function applyOrder(models, ctx) {
  const data = store.data;
  if (!data) return;

  const codes = models.map((model) => model.code);
  data.chain.models = codes.map((code) => models.find((model) => model.code === code));
  signature = "";
  update();

  api
    .post("/api/chain/order", { models: codes })
    .then(() => ctx.refresh())
    .catch((error) => {
      toast(error.message, "bad", "调整顺序失败");
      ctx.refresh();
    });
}

/* ---------- detail / apis / provider ---------- */

function openDetail(code, ctx) {
  const data = store.data;
  const model = data?.chain.models.find((item) => item.code === code);
  if (!model) return;

  const status = statusOf(model, data.chain);
  const rows = [
    [
      "状态",
      `<span class="status-text" data-tone="${status.tone}">${esc(status.text)}</span> ${countdownHtml(
        status,
      )}`,
    ],
    ["厂商", esc(model.family || "—")],
    ["提供商", esc(providerLabel(model, data))],
    ["上游模型", `<span class="mono">${esc(model.upstream || "—")}</span>`],
    [
      "API 能力",
      (model.apis || []).map((item) => API_LABELS[item] || item).join(" / ") || "—",
    ],
    ["请求 / 失败", `${fmtInt(model.requests)} / ${fmtInt(model.failures)}`],
    [
      "Tokens",
      `${fmtTokens(tokensOf(model))}（输入 ${fmtTokens(inputTokens(model))} · 输出 ${fmtTokens(
        model.completionTokens,
      )}）`,
    ],
    ["缓存命中率", fmtPercent(cacheRate(model))],
    ["成本", fmtMoney(model.cost, currencyOf(data))],
    ["最近使用", fmtAgo(model.lastUsedAt)],
    ["最近检测", fmtDateTime(model.checkedAt)],
  ];

  const error = model.lastErrorMessage
    ? `<div class="notice detail-error" data-tone="bad">
        <div>
          <p class="notice-title">${esc(model.reason || "最近错误")}</p>
          <p class="mono">${esc(model.lastErrorMessage)}</p>
          ${
            model.lastStatusCode
              ? `<p class="muted">HTTP ${model.lastStatusCode}${
                  model.lastErrorCode ? ` · ${esc(model.lastErrorCode)}` : ""
                }</p>`
              : ""
          }
        </div>
      </div>`
    : "";

  openDialog({
    title: code,
    body: `<dl class="detail-grid">${rows
      .map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`)
      .join("")}</dl>${error}`,
    footer: `
      <button class="btn" type="button" data-act="revive">重置状态</button>
      <button class="btn" type="button" data-act="active">设为当前输出</button>
      <button class="btn danger" type="button" data-act="remove">移出列表</button>
    `,
    onMount(node) {
      node.querySelector('[data-act="revive"]').addEventListener("click", () => {
        node.close();
        revive(code, ctx);
      });
      node.querySelector('[data-act="active"]').addEventListener("click", () => {
        node.close();
        setActive(code, ctx);
      });
      node.querySelector('[data-act="remove"]').addEventListener("click", () => {
        node.close();
        removeOne(code, ctx);
      });
    },
  });
}

function openApis(code, ctx) {
  const model = store.data?.chain.models.find((item) => item.code === code);
  if (!model) return;

  const selected = new Set(model.apis || ["chat"]);
  const body = `
    <div class="chips" style="gap:14px">
      ${API_ORDER.map(
        (kind) => `
        <label class="check">
          <input type="checkbox" value="${kind}" ${selected.has(kind) ? "checked" : ""}>
          <span>${API_LABELS[kind]}</span>
        </label>`,
      ).join("")}
    </div>
    <p class="field-hint" style="margin-top:12px">auto 请求只会选择支持当前接口的模型，至少保留一个接口。</p>
    <p class="field-hint" id="api-error" style="color:var(--stop);margin-top:6px"></p>
  `;

  openDialog({
    title: `API 能力 · ${code}`,
    body,
    footer: `
      <button class="btn" type="button" data-act="cancel">取消</button>
      <button class="btn primary" type="button" data-act="save">保存</button>
    `,
    onMount(node) {
      const error = node.querySelector("#api-error");
      node.querySelector('[data-act="cancel"]').addEventListener("click", () => node.close());
      node.querySelector('[data-act="save"]').addEventListener("click", async () => {
        const apis = [...node.querySelectorAll("input:checked")].map((input) => input.value);
        if (!apis.length) {
          error.textContent = "至少选择一个接口";
          return;
        }
        try {
          await api.post(`/api/models/${encodeURIComponent(code)}/apis`, { apis });
          toast(`${code} 的 API 能力已更新`, "ok");
          node.close();
          await ctx.refresh();
        } catch (failure) {
          error.textContent = failure.message;
        }
      });
    },
  });
}

/* ---------- add model sheet ---------- */

function openAddSheet(ctx) {
  local.add = { query: "", filter: "untracked", selected: new Set() };

  const dialog = openDialog({
    title: "添加模型",
    className: "sheet",
    body: `
      <div class="sheet-tools">
        <input class="input" id="add-query" type="search" placeholder="搜索模型 code 或厂商" autocomplete="off">
        <div class="chips" id="add-filters">
          <button class="chip" type="button" data-filter="untracked" aria-pressed="true">未加入</button>
          <button class="chip" type="button" data-filter="all" aria-pressed="false">全部</button>
          <button class="chip" type="button" data-filter="alive" aria-pressed="false">可用</button>
        </div>
      </div>
      <div id="catalog-wrap">${catalogInner()}</div>
      <div class="manual-add">
        <label class="field-label" for="manual-code">手动添加</label>
        <div class="row-inline">
          <select class="select" id="manual-provider">${providerOptions()}</select>
          <input class="input mono" id="manual-code" placeholder="例如 qwen3.8-max-0902" autocomplete="off">
          <button class="btn" type="button" data-act="manual-add">加入</button>
        </div>
        <p class="field-hint">模型绑定到所选提供商；同一模型名挂在两个提供商下算两个模型。</p>
      </div>
    `,
    footer: `<div class="sheet-foot" id="add-foot">${addFootHtml()}</div>`,
    onMount(node) {
      bindAdd(node, ctx);
    },
  });

  return dialog;
}

function filteredCatalog() {
  const entries = store.data?.catalog?.models || [];
  const query = local.add.query.trim().toLowerCase();

  return entries.filter((entry) => {
    if (local.add.filter === "untracked" && entry.tracked) return false;
    if (local.add.filter === "alive" && entry.health !== "alive") return false;
    if (query) {
      const haystack = `${entry.code} ${entry.upstream || ""} ${entry.family || ""} ${entry.provider || ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function providerOptions() {
  const data = store.data;
  return (data?.providers || [])
    .map(
      (provider) =>
        `<option value="${esc(provider.id)}" ${provider.id === data.defaultProvider ? "selected" : ""}>${esc(
          provider.label || provider.id,
        )}</option>`,
    )
    .join("");
}

function catalogInner() {
  const entries = store.data?.catalog?.models || [];
  if (!entries.length) {
    return `<div class="catalog-empty">目录为空。先配置 API Key，然后点「刷新目录」。</div>`;
  }

  const filtered = filteredCatalog();
  if (!filtered.length) {
    return `<div class="catalog-list"><div class="catalog-empty">没有匹配的模型。</div></div>`;
  }

  return `<div class="catalog-list">${filtered.map(entryRow).join("")}</div>`;
}

function entryRow(entry) {
  const tracked = Boolean(entry.tracked);
  const checked = local.add.selected.has(entry.code);

  const state =
    entry.health === "alive"
      ? ["ready", "可用"]
      : entry.health === "dead"
        ? ["stop", "已失效"]
        : entry.health === "invalid"
          ? ["stop", "无效"]
          : ["idle", "未检测"];

  const provider = providerLabel(entry, store.data);

  return `
    <label class="catalog-row${tracked ? " is-tracked" : ""}">
      <input type="checkbox" value="${esc(entry.code)}" ${checked ? "checked" : ""} ${tracked ? "disabled" : ""}>
      <span class="catalog-main">
        <span class="catalog-code">${esc(entry.upstream || entry.code)}</span>
        <span class="catalog-meta">${esc(provider)} · ${esc(entry.family || "Other")}</span>
      </span>
      <span class="catalog-state status-text" data-tone="${state[0]}">${tracked ? "已在列表" : state[1]}</span>
    </label>
  `;
}

function addFootHtml() {
  const count = local.add.selected.size;
  return `
    <span class="sheet-count" id="add-count">${count ? `已选 ${count} 个` : "未选择模型"}</span>
    <button class="btn" type="button" data-act="refresh">刷新目录</button>
    <button class="btn primary" type="button" data-act="add-selected" ${count ? "" : "disabled"}>加入所选</button>
  `;
}

function bindAdd(node, ctx) {
  const query = node.querySelector("#add-query");
  const filters = node.querySelector("#add-filters");
  const wrap = node.querySelector("#catalog-wrap");
  const foot = node.querySelector("#add-foot");
  const manual = node.querySelector("#manual-code");
  const manualProvider = node.querySelector("#manual-provider");

  const rerenderList = () => {
    wrap.innerHTML = catalogInner();
  };
  const rerenderFoot = () => {
    foot.innerHTML = addFootHtml();
  };

  query.addEventListener("input", () => {
    local.add.query = query.value;
    rerenderList();
  });

  filters.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    local.add.filter = chip.dataset.filter;
    for (const item of filters.querySelectorAll("[data-filter]")) {
      item.setAttribute("aria-pressed", String(item === chip));
    }
    rerenderList();
  });

  wrap.addEventListener("change", (event) => {
    const input = event.target;
    if (input.type !== "checkbox") return;
    if (input.checked) local.add.selected.add(input.value);
    else local.add.selected.delete(input.value);
    rerenderFoot();
  });

  const addManual = async () => {
    const upstream = manual.value.trim();
    if (!upstream) {
      toast("请输入模型名", "warn");
      return;
    }
    const provider = manualProvider?.value || "";
    const code = provider && !upstream.startsWith(`${provider}/`) ? `${provider}/${upstream}` : upstream;
    try {
      await api.post("/api/chain/models", { code });
      toast(`已把 ${code} 加入模型列表`, "ok");
      manual.value = "";
      await ctx.refresh();
      rerenderList();
      rerenderFoot();
    } catch (error) {
      toast(error.message, "bad", "添加失败");
    }
  };

  manual.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addManual();
    }
  });

  node.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;

    const act = target.dataset.act;

    if (act === "manual-add") {
      event.preventDefault();
      await addManual();
      return;
    }

    if (act === "refresh") {
      event.preventDefault();
      target.disabled = true;
      target.textContent = "刷新中…";
      try {
        const result = await api.post("/api/catalog/refresh");
        toast(`目录已刷新，共 ${result.count ?? 0} 个模型`, "ok");
        await ctx.refresh();
        rerenderList();
        rerenderFoot();
      } catch (error) {
        toast(error.message, "bad", "刷新目录失败");
      } finally {
        target.disabled = false;
        target.textContent = "刷新目录";
      }
      return;
    }

    if (act === "add-selected") {
      event.preventDefault();
      const current = store.data.chain.models.map((model) => model.code);
      const added = [...local.add.selected].filter((code) => !current.includes(code));
      if (!added.length) return;

      target.disabled = true;
      try {
        await api.post("/api/chain/order", { models: [...current, ...added] });
        toast(`已加入 ${added.length} 个模型`, "ok");
        local.add.selected.clear();
        await ctx.refresh();
        rerenderList();
        rerenderFoot();
      } catch (error) {
        toast(error.message, "bad", "加入失败");
        target.disabled = false;
      }
    }
  });
}

/* ---------- quick test ---------- */

function openTest(ctx) {
  openDialog({
    title: "发送测试",
    body: `
      <p class="field-hint">发送一次真实的 auto 请求，会计入用量。不会自动运行，也不会探测模型。</p>
      <label class="field" style="margin-top:12px">
        <span class="field-label">提示词</span>
        <textarea class="textarea" id="test-prompt" rows="3" placeholder="输入一句话">${esc(
          local.test.prompt,
        )}</textarea>
      </label>
      <div class="test-result" id="test-result">${testResultHtml(local.test)}</div>
    `,
    footer: `
      <span class="dialog-note">从当前输出开始，失败时按列表回退</span>
      <button class="btn primary" type="button" data-act="run">发送</button>
    `,
    onMount(node) {
      const prompt = node.querySelector("#test-prompt");
      const result = node.querySelector("#test-result");
      const run = node.querySelector('[data-act="run"]');

      prompt.addEventListener("input", () => {
        local.test.prompt = prompt.value;
      });

      const send = async () => {
        if (local.test.running) return;
        local.test.running = true;
        local.test.result = null;
        local.test.error = null;
        run.disabled = true;
        run.textContent = "发送中…";
        result.innerHTML = `<p class="muted-note">请求中…</p>`;

        try {
          const data = await api.post("/api/test", {
            prompt: local.test.prompt.trim() || "你好，请回复一句话。",
          });
          local.test.result = data;
          local.test.error = data.ok ? null : data.message || "请求失败";
        } catch (error) {
          local.test.error = error.message;
        } finally {
          local.test.running = false;
          run.disabled = false;
          run.textContent = "发送";
          result.innerHTML = testResultHtml(local.test);
          ctx.refresh();
        }
      };

      run.addEventListener("click", send);
    },
  });
}

function testResultHtml(test) {
  if (test.running) return `<p class="muted-note">请求中…</p>`;
  if (!test.result && !test.error) return "";

  if (test.error && !test.result?.ok) {
    return `
      <div class="notice" data-tone="bad">
        <div>
          <p class="notice-title">请求失败</p>
          <p>${esc(test.error)}</p>
          ${attemptsHtml(test.result?.attempts)}
        </div>
      </div>
    `;
  }

  const result = test.result;
  const cache =
    result.usage?.cacheReported && result.usage.promptTokens > 0
      ? ` · 缓存 ${fmtPercent(result.usage.cachedPromptTokens / result.usage.promptTokens)}`
      : "";
  const usage = result.usage
    ? `${fmtInt(inputTokens(result.usage))} 输入 / ${fmtInt(result.usage.completionTokens)} 输出${cache}`
    : "未返回用量";

  return `
    <div class="test-meta">
      <span>命中 <strong>${esc(result.model || "—")}</strong></span>
      <span>耗时 <strong>${fmtMs(result.latencyMs)}</strong></span>
      <span>${esc(usage)}</span>
    </div>
    ${
      result.content
        ? `<pre class="test-content">${esc(result.content)}</pre>`
        : `<p class="muted-note">没有返回文本内容。</p>`
    }
    ${attemptsHtml(result.attempts)}
  `;
}

function attemptsHtml(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return "";

  return `
    <ol class="attempt-list" aria-label="尝试链路">
      ${attempts
        .map(
          (attempt) => `
        <li class="attempt">
          <span class="attempt-model">${esc(attempt.model)}</span>
          <span class="attempt-state" data-ok="${Boolean(attempt.ok)}">${
            attempt.ok ? "成功" : esc(FAILURE_LABELS[attempt.kind] || attempt.kind || "失败")
          }</span>
          <span class="attempt-ms">${fmtMs(attempt.latencyMs)}</span>
        </li>`,
        )
        .join("")}
    </ol>
  `;
}