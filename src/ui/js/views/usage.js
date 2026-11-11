import { esc, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPercent, fmtTokens } from "../format.js";
import { store } from "../store.js";

const COLUMNS = [
  ["requests", "请求", true],
  ["failures", "失败", true],
  ["failovers", "切换", true],
  ["promptTokens", "原始输入", true],
  ["cacheRate", "缓存率", true],
  ["completionTokens", "输出", true],
  ["cost", "成本", true],
  ["lastSeenAt", "最近", true],
];

const local = {
  sort: "promptTokens",
  dir: -1,
  expanded: new Set(),
};

let rootEl = null;
let abort = null;
let signature = null;

export function mount(root, ctx) {
  rootEl = root;
  local.sort = "promptTokens";
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
      ? `原始输入 ${fmtInt(total.promptTokens)}，其中 ${fmtInt(
          untracked,
        )} 来自未上报缓存明细的历史请求`
      : `原始输入 ${fmtInt(total.promptTokens)}，含缓存命中 ${fmtInt(total.cachedPromptTokens)}`;
  const cacheTitle = `缓存命中 ${fmtInt(total.cachedPromptTokens)}；命中率按提供商上报了缓存明细的 ${fmtInt(
    total.cacheTrackedPromptTokens,
  )} 个输入 Token 计算`;

  rootEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">用量</h1>
        <p class="page-sub">按调用方 API Key 汇总请求、失败、切换与 Token；原始输入包含缓存命中，缓存命中率只统计提供商上报了缓存明细的请求，成本按 config.json 的价格配置估算</p>
      </div>
    </div>

    <dl class="statline usage-summary">
      <div class="stat"><dt>调用方</dt><dd>${fmtInt(rows.length)}</dd></div>
      <div class="stat"><dt>请求</dt><dd>${fmtInt(total.requests)}</dd></div>
      <div class="stat"><dt>失败</dt><dd>${fmtInt(total.failures)}</dd></div>
      <div class="stat"><dt>切换</dt><dd>${fmtInt(total.failovers)}</dd></div>
      <div class="stat"><dt>原始输入</dt><dd title="${esc(inputTitle)}">${fmtTokens(
        total.promptTokens,
      )}</dd></div>
      <div class="stat"><dt>缓存命中</dt><dd title="${esc(cacheTitle)}">${fmtTokens(
        total.cachedPromptTokens,
      )}<small>${fmtPercent(cacheRate(total))}</small></dd></div>
      <div class="stat"><dt>输出</dt><dd>${fmtTokens(total.completionTokens)}</dd></div>
      <div class="stat"><dt>成本</dt><dd title="按 config.json 的价格配置估算，非提供商账单">${fmtMoney(
        total.cost,
        currency,
      )}</dd></div>
    </dl>

    ${rows.length ? costPanelHtml(total.breakdown, total.cost, currency) : ""}

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

/** 原始输入：与 OpenAI usage.promptTokens 一致，包含缓存命中部分。 */
function inputTokens(row) {
  return Math.max(0, Number(row.promptTokens) || 0);
}

function freshInputTokens(row) {
  return Math.max(0, inputTokens(row) - (Number(row.cachedPromptTokens) || 0));
}

function cacheRate(row) {
  const tracked = row.cacheTrackedPromptTokens || 0;
  if (tracked <= 0) return null;
  return Math.min(1, Math.max(0, (row.cachedPromptTokens || 0) / tracked));
}

/** 表格里的短相对时间，避免「29 分钟前」在窄列里竖排。完整时间放在 title。 */
function fmtRecent(iso) {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`;
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function breakdownOf(record) {
  const raw = record?.costBreakdown;
  return {
    input: Number(raw?.input) || 0,
    cachedInput: Number(raw?.cachedInput) || 0,
    output: Number(raw?.output) || 0,
    cacheSaved: Number(raw?.cacheSaved) || 0,
    estimated: Boolean(raw?.estimated),
  };
}

function addBreakdowns(left, right) {
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    output: left.output + right.output,
    cacheSaved: left.cacheSaved + right.cacheSaved,
    estimated: left.estimated || right.estimated,
  };
}

function costPanelHtml(breakdown, totalCost, currency, options = {}) {
  const { compact = false, title = "成本构成" } = options;
  const parts = [
    ["input", "输入", breakdown.input],
    ["cached", "缓存输入", breakdown.cachedInput],
    ["output", "输出", breakdown.output],
  ];
  const sum = parts.reduce((acc, [, , value]) => acc + value, 0);
  const total = Number.isFinite(totalCost) ? totalCost : sum;
  const estimated = breakdown.estimated
    ? `<span class="cost-badge" title="历史用量按 Token 与当前价格推算">估算</span>`
    : "";

  const bar =
    sum > 0
      ? `<div class="cost-bar" role="img" aria-label="${esc(
          parts.map(([, label, value]) => `${label} ${fmtMoney(value, currency)}`).join("，"),
        )}">${parts
          .filter(([, , value]) => value > 0)
          .map(
            ([kind, , value]) =>
              `<span class="cost-seg" data-kind="${kind}" style="width:${(
                (value / sum) *
                100
              ).toFixed(2)}%"></span>`,
          )
          .join("")}</div>`
      : `<div class="cost-bar is-empty" aria-hidden="true"></div>`;

  const legend =
    sum > 0
      ? `<dl class="cost-legend">${parts
          .map(
            ([kind, label, value]) => `
              <div class="cost-item">
                <dt><span class="cost-swatch" data-kind="${kind}" aria-hidden="true"></span>${label}</dt>
                <dd>${fmtMoney(value, currency)}</dd>
                <span class="cost-share">${((value / sum) * 100).toFixed(1)}%</span>
              </div>`,
          )
          .join("")}</dl>`
      : `<p class="cost-empty">还没有产生计费成本；免费模型或未配置价格时成本为 0。</p>`;

  const saved =
    breakdown.cacheSaved > 0
      ? `<p class="cost-foot">缓存节省约 <strong>${fmtMoney(
          breakdown.cacheSaved,
          currency,
        )}</strong>，按同一批 Token 未命中缓存计算</p>`
      : "";

  return `
    <section class="cost-panel${compact ? " is-compact" : ""}" aria-label="${esc(title)}">
      <div class="cost-head">
        <h2 class="cost-title">${esc(title)}</h2>
        ${estimated}
        <span class="cost-total" title="按 config.json 的价格配置估算">${fmtMoney(total, currency)}</span>
      </div>
      ${bar}
      ${legend}
      ${saved}
    </section>
  `;
}

function sortValue(caller, key) {
  if (key === "lastSeenAt") return Date.parse(caller.lastSeenAt) || 0;
  if (key === "cacheRate") return cacheRate(caller) ?? -1;
  return Number(caller[key]) || 0;
}

function summarize(rows) {
  return rows.reduce(
    (sum, caller) => {
      sum.requests += caller.requests || 0;
      sum.failures += caller.failures || 0;
      sum.failovers += caller.failovers || 0;
      sum.promptTokens += inputTokens(caller);
      sum.cachedPromptTokens += caller.cachedPromptTokens || 0;
      sum.cacheTrackedPromptTokens += caller.cacheTrackedPromptTokens || 0;
      sum.completionTokens += caller.completionTokens || 0;
      sum.cost += caller.cost || 0;
      sum.breakdown = addBreakdowns(sum.breakdown, breakdownOf(caller));
      return sum;
    },
    {
      requests: 0,
      failures: 0,
      failovers: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      cacheTrackedPromptTokens: 0,
      completionTokens: 0,
      cost: 0,
      breakdown: { input: 0, cachedInput: 0, output: 0, cacheSaved: 0, estimated: false },
    },
  );
}

function tableHtml(rows, currency) {
  return `
    <div class="table-wrap">
      <table class="table usage-table">
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
  return `<th class="col-${key}${numeric ? " num" : ""}" aria-sort="${aria}">
    <button class="sort-btn" type="button" data-action="sort" data-key="${key}">${label}</button>
  </th>`;
}

function rowHtml(caller, currency) {
  const expanded = local.expanded.has(caller.id);
  const raw = inputTokens(caller);
  const fresh = freshInputTokens(caller);
  const rate = cacheRate(caller);
  const tracked = caller.cacheTrackedPromptTokens || 0;
  const models = Array.isArray(caller.models) ? caller.models : [];
  const inputHint =
    tracked > 0
      ? `原始输入 ${fmtInt(raw)}，其中缓存命中 ${fmtInt(
          caller.cachedPromptTokens,
        )}，新增输入 ${fmtInt(fresh)}`
      : `原始输入 ${fmtInt(raw)}，历史数据未上报缓存明细，无法区分缓存命中`;
  const meta = [
    models.length > 1 ? `${fmtInt(models.length)} 个模型` : null,
    caller.lastModel || "尚无模型",
    fmtAgo(caller.lastSeenAt),
  ]
    .filter(Boolean)
    .join(" · ");

  const row = `
    <tr>
      <td data-label="调用方">
        <div class="caller-name">${esc(caller.label)}</div>
        <div class="caller-meta" title="${esc(meta)}">${esc(meta)}</div>
      </td>
      <td class="num" data-label="请求">${fmtInt(caller.requests)}</td>
      <td class="num" data-label="失败">${caller.failures > 0 ? `<span class="status-text" data-tone="hold">${fmtInt(caller.failures)}</span>` : "0"}</td>
      <td class="num" data-label="切换">${fmtInt(caller.failovers)}</td>
      <td class="num" data-label="原始输入" title="${esc(inputHint)}">${fmtTokens(raw)}</td>
      <td class="num" data-label="缓存率">${fmtPercent(rate)}</td>
      <td class="num" data-label="输出">${fmtTokens(caller.completionTokens)}</td>
      <td class="num" data-label="成本" title="按 config.json 的价格配置估算">${fmtMoney(
        caller.cost,
        currency,
      )}</td>
      <td class="num" data-label="最近" title="${esc(fmtAgo(caller.lastSeenAt))}">${fmtRecent(
        caller.lastSeenAt,
      )}</td>
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
      <td colspan="10">
        <div class="caller-detail">
          ${costPanelHtml(breakdownOf(caller), caller.cost, currency, {
            compact: true,
            title: "调用方成本构成",
          })}
          <div class="detail-strip">
            <span>新增输入 <strong>${fmtInt(fresh)}</strong></span>
            <span>缓存命中 <strong>${fmtInt(caller.cachedPromptTokens)}</strong></span>
            <span>缓存命中率 <strong>${fmtPercent(rate)}</strong></span>
            <span>输出 <strong>${fmtInt(caller.completionTokens)}</strong></span>
            <span>合计 Token <strong>${fmtInt(raw + (caller.completionTokens || 0))}</strong></span>
            <span>首次出现 <strong>${fmtDateTime(caller.firstSeenAt)}</strong></span>
            <span>最近请求 <strong>${fmtDateTime(caller.lastSeenAt)}</strong></span>
          </div>
          ${modelTableHtml(models, currency)}
        </div>
      </td>
    </tr>`
  );
}

function modelTableHtml(models, currency) {
  if (!models.length) return `<p class="muted-note">暂无模型明细。</p>`;

  return `
    <div class="model-usage">
      <div class="model-usage-head">
        <h3 class="model-usage-title">模型明细</h3>
        <span class="model-usage-count">${fmtInt(models.length)} 个模型</span>
      </div>
      <div class="table-wrap">
        <table class="table model-table usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th class="num">成功 / 失败</th>
              <th class="num">原始输入</th>
              <th class="num">缓存率</th>
              <th class="num">输出</th>
              <th class="num">成本</th>
              <th class="num col-lastSeenAt">最近</th>
            </tr>
          </thead>
          <tbody>
            ${models.map((model) => modelRowHtml(model, currency)).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function modelRowHtml(model, currency) {
  const legacy = !model.model;
  const name = legacy
    ? `<span class="model-name is-legacy" title="升级前累计的用量，无法拆分到具体模型">历史未归属</span>`
    : `<span class="model-name mono">${esc(model.model)}</span>`;
  const attempts = Number(model.attempts) || 0;
  const failures = Number(model.failures) || 0;
  const cached = Number(model.cachedPromptTokens) || 0;

  return `
    <tr>
      <td data-label="模型">${name}</td>
      <td class="num" data-label="成功 / 失败" title="共 ${fmtInt(attempts)} 次尝试">${fmtInt(
        model.requests,
      )} / ${
        failures > 0 ? `<span class="status-text" data-tone="hold">${fmtInt(failures)}</span>` : "0"
      }</td>
      <td class="num" data-label="原始输入" title="其中缓存命中 ${fmtInt(cached)}">${fmtTokens(
        model.promptTokens,
      )}</td>
      <td class="num" data-label="缓存率">${fmtPercent(cacheRate(model))}</td>
      <td class="num" data-label="输出">${fmtTokens(model.completionTokens)}</td>
      <td class="num" data-label="成本" title="按 config.json 的价格配置估算">${fmtMoney(
        model.cost,
        currency,
      )}</td>
      <td class="num" data-label="最近" title="${esc(fmtAgo(model.lastSeenAt))}">${fmtRecent(
        model.lastSeenAt,
      )}</td>
    </tr>
  `;
}

function dataSignature(rows) {
  return rows
    .map((caller) => {
      const breakdown = breakdownOf(caller);
      const models = (Array.isArray(caller.models) ? caller.models : [])
        .map(
          (model) =>
            `${model.model ?? ""}:${model.attempts}:${model.requests}:${model.failures}:${model.promptTokens}:${model.cachedPromptTokens}:${model.cacheTrackedPromptTokens}:${model.completionTokens}:${model.cost}:${model.lastSeenAt}`,
        )
        .join(",");
      return `${caller.id}:${caller.requests}:${caller.failures}:${caller.failovers}:${caller.promptTokens}:${caller.cachedPromptTokens}:${caller.cacheTrackedPromptTokens}:${caller.completionTokens}:${caller.cost}:${breakdown.input}:${breakdown.cachedInput}:${breakdown.output}:${breakdown.cacheSaved}:${breakdown.estimated}:${caller.firstSeenAt}:${caller.lastSeenAt}:${models}`;
    })
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
    rootEl?.querySelector(`[data-action="sort"][data-key="${key}"]`)?.focus({
      preventScroll: true,
    });
    return;
  }

  if (target.dataset.action === "expand") {
    const id = target.dataset.id;
    if (local.expanded.has(id)) local.expanded.delete(id);
    else local.expanded.add(id);
    paint();
    focusExpandButton(id);
  }
}

/** 重绘会替换按钮，键盘操作后把焦点还给同一个「详情 / 收起」。 */
function focusExpandButton(id) {
  if (!rootEl) return;
  for (const button of rootEl.querySelectorAll('[data-action="expand"]')) {
    if (button.dataset.id !== id) continue;
    button.focus({ preventScroll: true });
    return;
  }
}