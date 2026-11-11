import { api } from "../api.js";
import { esc, fmtAgo, fmtInt, fmtWindow } from "../format.js";
import { store } from "../store.js";
import { toast } from "../ui.js";

const SOURCE_FALLBACK = "https://artificialanalysis.ai/leaderboards/models";

const local = {
  data: null,
  loading: false,
  error: null,
  query: "",
  provider: "",
  onlyScored: true,
  onlySelected: false,
  selected: new Set(),
  adding: new Set(),
  trackedSignature: "",
};

let rootEl = null;
let viewCtx = null;
let abort = null;
let generation = 0;

export function mount(root, ctx) {
  rootEl = root;
  viewCtx = ctx;

  local.data = null;
  local.loading = true;
  local.error = null;
  local.query = "";
  local.provider = "";
  local.onlyScored = true;
  local.onlySelected = false;
  local.selected.clear();
  local.adding.clear();
  local.trackedSignature = "";

  abort = new AbortController();
  const options = { signal: abort.signal };
  root.addEventListener("click", onClick, options);
  root.addEventListener("change", onChange, options);
  root.addEventListener("input", onInput, options);

  const run = ++generation;
  paint();
  void load(run);

  return { update, destroy };
}

function destroy() {
  abort?.abort();
  abort = null;
  generation += 1;
  rootEl = null;
  viewCtx = null;
}

async function load(run, refresh = false) {
  if (run !== generation) return;
  local.loading = true;
  local.error = null;
  paint();

  try {
    const data = await api.get(`/api/capability${refresh ? "?refresh=1" : ""}`);
    if (run !== generation) return;
    local.data = data;
    if (data?.ok === false) local.error = data.error || "评分数据暂时不可用";
  } catch (error) {
    if (run !== generation) return;
    local.error = error.message || "评分数据加载失败";
  }

  if (run !== generation) return;
  local.loading = false;
  paint();
}

/* ---------- render ---------- */

function paint() {
  if (!rootEl) return;

  if (!local.data && local.loading) {
    rootEl.innerHTML = skeletonHtml();
    return;
  }

  const tracked = trackedSet();
  const rows = filteredRows();
  const models = dataModels();
  const source = local.data?.source;
  const sourceUrl = source?.url || SOURCE_FALLBACK;
  const sourceNote = source?.fetchedAt
    ? `${fmtAgo(source.fetchedAt)}更新${source.cached ? " · 内存缓存" : ""}`
    : "—";
  const matched = source?.matched ?? models.filter((model) => typeof model.score === "number").length;

  rootEl.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">模型排行</h1>
        <p class="page-sub">按 Artificial Analysis 的 Intelligence Index 给目录模型排序。勾选多个模型后点「按能力排序」查看从高到低的结果；排序和勾选只存在当前页面，不会写入配置，也不会自动加入模型列表。</p>
      </div>
      <div class="page-tools">
        <a class="link-btn" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer noopener">评分来源 ↗</a>
        <button class="btn" type="button" data-action="refresh" ${local.loading ? "disabled" : ""}>${
          local.loading ? "刷新中…" : "刷新评分"
        }</button>
      </div>
    </div>

    <dl class="statline rank-summary">
      <div class="stat"><dt>目录</dt><dd>${fmtInt(models.length)}</dd></div>
      <div class="stat"><dt>有评分</dt><dd>${fmtInt(matched)}</dd></div>
      <div class="stat"><dt>数据源</dt><dd title="Artificial Analysis 排行榜里的模型数 / 其中有评分的数量">${
        source ? `${fmtInt(source.scored)} / ${fmtInt(source.total)}` : "—"
      }</dd></div>
      <div class="stat"><dt>已加入</dt><dd>${fmtInt(tracked.size)}</dd></div>
      <div class="stat"><dt>已选</dt><dd id="rank-stat-selected">${fmtInt(local.selected.size)}</dd></div>
      <div class="stat"><dt>评分更新</dt><dd>${esc(sourceNote)}</dd></div>
    </dl>

    ${noticeHtml()}

    <div class="rank-toolbar">
      <div class="rank-filters">
        <input class="input" id="rank-query" type="search" value="${esc(local.query)}" placeholder="搜索模型 code、厂商或匹配名称" autocomplete="off" aria-label="搜索模型">
        <select class="select" id="rank-provider" aria-label="按提供商筛选">${providerOptions()}</select>
        <label class="check"><input id="rank-only-scored" type="checkbox" ${
          local.onlyScored ? "checked" : ""
        }> 只看有评分</label>
      </div>
      <div class="rank-actions">
        <span class="rank-visible" id="rank-visible"></span>
        <button class="btn ghost sm" type="button" data-action="select-visible">全选结果</button>
        <button class="btn ghost sm" type="button" data-action="toggle-selected" aria-pressed="${
          local.onlySelected ? "true" : "false"
        }" ${local.selected.size ? "" : "disabled"}>${
          local.onlySelected ? `返回全部结果（${local.selected.size}）` : `按能力排序（${local.selected.size}）`
        }</button>
        <button class="btn ghost sm" type="button" data-action="clear-selected" ${
          local.selected.size ? "" : "disabled"
        }>清空</button>
      </div>
    </div>

    <div id="rank-results">${resultsHtml(rows, tracked)}</div>
  `;

  local.trackedSignature = trackedSignature(tracked);
  updateControls(rows);
}

function skeletonHtml() {
  return `
    <div class="sk-stack" aria-busy="true" aria-label="载入排行">
      <div class="sk" style="width:180px;height:26px"></div>
      <div class="sk" style="width:70%;height:12px"></div>
      <div class="sk" style="height:1px;margin:18px 0"></div>
      <div class="sk" style="height:44px"></div>
      <div class="sk" style="height:44px"></div>
      <div class="sk" style="height:44px"></div>
      <div class="sk" style="height:44px"></div>
    </div>`;
}

function noticeHtml() {
  if (!local.error) return "";
  return `
    <div class="notice rank-notice" data-tone="bad">
      <div>
        <p class="notice-title">评分数据暂不可用</p>
        <p>${esc(local.error)}</p>
      </div>
      <button class="btn ghost sm" type="button" data-action="retry">重试</button>
    </div>`;
}

function providerOptions() {
  const models = dataModels();
  const counts = new Map();
  for (const model of models) {
    if (!model.provider) continue;
    counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
  }

  const labels = providerLabels();
  const ids = [...(store.data?.providers || []).map((provider) => provider.id), ...counts.keys()];
  const unique = [...new Set(ids)];

  const option = (value, label) =>
    `<option value="${esc(value)}" ${value === local.provider ? "selected" : ""}>${esc(label)}</option>`;

  return [
    option("", `全部提供商${models.length ? `（${models.length}）` : ""}`),
    ...unique.map((id) => option(id, `${labels.get(id) || id}${counts.has(id) ? `（${counts.get(id)}）` : ""}`)),
  ].join("");
}

function resultsHtml(rows, tracked) {
  const models = dataModels();
  if (!models.length) {
    if (local.error) return emptyHtml("无法载入评分", "检查网络或代理后点上方「刷新评分」重试。");
    return emptyHtml("目录为空", "先到「模型」页刷新目录，再回来按能力挑选模型。");
  }

  if (!rows.length) {
    if (local.onlySelected) return emptyHtml("还没有选择模型", "在全部结果里勾选模型后点「按能力排序」。");
    if (local.onlyScored && local.query.trim() === "") {
      return emptyHtml("没有可用的评分", "Artificial Analysis 暂时没有返回可匹配的评分，刷新评分或取消「只看有评分」查看全部模型。");
    }
    return emptyHtml("没有匹配的模型", "换个关键词或提供商试试。");
  }

  let rank = 0;
  const body = rows
    .map((model) => {
      const scored = typeof model.score === "number";
      if (scored) rank += 1;
      return rowHtml(model, scored ? rank : null, tracked);
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="table rank-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>提供商</th>
            <th class="num">能力分</th>
            <th class="num">上下文</th>
            <th class="col-action"><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function rowHtml(model, rank, tracked) {
  const score = typeof model.score === "number" ? model.score : null;
  const selected = local.selected.has(model.code);
  const added = tracked.has(model.code);
  const adding = local.adding.has(model.code);
  const labels = providerLabels();
  const provider = labels.get(model.provider) || model.provider || "—";

  const meta = [];
  if (model.matchedName) meta.push(`匹配 ${model.matchedName}`);
  else meta.push("未匹配评分");
  if (model.reasoning) meta.push("推理");
  if (model.contextWindow) meta.push(`${fmtWindow(model.contextWindow)} 上下文`);

  const scoreCell =
    score === null
      ? `<span class="rank-none">—</span>`
      : `<div class="rank-score-inner"><div class="rank-meter" title="Artificial Analysis Intelligence Index"><span style="width:${Math.max(
          2,
          Math.min(100, score),
        )}%"></span></div><strong>${score.toFixed(1)}</strong></div>`;

  const action = added
    ? `<span class="rank-added">已在列表</span>`
    : `<button class="btn sm" type="button" data-add="${esc(model.code)}" ${adding ? "disabled" : ""}>${
        adding ? "加入中…" : "添加"
      }</button>`;

  return `
    <tr class="${selected ? "is-selected" : ""} ${added ? "is-tracked" : ""}">
      <td data-label="模型">
        <div class="rank-model">
          <label class="rank-check" title="选择 ${esc(model.code)}">
            <input type="checkbox" data-pick="row" value="${esc(model.code)}" aria-label="选择 ${esc(
              model.code,
            )}" ${selected ? "checked" : ""}>
          </label>
          <span class="rank-no">${rank === null ? "—" : String(rank).padStart(2, "0")}</span>
          <div class="rank-model-main">
            <span class="rank-code">${esc(model.code)}</span>
            <span class="rank-meta">${esc(meta.join(" · "))}</span>
          </div>
        </div>
      </td>
      <td data-label="提供商">${esc(provider)}</td>
      <td class="num rank-score" data-label="能力分">${scoreCell}</td>
      <td class="num" data-label="上下文">${model.contextWindow ? fmtWindow(model.contextWindow) : "—"}</td>
      <td class="col-action">${action}</td>
    </tr>`;
}

function emptyHtml(title, text) {
  return `
    <div class="empty">
      <p class="empty-title">${esc(title)}</p>
      <p>${esc(text)}</p>
    </div>`;
}

function updateControls(rows) {
  if (!rootEl) return;

  const selected = local.selected.size;
  const count = rootEl.querySelector("#rank-stat-selected");
  if (count) count.textContent = fmtInt(selected);

  const visible = rootEl.querySelector("#rank-visible");
  if (visible) visible.textContent = `显示 ${fmtInt(rows.length)} 个`;

  const select = rootEl.querySelector('[data-action="select-visible"]');
  const all = rows.length > 0 && rows.every((model) => local.selected.has(model.code));
  if (select) {
    select.textContent = all ? "取消全选" : "全选结果";
    select.disabled = rows.length === 0;
  }

  const toggle = rootEl.querySelector('[data-action="toggle-selected"]');
  if (toggle) {
    toggle.disabled = selected === 0;
    toggle.setAttribute("aria-pressed", local.onlySelected ? "true" : "false");
    toggle.textContent = local.onlySelected ? `返回全部结果（${selected}）` : `按能力排序（${selected}）`;
  }

  const clear = rootEl.querySelector('[data-action="clear-selected"]');
  if (clear) clear.disabled = selected === 0;
}

/* ---------- data ---------- */

function dataModels() {
  return Array.isArray(local.data?.models) ? local.data.models : [];
}

function providerLabels() {
  return new Map((store.data?.providers || []).map((provider) => [provider.id, provider.label || provider.id]));
}

function trackedSet() {
  const tracked = new Set();
  for (const model of store.data?.chain?.models || []) tracked.add(model.code);
  for (const model of store.data?.catalog?.models || []) {
    if (model.tracked) tracked.add(model.code);
  }
  return tracked;
}

function trackedSignature(tracked) {
  return [...tracked].sort().join("|");
}

function filteredRows() {
  const query = local.query.trim().toLowerCase();
  let rows = dataModels();

  if (local.onlySelected && local.selected.size > 0) {
    rows = rows.filter((model) => local.selected.has(model.code));
  }
  if (local.onlyScored) rows = rows.filter((model) => typeof model.score === "number");
  if (local.provider) rows = rows.filter((model) => model.provider === local.provider);
  if (query) {
    rows = rows.filter((model) =>
      `${model.code} ${model.upstream || ""} ${model.family || ""} ${model.provider || ""} ${
        model.matchedName || ""
      } ${model.matchedSlug || ""}`
        .toLowerCase()
        .includes(query),
    );
  }

  return [...rows].sort((a, b) => {
    const left = typeof a.score === "number" ? a.score : Number.NEGATIVE_INFINITY;
    const right = typeof b.score === "number" ? b.score : Number.NEGATIVE_INFINITY;
    return right - left || a.code.localeCompare(b.code);
  });
}

/* ---------- events ---------- */

function refreshResults() {
  if (!rootEl) return;
  const tracked = trackedSet();
  const rows = filteredRows();
  const host = rootEl.querySelector("#rank-results");
  if (host) host.innerHTML = resultsHtml(rows, tracked);
  local.trackedSignature = trackedSignature(tracked);
  updateControls(rows);
}

function onInput(event) {
  if (event.target.id !== "rank-query") return;
  local.query = event.target.value;
  refreshResults();
}

function onChange(event) {
  const target = event.target;

  if (target.id === "rank-only-scored") {
    local.onlyScored = target.checked;
    refreshResults();
    return;
  }

  if (target.id === "rank-provider") {
    local.provider = target.value;
    refreshResults();
    return;
  }

  if (target.dataset.pick === "row") {
    const code = target.value;
    if (target.checked) local.selected.add(code);
    else local.selected.delete(code);
    if (local.selected.size === 0) local.onlySelected = false;
    refreshResults();
  }
}

async function onClick(event) {
  const target = event.target.closest("[data-action], [data-add]");
  if (!target) return;

  if (target.dataset.add) {
    event.preventDefault();
    void addModel(target.dataset.add);
    return;
  }

  const action = target.dataset.action;
  if (action === "refresh" || action === "retry") {
    void load(generation, true);
    return;
  }

  if (action === "select-visible") {
    const rows = filteredRows();
    const all = rows.length > 0 && rows.every((model) => local.selected.has(model.code));
    for (const model of rows) {
      if (all) local.selected.delete(model.code);
      else local.selected.add(model.code);
    }
    if (local.selected.size === 0) local.onlySelected = false;
    refreshResults();
    return;
  }

  if (action === "toggle-selected") {
    if (local.selected.size === 0) return;
    local.onlySelected = !local.onlySelected;
    refreshResults();
    return;
  }

  if (action === "clear-selected") {
    local.selected.clear();
    local.onlySelected = false;
    refreshResults();
  }
}

async function addModel(code) {
  if (!code || local.adding.has(code)) return;
  local.adding.add(code);
  refreshResults();

  try {
    await api.post("/api/chain/models", { code });
    toast(`已把 ${code} 加入模型列表`, "ok");
    await viewCtx?.refresh();
    if (rootEl) paint();
  } catch (error) {
    toast(error.message, "bad", "添加失败");
  } finally {
    local.adding.delete(code);
    refreshResults();
  }
}

/* ---------- update ---------- */

function update() {
  if (!rootEl) return;
  const next = trackedSignature(trackedSet());
  if (next === local.trackedSignature) return;
  paint();
}