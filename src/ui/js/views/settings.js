import { api } from "../api.js";
import { esc, fmtBytes, fmtInt, fmtWindow } from "../format.js";
import { setConfig, store } from "../store.js";
import { confirmDialog, toast } from "../ui.js";

const SECTIONS = [
  ["gateway", "网关"],
  ["providers", "提供商"],
  ["pricing", "定价"],
  ["failover", "故障转移"],
  ["service", "服务"],
  ["log", "日志"],
  ["data", "数据"],
  ["raw", "原始 JSON"],
];

const SECTION_NAMES = new Set(SECTIONS.map(([key]) => key));

const WINDOW_MIN = 1_000;
const WINDOW_MAX = 10_000_000;
const WINDOW_PRESETS = [32_768, 131_072, 262_144, 524_288, 1_000_000];

/** 接受 `262144`、`256K`、`1M` 这类写法；K 按 1024，M 按 1,000,000。 */
function parseWindowTokens(text) {
  const normalized = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[,_\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(normalized);
  if (!match) {
    return { error: "无法识别，请填数字或 256K / 1M 这样的简写。" };
  }

  const unit = match[2];
  const scale = unit === "k" ? 1024 : unit === "m" ? 1_000_000 : 1;
  const value = Math.round(Number(match[1]) * scale);
  if (!Number.isFinite(value) || value < WINDOW_MIN || value > WINDOW_MAX) {
    return { error: `需在 ${fmtInt(WINDOW_MIN)} 到 ${fmtInt(WINDOW_MAX)} 之间。` };
  }
  return { value };
}

function windowHint(value) {
  return `= ${fmtInt(value)} tokens（${fmtWindow(value)}）；也可填 256K / 1M，1K = 1024。`;
}

let rootEl = null;
let viewCtx = null;
let abort = null;
let unloadHandler = null;
let docLinkHandler = null;

const local = {
  meta: null,
  config: null,
  rawText: "",
  section: "gateway",
  dirty: false,
  rawDirty: false,
  saving: false,
  errors: [],
  windowError: null,
};

export function mount(root, ctx) {
  rootEl = root;
  viewCtx = ctx;

  local.section = SECTION_NAMES.has(ctx.route.section) ? ctx.route.section : "gateway";
  local.errors = [];
  local.saving = false;
  local.dirty = false;
  local.rawDirty = false;
  local.windowError = null;

  if (store.config) seed(store.config);

  abort = new AbortController();
  const options = { signal: abort.signal };
  root.addEventListener("click", onClick, options);
  root.addEventListener("input", onFieldEdit, options);
  root.addEventListener("change", onFieldEdit, options);

  unloadHandler = (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", unloadHandler);

  // 顶栏导航在视图之外，单独拦截，避免未保存修改被静默丢弃。
  docLinkHandler = (event) => {
    if (event.defaultPrevented) return;
    const link = event.target.closest?.("a[href^='#/']");
    if (!link || rootEl?.contains(link)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!isDirty()) return;

    event.preventDefault();
    void (async () => {
      const ok = await confirmDialog({
        title: "放弃未保存的修改？",
        message: "离开设置会丢失尚未保存的修改。",
        confirmText: "放弃修改",
        tone: "danger",
      });
      if (!ok) return;
      local.dirty = false;
      local.rawDirty = false;
      window.location.hash = link.getAttribute("href");
    })();
  };
  document.addEventListener("click", docLinkHandler, true);

  if (local.config) paint();
  else {
    paintLoading();
    load();
  }

  return { update, destroy };
}

function destroy() {
  abort?.abort();
  abort = null;
  window.removeEventListener("beforeunload", unloadHandler);
  unloadHandler = null;
  if (docLinkHandler) document.removeEventListener("click", docLinkHandler, true);
  docLinkHandler = null;
  rootEl = null;
  viewCtx = null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function seed(meta) {
  local.meta = meta;
  local.config = clone(meta.config);
  local.rawText = meta.text || "";
  local.dirty = false;
  local.rawDirty = false;
  local.windowError = null;
}

async function load() {
  try {
    const meta = await api.get("/api/config");
    setConfig(meta);
    seed(meta);
    paint();
  } catch (error) {
    local.errors = [error.message];
    paint();
  }
}

async function reload() {
  try {
    const meta = await api.get("/api/config");
    setConfig(meta);
    seed(meta);
    local.errors = [];
    paint();
  } catch (error) {
    local.errors = [error.message];
    renderErrors();
    refreshSavebar();
  }
}

function isDirty() {
  return local.dirty || local.rawDirty;
}

function update() {
  if (!local.meta && store.config) {
    seed(store.config);
    paint();
  }
}

/* ---------- shell ---------- */

function paintLoading() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="settings">
      <nav class="subnav" aria-label="设置分组"></nav>
      <div class="settings-main">
        <div class="sk-stack" aria-busy="true" aria-label="载入中">
          <div class="sk" style="width:200px;height:22px"></div>
          <div class="sk" style="height:1px;margin:12px 0"></div>
          <div class="sk" style="height:32px"></div>
          <div class="sk" style="height:32px"></div>
          <div class="sk" style="height:32px"></div>
        </div>
      </div>
    </div>`;
}

function paint() {
  if (!rootEl) return;

  rootEl.innerHTML = `
    <div class="settings">
      <nav class="subnav" aria-label="设置分组">
        ${SECTIONS.map(
          ([key, label]) =>
            `<a href="#/settings/${key}" data-section="${key}" aria-current="${
              local.section === key
            }">${label}</a>`,
        ).join("")}
      </nav>
      <div class="settings-main">
        <h1 class="sr-only">设置</h1>
        <div id="settings-errors"></div>
        <div id="settings-panel">${panelHtml()}</div>
        <div class="savebar">
          <span class="savebar-text" id="save-text"></span>
          <div class="savebar-actions">
            <button class="btn" type="button" id="save-reset" data-action="reset" disabled>撤销修改</button>
            <button class="btn primary" type="button" id="save-submit" data-action="save" disabled>保存</button>
          </div>
        </div>
      </div>
    </div>
  `;

  renderErrors();
  refreshSavebar();
}

function paintSubnav() {
  for (const link of rootEl?.querySelectorAll(".subnav a[data-section]") || []) {
    link.setAttribute("aria-current", String(link.dataset.section === local.section));
  }
}

function paintPanel() {
  local.windowError = null;
  const panel = rootEl?.querySelector("#settings-panel");
  if (panel) panel.innerHTML = panelHtml();
}

function renderErrors() {
  const host = rootEl?.querySelector("#settings-errors");
  if (!host) return;

  if (!local.errors.length) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = `
    <div class="notice settings-errors" data-tone="bad">
      <div>
        <p class="notice-title">保存失败</p>
        <ul class="error-list">
          ${local.errors.map((error) => `<li>${esc(error)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;
}

function refreshSavebar() {
  const text = rootEl?.querySelector("#save-text");
  const reset = rootEl?.querySelector("#save-reset");
  const submit = rootEl?.querySelector("#save-submit");
  if (!text || !reset || !submit) return;

  const dirty = isDirty();
  const invalid = Boolean(local.windowError);
  text.classList.toggle("is-dirty", dirty || invalid);
  text.textContent = local.saving
    ? "保存中…"
    : invalid
      ? "上下文窗口格式不正确"
      : local.errors.length
        ? "保存失败，请修正后重试"
        : dirty
          ? local.rawDirty
            ? "原始 JSON 有未保存修改"
            : "有未保存修改"
          : "已保存";

  reset.disabled = (!dirty && !invalid) || local.saving;
  submit.disabled = !dirty || local.saving || invalid;
}

/* ---------- panels ---------- */

function panelHtml() {
  if (!local.config) {
    return `
      <div class="empty">
        <p class="empty-title">读取配置失败</p>
        <p>${esc(local.errors[0] || "请确认网关仍在运行，或直接编辑 config.json 后重启。")}</p>
        <div class="empty-actions">
          <button class="btn" type="button" data-action="retry">重新读取</button>
        </div>
      </div>`;
  }

  switch (local.section) {
    case "providers":
      return providersPanel();
    case "pricing":
      return pricingPanel();
    case "failover":
      return failoverPanel();
    case "service":
      return servicePanel();
    case "log":
      return logPanel();
    case "data":
      return dataPanel();
    case "raw":
      return rawPanel();
    default:
      return gatewayPanel();
  }
}

function gatewayPanel() {
  const config = local.config;
  const providerOptions = config.providers
    .map(
      (provider) =>
        `<option value="${esc(provider.id)}" ${
          provider.id === config.defaultProvider ? "selected" : ""
        }>${esc(provider.label || provider.id)}（${esc(provider.id)}）</option>`,
    )
    .join("");

  return `
    <section class="group">
      <div class="group-head">
        <h2>网关</h2>
        <p>监听地址、访问令牌和默认提供商。修改监听地址或端口后需要重启进程。</p>
      </div>
      <div class="fields">
        <label class="field">
          <span class="field-label">监听地址</span>
          <input class="input mono" data-path="host" value="${esc(config.host)}" autocomplete="off">
        </label>
        <label class="field">
          <span class="field-label">端口</span>
          <input class="input" type="number" min="1" max="65535" data-path="port" value="${config.port}">
        </label>
        <label class="field wide">
          <span class="field-label">网关访问令牌</span>
          <input class="input" type="password" data-path="gatewayToken" value="${esc(
            config.gatewayToken,
          )}" autocomplete="new-password" placeholder="留空表示不校验">
          <span class="field-hint">客户端通过 Authorization: Bearer 携带；留空会关闭校验。</span>
        </label>
        <label class="field">
          <span class="field-label">默认提供商</span>
          <select class="select" data-path="defaultProvider">${providerOptions}</select>
          <span class="field-hint">未单独指定提供商的模型走这里。</span>
        </label>
      </div>
    </section>
  `;
}

function providersPanel() {
  const providers = local.config.providers || [];

  return `
    <section class="group">
      <div class="group-head">
        <h2>提供商</h2>
        <p>上游 OpenAI 兼容接口。API Key 留空表示沿用已保存的值，不会回显。</p>
      </div>
      ${providers.map(providerHtml).join("")}
      <button class="btn" type="button" data-action="provider-add" style="margin-top:12px">添加提供商</button>
    </section>
  `;
}

function providerHtml(provider, index) {
  const key = keyStatus(provider);

  return `
    <details class="provider" data-provider-index="${index}">
      <summary>
        <span class="provider-id">${esc(provider.id)}</span>
        <span class="provider-label">${esc(provider.label)}</span>
        <span class="provider-key" data-ok="${key.ok}">${esc(key.text)}</span>
      </summary>
      <div class="provider-body">
        <div class="fields">
          <label class="field">
            <span class="field-label">id</span>
            <input class="input mono" data-provider-path="id" value="${esc(provider.id)}" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">显示名称</span>
            <input class="input" data-provider-path="label" value="${esc(provider.label)}" autocomplete="off">
          </label>
          <label class="field wide">
            <span class="field-label">Base URL</span>
            <input class="input mono" data-provider-path="baseUrl" value="${esc(
              provider.baseUrl,
            )}" placeholder="https://example.com/v1" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">API Key 环境变量</span>
            <input class="input mono" data-provider-path="apiKeyEnv" value="${esc(
              provider.apiKeyEnv,
            )}" placeholder="例如 DASHSCOPE_API_KEY" autocomplete="off">
          </label>
          <label class="field">
            <span class="field-label">API Key</span>
            <input class="input" type="password" data-provider-path="apiKey" value="" autocomplete="new-password" placeholder="${
              key.ok ? "已配置，留空保持" : "未配置"
            }">
          </label>
          <label class="field">
            <span class="field-label">请求超时（毫秒）</span>
            <input class="input" type="number" min="1000" max="600000" data-provider-path="requestTimeoutMs" value="${
              provider.requestTimeoutMs
            }">
          </label>
          <label class="check">
            <input type="checkbox" data-provider-path="injectStreamUsage" ${
              provider.injectStreamUsage ? "checked" : ""
            }>
            <span>流式请求注入 usage</span>
          </label>
        </div>
        <button class="btn danger sm provider-remove" type="button" data-action="provider-remove" data-index="${index}">移除提供商</button>
      </div>
    </details>
  `;
}

function keyStatus(provider) {
  const info = (local.meta?.keys || []).find((item) => item.id === provider.id);
  if (info) {
    return {
      ok: info.configured,
      text: info.configured ? `Key 已配置 · ${info.masked}` : "Key 未配置",
    };
  }
  if (provider.apiKey) return { ok: true, text: "Key 已填写（未保存）" };
  return { ok: false, text: "Key 未配置" };
}

function pricingPanel() {
  const pricing = ensurePricing();

  const codes = [];
  for (const code of local.config.chain?.models || []) {
    if (typeof code === "string" && code && !codes.includes(code)) codes.push(code);
  }
  for (const code of Object.keys(pricing.models)) {
    if (!codes.includes(code)) codes.push(code);
  }

  return `
    <section class="group">
      <div class="group-head">
        <h2>定价</h2>
        <p>按模型填写单价与峰谷时段。用量页、模型页会按这里估算成本；时段使用网关进程的本地时区，必须完整覆盖一整天。</p>
      </div>
      <div class="fields">
        <label class="field">
          <span class="field-label">货币</span>
          <input class="input mono" data-path="pricing.currency" value="${esc(
            pricing.currency,
          )}" placeholder="CNY" autocomplete="off">
          <span class="field-hint">只决定成本显示的符号，不做汇率换算。</span>
        </label>
        <label class="field">
          <span class="field-label">计价单位（tokens）</span>
          <input class="input" type="number" min="1" max="1000000000" step="1000" data-path="pricing.unit" value="${
            pricing.unit
          }">
          <span class="field-hint">单价的 token 基数；1000000 = 每百万 token 的价格。</span>
        </label>
      </div>
      <div class="price-list">
        ${
          codes.length
            ? codes.map((code) => priceModelHtml(code)).join("")
            : `<p class="field-hint">模型列表还是空的。先到「模型」页加入模型，再回来配置单价。</p>`
        }
      </div>
    </section>
  `;
}

function priceModelHtml(code) {
  const pricing = local.config.pricing;
  const entry = pricing.models[code];

  if (!entry) {
    return `
      <div class="price-model" data-price-model="${esc(code)}">
        <div class="price-head">
          <span class="price-code">${esc(code)}</span>
          <span class="price-state">未定价</span>
          <button class="btn ghost sm" type="button" data-action="price-add-model" data-code="${esc(
            code,
          )}">添加定价</button>
        </div>
      </div>`;
  }

  const tiers = entry.tiers || [];

  return `
    <div class="price-model" data-price-model="${esc(code)}">
      <div class="price-head">
        <span class="price-code">${esc(code)}</span>
        <span class="price-state">每 ${pricing.unit.toLocaleString("en-US")} tokens</span>
        <button class="btn danger sm" type="button" data-action="price-remove-model" data-code="${esc(
          code,
        )}">移除定价</button>
      </div>
      <div class="price-tiers">
        ${tiers.map((tier, index) => priceTierHtml(tier, index)).join("")}
      </div>
      <div class="price-foot">
        <button class="btn ghost sm" type="button" data-action="price-add-tier">添加时段</button>
        <button class="btn ghost sm" type="button" data-action="price-peak">峰谷两段</button>
        <span class="field-hint">起止相同表示全天；跨零点直接写 22:00 → 08:00。</span>
      </div>
    </div>`;
}

function priceTierHtml(tier, index) {
  return `
    <div class="price-tier" data-price-tier="${index}">
      <label class="price-cell">
        <span class="field-label">起</span>
        <input class="input mono" type="time" data-tier-field="from" value="${esc(tier.from)}">
      </label>
      <label class="price-cell">
        <span class="field-label">止</span>
        <input class="input mono" type="time" data-tier-field="to" value="${esc(tier.to)}">
      </label>
      <label class="price-cell">
        <span class="field-label">输入</span>
        <input class="input" type="number" min="0" step="any" data-tier-field="input" value="${tier.input}">
      </label>
      <label class="price-cell">
        <span class="field-label">缓存输入</span>
        <input class="input" type="number" min="0" step="any" data-tier-field="cachedInput" value="${
          tier.cachedInput
        }">
      </label>
      <label class="price-cell">
        <span class="field-label">输出</span>
        <input class="input" type="number" min="0" step="any" data-tier-field="output" value="${tier.output}">
      </label>
      <div class="price-cell price-actions">
        <button class="btn ghost sm" type="button" data-action="price-all-day" data-index="${index}">全天</button>
        <button class="btn danger sm" type="button" data-action="price-remove-tier" data-index="${index}">删除</button>
      </div>
    </div>`;
}

function ensurePricing() {
  local.config.pricing ||= { currency: "CNY", unit: 1_000_000, models: {} };
  local.config.pricing.models ||= {};
  local.config.pricing.currency ||= "CNY";
  local.config.pricing.unit ||= 1_000_000;
  return local.config.pricing;
}

function blankTier(from = "00:00", to = "00:00") {
  return { from, to, input: 0, cachedInput: 0, output: 0 };
}

function clockToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function minutesToClock(total) {
  const minutes = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 从中间切开最后一个时段，追加后仍然覆盖一整天且不重叠。 */
function splitLastTier(tiers) {
  const last = tiers[tiers.length - 1];
  const prices = { input: last.input, cachedInput: last.cachedInput, output: last.output };
  let from = clockToMinutes(last.from);
  let to = clockToMinutes(last.to);
  if (from === to) {
    from = 0;
    to = 1440;
  }
  const span = (to - from + 1440) % 1440 || 720;
  const mid = (from + Math.floor(span / 2)) % 1440;
  last.from = minutesToClock(from);
  last.to = minutesToClock(mid);
  tiers.push({ from: minutesToClock(mid), to: minutesToClock(to), ...prices });
}

function failoverPanel() {
  const chain = local.config.chain;
  const failover = local.config.failover;

  return `
    <section class="group">
      <div class="group-head">
        <h2>故障转移</h2>
        <p>auto 从 active 开始按列表顺序回退。失效的模型经过重试时间后会重新参与选路；无效模型不会自动恢复。</p>
      </div>
      <div class="fields">
        <div class="field">
          <label class="field-label" for="context-window">上下文窗口</label>
          <input class="input mono" id="context-window" type="text" autocomplete="off" spellcheck="false" data-path="chain.context.window" value="${
            chain.context.window
          }">
          <span class="chips window-presets" role="group" aria-label="常用上下文窗口">
            ${WINDOW_PRESETS.map(
              (value) =>
                `<button class="chip" type="button" data-window-preset="${value}" aria-pressed="${
                  chain.context.window === value
                }">${fmtWindow(value)}</button>`,
            ).join("")}
          </span>
          <span class="field-hint" data-window-hint>${windowHint(chain.context.window)}</span>
        </div>
        <label class="field">
          <span class="field-label">超出上下文</span>
          <select class="select" data-path="chain.context.onOverflow">
            ${options(
              [
                ["reject", "拒绝请求"],
                ["passthrough", "透传上游"],
              ],
              chain.context.onOverflow,
            )}
          </select>
          <span class="field-hint">拒绝会在本地直接返回错误，不消耗上游额度。</span>
        </label>
        <label class="field">
          <span class="field-label">失效后自动重试（分钟）</span>
          <input class="input" type="number" min="0" max="100000" step="1" data-path="chain.retryDeadAfterMinutes" value="${
            chain.retryDeadAfterMinutes
          }">
          <span class="field-hint">1440 = 24 小时；0 = 只手动重置。</span>
        </label>
        <label class="field">
          <span class="field-label">最多尝试模型数</span>
          <input class="input" type="number" min="1" max="32" data-path="failover.maxAttempts" value="${
            failover.maxAttempts
          }">
          <span class="field-hint">单次请求最多尝试几个模型。</span>
        </label>
        <label class="field">
          <span class="field-label">限流冷却（秒）</span>
          <input class="input" type="number" min="0" max="3600" data-path="failover.throttleCooldownMs" data-scale="1000" value="${Math.round(
            failover.throttleCooldownMs / 1000,
          )}">
          <span class="field-hint">触发限流后，多少秒内跳过该模型。</span>
        </label>
      </div>
    </section>
  `;
}

function servicePanel() {
  const config = local.config;

  return `
    <section class="group">
      <div class="group-head">
        <h2>服务</h2>
        <p>HTTP 请求体上限和跨域策略。看板关闭后只能直接编辑 config.json。</p>
      </div>
      <div class="fields">
        <label class="field">
          <span class="field-label">请求体上限（字节）</span>
          <input class="input" type="number" min="1024" max="268435456" data-path="server.maxBodyBytes" value="${
            config.server.maxBodyBytes
          }">
          <span class="field-hint">当前约 ${fmtBytes(config.server.maxBodyBytes)}。超出的请求直接返回 413。</span>
        </label>
        <div class="field">
          <span class="field-label">跨域</span>
          <label class="check">
            <input type="checkbox" data-path="server.cors" ${config.server.cors ? "checked" : ""}>
            <span>为 /v1/* 返回 CORS 头</span>
          </label>
          <span class="field-hint">浏览器直连网关时需要开启。</span>
        </div>
        <div class="field">
          <span class="field-label">看板</span>
          <label class="check">
            <input type="checkbox" data-path="ui.enabled" ${config.ui.enabled ? "checked" : ""}>
            <span>启用管理看板</span>
          </label>
          <span class="field-hint">关闭后静态资源不再提供；改回来需要编辑 config.json 并重启。</span>
        </div>
      </div>
    </section>
  `;
}

function logPanel() {
  const config = local.config;
  const dataDir = local.meta?.dataDir || "";

  return `
    <section class="group">
      <div class="group-head">
        <h2>日志</h2>
        <p>日志级别、输出文件与轮转策略。修改后立即生效。</p>
      </div>
      <div class="fields">
        <label class="field">
          <span class="field-label">级别</span>
          <select class="select" data-path="log.level">
            ${options(
              [
                ["debug", "debug · 详细"],
                ["info", "info · 常规"],
                ["warn", "warn · 仅警告"],
                ["error", "error · 仅错误"],
              ],
              config.log.level,
            )}
          </select>
        </label>
        <label class="field wide">
          <span class="field-label">日志文件</span>
          <input class="input mono" data-path="log.file" value="${esc(
            config.log.file,
          )}" placeholder="留空写入数据目录的 switchyard.log" autocomplete="off">
          <span class="field-hint">${
            dataDir ? `数据目录：${esc(dataDir)}` : "留空时使用数据目录下的 switchyard.log。"
          }</span>
        </label>
        <label class="field">
          <span class="field-label">轮转大小（MB）</span>
          <input class="input" type="number" min="0" max="10240" step="1" data-path="log.maxBytes" data-scale="1048576" value="${Math.round(
            ((config.log.maxBytes ?? 0) / 1_048_576) * 100,
          ) / 100}">
          <span class="field-hint">0 表示不轮转；默认 2 MB。</span>
        </label>
        <label class="field">
          <span class="field-label">保留份数</span>
          <input class="input" type="number" min="0" max="100" step="1" data-path="log.maxFiles" value="${config.log.maxFiles ?? 5}">
          <span class="field-hint">轮转后保留的旧文件数量（.1 … .N）。</span>
        </label>
      </div>
    </section>
  `;
}

function dataPanel() {
  const dataDir = local.meta?.dataDir || "";

  return `
    <section class="group">
      <div class="group-head">
        <h2>用量统计</h2>
        <p>清空看板上的请求、失败、切换与 Token 累计，让统计从当前时刻重新开始。</p>
      </div>
      <div class="fields">
        <div class="field wide">
          <span class="field-label">重置用量</span>
          <span class="field-hint">会清零用量页与模型页的累计计数（含缓存命中数），并删除调用方记录；模型健康状态、目录、事件和配置都会保留。历史数据没有缓存明细，无法回算真实输入，重置后新请求按真实新增输入统计。此操作不可撤销。</span>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn danger" type="button" data-action="reset-usage">重置用量统计</button>
            ${dataDir ? `<span class="field-hint">数据目录：${esc(dataDir)}</span>` : ""}
          </div>
        </div>
      </div>
    </section>
  `;
}

function rawPanel() {
  if (!local.rawDirty) local.rawText = rawFromConfig();

  return `
    <section class="group">
      <div class="group-head">
        <h2>原始 JSON</h2>
        <p>直接编辑 config.json。保存后立即生效；监听地址与端口仍需重启进程。</p>
      </div>
      <textarea class="textarea code-area" id="raw-text" spellcheck="false" aria-label="原始配置 JSON">${esc(
        local.rawText,
      )}</textarea>
      <p class="field-hint" style="margin-top:8px">${
        local.meta?.configPath ? `配置文件：${esc(local.meta.configPath)}` : ""
      }</p>
      <p class="field-hint" id="raw-error" style="color:var(--stop)"></p>
    </section>
  `;
}

function rawFromConfig() {
  return local.config ? `${JSON.stringify(local.config, null, 2)}\n` : "";
}

function options(pairs, selected) {
  return pairs
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
}

/* ---------- editing ---------- */

function onFieldEdit(event) {
  const element = event.target;

  if (element.id === "raw-text") {
    local.rawText = element.value;
    local.rawDirty = true;
    const error = rootEl?.querySelector("#raw-error");
    if (error) error.textContent = "";
    refreshSavebar();
    return;
  }

  const tierField = element.dataset.tierField;
  if (tierField) {
    const code = element.closest("[data-price-model]")?.dataset.priceModel;
    const index = Number(element.closest("[data-price-tier]")?.dataset.priceTier);
    const tier = code ? local.config?.pricing?.models?.[code]?.tiers?.[index] : null;
    if (!tier) return;

    tier[tierField] =
      tierField === "from" || tierField === "to" ? element.value : Number(element.value || 0);
    local.dirty = true;
    refreshSavebar();
    return;
  }

  const providerPath = element.dataset.providerPath;
  if (providerPath) {
    const holder = element.closest("[data-provider-index]");
    const index = Number(holder?.dataset.providerIndex);
    const provider = local.config?.providers?.[index];
    if (!provider) return;

    provider[providerPath] = readValue(element);
    local.dirty = true;

    if (providerPath === "id" || providerPath === "label") {
      const summary = holder.querySelector(".provider-id");
      const label = holder.querySelector(".provider-label");
      if (summary) summary.textContent = provider.id;
      if (label) label.textContent = provider.label;
    }

    refreshSavebar();
    return;
  }

  const path = element.dataset.path;
  if (!path || !local.config) return;

  if (path === "chain.context.window") {
    applyWindowInput(element);
    return;
  }

  let value = readValue(element);
  if (element.dataset.scale) value = Math.round(Number(value) * Number(element.dataset.scale));
  setPath(local.config, path, value);
  local.dirty = true;
  refreshSavebar();
}

function readValue(element) {
  if (element.type === "checkbox") return element.checked;
  if (element.type === "number") {
    const value = Number(element.value);
    return Number.isFinite(value) ? value : 0;
  }
  return element.value;
}

function applyWindowInput(element) {
  const result = parseWindowTokens(element.value);
  const hint = rootEl?.querySelector("[data-window-hint]");

  if (result.error) {
    local.windowError = result.error;
    element.setAttribute("aria-invalid", "true");
    if (hint) {
      hint.textContent = result.error;
      hint.dataset.tone = "bad";
    }
    refreshSavebar();
    return;
  }

  local.windowError = null;
  element.removeAttribute("aria-invalid");
  setPath(local.config, "chain.context.window", result.value);
  local.dirty = true;
  if (hint) {
    hint.textContent = windowHint(result.value);
    delete hint.dataset.tone;
  }
  syncWindowPresets(result.value);
  refreshSavebar();
}

function syncWindowPresets(value) {
  for (const chip of rootEl?.querySelectorAll("[data-window-preset]") ?? []) {
    chip.setAttribute("aria-pressed", String(Number(chip.dataset.windowPreset) === value));
  }
}

function setPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

/* ---------- actions ---------- */

async function onClick(event) {
  const link = event.target.closest("a[href^='#/']");
  if (link) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();

    const section = link.dataset.section;
    if (section) {
      switchSection(section);
      return;
    }

    if (isDirty()) {
      const ok = await confirmDialog({
        title: "放弃未保存的修改？",
        message: "离开设置会丢失尚未保存的修改。",
        confirmText: "放弃修改",
        tone: "danger",
      });
      if (!ok) return;
    }

    window.location.hash = link.getAttribute("href");
    return;
  }

  const preset = event.target.closest("[data-window-preset]");
  if (preset) {
    const input = rootEl?.querySelector('[data-path="chain.context.window"]');
    const value = Number(preset.dataset.windowPreset);
    if (!input || !local.config || !Number.isFinite(value)) return;

    input.value = String(value);
    input.removeAttribute("aria-invalid");
    local.windowError = null;
    if (value !== local.config.chain?.context?.window) {
      setPath(local.config, "chain.context.window", value);
      local.dirty = true;
    }
    const hint = rootEl?.querySelector("[data-window-hint]");
    if (hint) {
      hint.textContent = windowHint(value);
      delete hint.dataset.tone;
    }
    syncWindowPresets(value);
    refreshSavebar();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "retry") {
    paintLoading();
    load();
    return;
  }

  if (action === "reset") {
    restore();
    return;
  }

  if (action === "reset-usage") {
    const ok = await confirmDialog({
      title: "重置用量统计？",
      message:
        "用量页与模型页的请求、失败、切换和 Token 累计都会清零，调用方记录也会删除。模型状态、目录、事件与配置保留。此操作无法撤销。",
      confirmText: "重置用量",
      tone: "danger",
    });
    if (!ok) return;
    target.disabled = true;
    try {
      await api.post("/api/usage/reset");
      toast("用量统计已重置", "ok");
    } catch (error) {
      toast(error.message, "bad", "重置失败");
    } finally {
      target.disabled = false;
    }
    return;
  }

  if (action === "save") {
    save();
    return;
  }

  if (action.startsWith("price-")) {
    const pricing = ensurePricing();
    const modelEl = target.closest("[data-price-model]");
    const code = target.dataset.code || modelEl?.dataset.priceModel || "";
    const entry = pricing.models[code];

    if (action === "price-add-model") {
      pricing.models[code] = { tiers: [blankTier()] };
    } else if (action === "price-remove-model" && entry) {
      delete pricing.models[code];
    } else if (action === "price-add-tier" && entry?.tiers?.length) {
      splitLastTier(entry.tiers);
    } else if (action === "price-remove-tier" && entry) {
      entry.tiers.splice(Number(target.dataset.index), 1);
      if (entry.tiers.length === 0) delete pricing.models[code];
    } else if (action === "price-all-day" && entry) {
      const tier = entry.tiers[Number(target.dataset.index)];
      if (tier) {
        tier.from = "00:00";
        tier.to = "00:00";
      }
    } else if (action === "price-peak" && entry) {
      const base = entry.tiers[0] || blankTier();
      const prices = { input: base.input, cachedInput: base.cachedInput, output: base.output };
      entry.tiers = [
        { from: "08:00", to: "22:00", ...prices },
        { from: "22:00", to: "08:00", ...prices },
      ];
    } else {
      return;
    }

    local.dirty = true;
    paintPanel();
    refreshSavebar();
    return;
  }

  if (action === "provider-add") {
    local.config.providers.push({
      id: nextProviderId(local.config.providers),
      label: "新提供商",
      baseUrl: "",
      apiKeyEnv: "",
      apiKey: "",
      requestTimeoutMs: 90000,
      injectStreamUsage: false,
    });
    local.dirty = true;
    paintPanel();
    refreshSavebar();
    const added = rootEl.querySelector("details[data-provider-index]:last-of-type");
    if (added) added.open = true;
    return;
  }

  if (action === "provider-remove") {
    const index = Number(target.dataset.index);
    const provider = local.config.providers[index];
    if (!provider) return;

    if ((local.config.providers || []).length <= 1) {
      toast("至少需要一个提供商", "warn");
      return;
    }

    const ok = await confirmDialog({
      title: "移除提供商",
      message: `${provider.label || provider.id}（${provider.id}）将被移除。引用它的模型会回落到默认提供商。`,
      confirmText: "移除",
      tone: "danger",
    });
    if (!ok) return;

    local.config.providers.splice(index, 1);
    if (local.config.defaultProvider === provider.id) {
      local.config.defaultProvider = local.config.providers[0]?.id || "";
    }
    local.dirty = true;
    paintPanel();
    refreshSavebar();
  }
}

async function switchSection(section) {
  if (!SECTION_NAMES.has(section) || section === local.section) return;

  if (isDirty()) {
    const ok = await confirmDialog({
      title: "放弃未保存的修改？",
      message: "切换分组会丢失当前未保存的修改。",
      confirmText: "放弃修改",
      tone: "danger",
    });
    if (!ok) return;
    restore(false);
  }

  local.section = section;
  if (section === "raw" && !local.rawDirty) local.rawText = rawFromConfig();

  window.history.replaceState(null, "", `#/settings/${section}`);
  paintPanel();
  paintSubnav();
  refreshSavebar();
  window.scrollTo({ top: 0 });
}

function restore(repaint = true) {
  if (!local.meta) return;

  local.config = clone(local.meta.config);
  local.rawText = local.meta.text || "";
  local.dirty = false;
  local.rawDirty = false;
  local.errors = [];
  local.windowError = null;

  if (repaint) {
    renderErrors();
    paintPanel();
    refreshSavebar();
  }
}

function nextProviderId(providers) {
  let index = providers.length + 1;
  let id = `provider${index}`;
  while (providers.some((provider) => provider.id === id)) {
    index += 1;
    id = `provider${index}`;
  }
  return id;
}

async function save() {
  if (!isDirty() || local.saving) return;

  const useRaw = local.rawDirty;

  if (useRaw) {
    try {
      JSON.parse(local.rawText);
    } catch (error) {
      local.errors = [`JSON 格式错误：${error.message}`];
      renderErrors();
      const rawError = rootEl?.querySelector("#raw-error");
      if (rawError) rawError.textContent = error.message;
      refreshSavebar();
      return;
    }
  }

  local.saving = true;
  local.errors = [];
  renderErrors();
  refreshSavebar();

  try {
    const result = useRaw
      ? await api.put("/api/config", { text: local.rawText })
      : await api.put("/api/config", { config: local.config });

    local.saving = false;
    local.dirty = false;
    local.rawDirty = false;

    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    toast(warnings.length ? warnings.join("；") : "配置已保存", warnings.length ? "warn" : "ok", "配置");

    await reload();
    await viewCtx?.refresh();
  } catch (error) {
    local.saving = false;
    local.errors = error.details?.length ? error.details : [error.message];
    renderErrors();
    refreshSavebar();
    toast(error.message, "bad", "保存失败");
  }
}