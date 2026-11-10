import { esc, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPercent, fmtTokens } from "../format.js";
import { store } from "../store.js";

const COLUMNS = [
  ["lastApi", "协议", false],
  ["requests", "请求", true],
  ["failures", "失败", true],
  ["failovers", "切换", true],
  ["inputTokens", "输入", true],
  ["cacheRate", "缓存率", true],
  ["completionTokens", "输出", true],
  ["cost", "成本", true],
  ["lastSeenAt", "最近", true],
];

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

function apiBadge(api) {
  if (!api) return "—";
  const label = API_LABELS[api] ?? api;
  return `<span class="api-badge" title="${esc(API_TITLES[api] ?? api)}">${esc(label)}</span>`;
}

function protocolSummary() {
  const apis = store.data?.stats?.apis;
  if (!apis || typeof apis !== "object") return "—";
  const parts = Object.entries(apis)
    .filter(([, stat]) => (stat?.requests || 0) > 0)
    .sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0))
    .map(([kind, stat]) => `${API_LABELS[kind] ?? kind} ${fmtInt(stat.requests)}`);
  return parts.length ? parts.join(" · ") : "—";
}

const local = {
  sort: "inputTokens",
  dir: -1,
  expanded: new Set(),
};

let rootEl = null;
let abort = null;
let signature = null;

export function mount(root, ctx) {
  rootEl = root;
  local.sort = "inputTokens";
  local.dir = -1;
  local.expanded.clear();
  signature = null;

  abort = new AbortController();
  root.addEventListener("click", onClick, { signal: abort.signal });

  paint();
  return { update, destroy };
}

function destroy() {
  abort?.abort();
  abort = null;
  rootEl = null;
  signature = null;
}

function callers() {
  return Array.isArray(store.data?.callers) ? store.data.callers : [];
}

function paint() {
  if (!rootEl) return;
  const data = store.data;

  if (!data) {
    rootEl.innerHTML = `
      <div class="sk-stack" aria-busy="true" aria-label="载入中">
        <div class="sk" style="width:120px;height:24px"></div>
        <div class="sk" style="width:60%;height:12px"></div>
        <div class="sk" style="height:1px;margin:18px 0"></div>
        <div class="sk" style="height:44px"></div>
        <div class="sk" style="height:44px"></div>
        <div class="sk" style="height:44px"></div>
      </div>`;
    return;
  }

  const rows = sortedCallers();
  const total = summarize(rows);
  const currency = store.data?.pricing?.currency || "CNY";
  const untracked = Math.max(0, total.promptTokens - total.cacheTrackedPromptTokens);
  const inputTitle =
    untracked > 0
      ? `含 ${fmtInt(untracked)} 未上报缓存明细的历史输入，无法扣除缓存`
      : `原始输入 ${fmtInt(total.promptTokens)}，已扣除缓存命中`;

  rootEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">用量</h1>
        <p class="page-sub">按调用方 API Key 汇总请求、失败、切换与真实输入/输出 Token；输入为未命中缓存的部分，缓存命中率仅统计提供商上报了缓存明细的请求，成本按 config.json 的价格配置估算</p>
      </div>
    </div>

    <dl class="statline usage-summary">
      <div class="stat"><dt>调用方</dt><dd>${fmtInt(rows.length)}</dd></div>
      <div class="stat"><dt>请求</dt><dd>${fmtInt(total.requests)}</dd></div>
      <div class="stat"><dt>失败</dt><dd>${fmtInt(total.failures)}</dd></div>
      <div class="stat"><dt>切换</dt><dd>${fmtInt(total.failovers)}</dd></div>
      <div class="stat"><dt>协议</dt><dd title="按协议拆分的请求数">${protocolSummary()}</dd></div>
      <div class="stat"><dt>输入</dt><dd title="${esc(inputTitle)}">${fmtTokens(total.inputTokens)}</dd></div>
      <div class="stat"><dt>缓存命中率</dt><dd title="仅统计提供商上报了缓存明细的请求">${fmtPercent(cacheRate(total))}</dd></div>
      <div class="stat"><dt>输出</dt><dd>${fmtTokens(total.completionTokens)}</dd></div>
      <div class="stat"><dt>成本</dt><dd title="按 config.json 的价格配置估算，非提供商账单">${fmtMoney(
        total.cost,
        currency,
      )}</dd></div>
    </dl>

    ${
      rows.length
        ? tableHtml(rows, currency)
        : `<div class="empty">
            <p class="empty-title">还没有调用记录</p>
            <p>客户端第一次通过网关请求后，这里会按 API Key 汇总。控制台里的「发送测试」也会计入。</p>
          </div>`
    }
  `;

  signature = dataSignature(rows);
}

function sortedCallers() {
  const all = callers();
  const factor = local.dir;
  return [...all].sort((a, b) => {
    const left = sortValue(a, local.sort);
    const right = sortValue(b, local.sort);
    if (typeof left === "string" || typeof right === "string") {
      return String(left).localeCompare(String(right), "zh-CN") * factor;
    }
    return (left - right) * factor || a.label.localeCompare(b.label, "zh-CN");
  });
}

function inputTokens(row) {
  return Math.max(0, (row.promptTokens || 0) - (row.cachedPromptTokens || 0));
}

function cacheRate(row) {
  const tracked = row.cacheTrackedPromptTokens || 0;
  if (tracked <= 0) return null;
  return Math.min(1, Math.max(0, (row.cachedPromptTokens || 0) / tracked));
}

function sortValue(caller, key) {
  if (key === "lastSeenAt") return Date.parse(caller.lastSeenAt) || 0;
  if (key === "inputTokens") return inputTokens(caller);
  if (key === "cacheRate") return cacheRate(caller) ?? -1;
  if (key === "lastApi") return caller.lastApi ?? "";
  return Number(caller[key]) || 0;
}

function summarize(rows) {
  return rows.reduce(
    (sum, caller) => {
      sum.requests += caller.requests || 0;
      sum.failures += caller.failures || 0;
      sum.failovers += caller.failovers || 0;
      sum.inputTokens += inputTokens(caller);
      sum.promptTokens += caller.promptTokens || 0;
      sum.cachedPromptTokens += caller.cachedPromptTokens || 0;
      sum.cacheTrackedPromptTokens += caller.cacheTrackedPromptTokens || 0;
      sum.completionTokens += caller.completionTokens || 0;
      sum.cost += caller.cost || 0;
      return sum;
    },
    {
      requests: 0,
      failures: 0,
      failovers: 0,
      inputTokens: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheTrackedPromptTokens: 0,
      completionTokens: 0,
      cost: 0,
    },
  );
}

function tableHtml(rows, currency) {
  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>调用方</th>
            ${COLUMNS.map(([key, label, numeric]) => headerCell(key, label, numeric)).join("")}
            <th class="col-action"><span class="sr-only">详情</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => rowHtml(row, currency)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function headerCell(key, label, numeric) {
  const active = local.sort === key;
  const aria = active ? (local.dir === 1 ? "ascending" : "descending") : "none";
  return `<th class="${numeric ? "num" : ""}" aria-sort="${aria}">
    <button class="sort-btn" type="button" data-action="sort" data-key="${key}">${label}</button>
  </th>`;
}

function rowHtml(caller, currency) {
  const expanded = local.expanded.has(caller.id);
  const input = inputTokens(caller);
  const rate = cacheRate(caller);
  const tracked = caller.cacheTrackedPromptTokens || 0;
  const inputHint =
    tracked > 0
      ? `原始输入 ${fmtInt(caller.promptTokens)}，其中缓存命中 ${fmtInt(caller.cachedPromptTokens)}`
      : `原始输入 ${fmtInt(caller.promptTokens)}，历史数据未上报缓存明细，无法扣除`;

  const row = `
    <tr>
      <td data-label="调用方">
        <div class="caller-name">${esc(caller.label)}</div>
        <div class="caller-meta">${caller.lastModel ? esc(caller.lastModel) : "尚无模型"} · ${fmtAgo(
          caller.lastSeenAt,
        )}</div>
      </td>
      <td data-label="协议">${apiBadge(caller.lastApi)}</td>
      <td class="num" data-label="请求">${fmtInt(caller.requests)}</td>
      <td class="num" data-label="失败">${caller.failures > 0 ? `<span class="status-text" data-tone="hold">${fmtInt(caller.failures)}</span>` : "0"}</td>
      <td class="num" data-label="切换">${fmtInt(caller.failovers)}</td>
      <td class="num" data-label="输入" title="${esc(inputHint)}">${fmtTokens(input)}</td>
      <td class="num" data-label="缓存率">${fmtPercent(rate)}</td>
      <td class="num" data-label="输出">${fmtTokens(caller.completionTokens)}</td>
      <td class="num" data-label="成本" title="按 config.json 的价格配置估算">${fmtMoney(
        caller.cost,
        currency,
      )}</td>
      <td class="num" data-label="最近">${fmtAgo(caller.lastSeenAt)}</td>
      <td class="col-action">
        <button class="link-btn" type="button" data-action="expand" data-id="${esc(caller.id)}" aria-expanded="${expanded}">
          ${expanded ? "收起" : "详情"}
        </button>
      </td>
    </tr>
  `;

  if (!expanded) return row;

  return (
    row +
    `<tr class="table-detail">
      <td colspan="11">
        <div class="detail-strip">
          <span>输入（新增） <strong>${fmtInt(input)}</strong></span>
          <span>缓存命中 <strong>${fmtInt(caller.cachedPromptTokens)}</strong></span>
          <span>缓存命中率 <strong>${fmtPercent(rate)}</strong></span>
          <span>原始输入 <strong>${fmtInt(caller.promptTokens)}</strong></span>
          <span>输出 <strong>${fmtInt(caller.completionTokens)}</strong></span>
          <span>合计 <strong>${fmtInt(input + (caller.completionTokens || 0))}</strong></span>
          <span>成本 <strong>${fmtMoney(caller.cost, currency)}</strong></span>
          <span>首次出现 <strong>${fmtDateTime(caller.firstSeenAt)}</strong></span>
          <span>最近请求 <strong>${fmtDateTime(caller.lastSeenAt)}</strong></span>
          <span>最近模型 <strong>${esc(caller.lastModel || "—")}</strong></span>
          <span>最近协议 <strong>${esc(caller.lastApi ? API_LABELS[caller.lastApi] ?? caller.lastApi : "—")}</strong></span>
        </div>
      </td>
    </tr>`
  );
}

function dataSignature(rows) {
  return rows
    .map(
      (caller) =>
        `${caller.id}:${caller.requests}:${caller.failures}:${caller.failovers}:${caller.promptTokens}:${caller.cachedPromptTokens}:${caller.cacheTrackedPromptTokens}:${caller.completionTokens}:${caller.cost}:${caller.lastSeenAt}:${caller.lastApi ?? ""}`,
    )
    .join("|");
}

function update() {
  if (!rootEl || !store.data) return;

  const next = dataSignature(sortedCallers());
  if (signature !== null && next === signature) return;

  // 只在输入控件聚焦时暂停重绘，避免打断正在编辑的内容。
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    rootEl.contains(active) &&
    active.matches("input, textarea, select")
  ) {
    return;
  }

  paint();
}

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  if (target.dataset.action === "sort") {
    const key = target.dataset.key;
    if (local.sort === key) local.dir = -local.dir;
    else {
      local.sort = key;
      local.dir = -1;
    }
    paint();
    return;
  }

  if (target.dataset.action === "expand") {
    const id = target.dataset.id;
    if (local.expanded.has(id)) local.expanded.delete(id);
    else local.expanded.add(id);
    paint();
  }
}