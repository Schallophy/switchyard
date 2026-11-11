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

const FINISH_LABELS = {
  stop: "自然结束",
  length: "达到长度上限",
  tool_calls: "请求调用工具",
  content_filter: "触发内容过滤",
  completed: "正常完成",
  done: "正常完成",
  failed: "执行失败",
  incomplete: "未完成",
};

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
        <p class="page-sub">查看网关最近的模型响应。每条记录标注实际承接的模型、协议和结束原因；无文本内容时可展开原始响应。仅保存在内存中，重启后清空。</p>
      </div>
      <div class="page-tools">
        <span class="live-state">
          <span class="state-dot" id="live-dot" data-state="${local.connected ? "ok" : "bad"}"></span>
          <span id="live-text">${local.connected ? "实时连接" : "连接中…"}</span>
        </span>
        <button class="btn" type="button" data-action="scroll" id="live-scroll-btn">暂停滚动</button>
        <button class="btn" type="button" data-action="clear" title="清空实时输出，不影响历史记录">清空记录</button>
      </div>
    </div>

    <dl class="statline live-summary">
      <div class="stat"><dt>记录</dt><dd id="live-count">0</dd></div>
      <div class="stat"><dt>生成中</dt><dd id="live-streaming">0</dd></div>
      <div class="stat"><dt>失败</dt><dd id="live-errors">0</dd></div>
      <div class="stat"><dt>保留</dt><dd id="live-retention" title="仅保留最近若干条，单条正文过长会截断">—</dd></div>
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
      <input class="input events-search" id="live-search" type="search" placeholder="搜索模型、提供商、调用方或工具" autocomplete="off" aria-label="搜索实时输出">
      <label class="check live-errors-toggle"><input id="live-only-errors" type="checkbox"> 仅看失败</label>
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
      const tools = Array.isArray(session.toolCalls)
        ? session.toolCalls.map((call) => call.name || "").join(" ")
        : "";
      const haystack = `${session.model || ""} ${session.provider || ""} ${session.caller || ""} ${
        session.requested || ""
      } ${tools}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const TOOL_LABELS = {
  shell: "命令",
  write: "写入",
  edit: "编辑",
  read: "读取",
  grep: "内容搜索",
  glob: "文件匹配",
  webfetch: "网页抓取",
  task: "子任务",
  list: "目录",
  apply_patch: "补丁",
};

/** 不同客户端对同一类工具的叫法不一样，先归一到能识别的类型。 */
const TOOL_ALIASES = {
  bash: "shell",
  execute_command: "shell",
  run_command: "shell",
  run_shell_command: "shell",
  execute_bash: "shell",
  exec: "shell",
  terminal: "shell",
  replace_in_file: "edit",
  str_replace_editor: "edit",
  str_replace: "edit",
  read_file: "read",
  view_file: "read",
  open_file: "read",
  write_file: "write",
  write_to_file: "write",
  create_file: "write",
  search_files: "grep",
  ripgrep: "grep",
  list_files: "list",
  list_directory: "list",
  list_dir: "list",
  ls: "list",
  web_fetch: "webfetch",
  fetch: "webfetch",
};

function parseToolArgs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pick(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Cline / Roo 的 replace_in_file 用 SEARCH / REPLACE 分隔符表达改动。 */
function parseSearchReplace(diff) {
  if (typeof diff !== "string") return null;
  const match = /-{7} SEARCH\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n\+{7} REPLACE/.exec(diff);
  if (!match) return null;
  return { oldText: match[1], newText: match[2] };
}

function clipText(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(value) {
  const text = String(value ?? "").trim();
  return clipText(text.split(/\r?\n/, 1)[0] ?? "", 220);
}

function countLines(value) {
  const text = String(value ?? "");
  return text ? text.split(/\r?\n/).length : 0;
}

function pathView(value) {
  const full = String(value ?? "").trim();
  if (!full) return null;
  const sep = full.includes("\\") ? "\\" : "/";
  const parts = full.split(/[\\/]+/).filter(Boolean);
  const base = parts.at(-1) ?? full;
  const joined = parts.slice(0, -1).join(sep);
  const dir = full.startsWith("/") ? `/${joined}` : joined;
  return { base, dir, full };
}

function pathHtml(value) {
  const info = pathView(value);
  if (!info) return "";
  const dir = info.dir.length > 64 ? `…${info.dir.slice(-63)}` : info.dir;
  return `<div class="live-call-path" title="${esc(info.full)}">
    <code class="live-call-file">${esc(info.base)}</code>
    ${dir ? `<span class="live-call-dir">${esc(dir)}</span>` : ""}
  </div>`;
}

function prettyArgs(args) {
  const parsed = parseToolArgs(args);
  if (!parsed) return args;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return args;
  }
}

/** 把工具调用渲染成人能直接读的摘要，完整 JSON 仍可在原始响应里查。 */
export function toolCallHtml(call) {
  const name = typeof call?.name === "string" && call.name ? call.name : "tool";
  const args = typeof call?.arguments === "string" ? call.arguments : "";
  const parsed = parseToolArgs(args);
  const parts = [];

  const line = (value, className = "") => {
    if (value === undefined || value === null || value === "") return;
    const classes = className ? `live-call-line ${className}` : "live-call-line";
    parts.push(`<code class="${classes}">${esc(clipText(value, 600))}</code>`);
  };
  const note = (value) => {
    if (!value) return;
    parts.push(`<p class="live-call-note">${esc(value)}</p>`);
  };

  let kind = TOOL_ALIASES[name] ?? name;
  if (name === "str_replace_editor" && parsed) {
    const action = typeof parsed.command === "string" ? parsed.command : "";
    if (action === "view") kind = "read";
    else if (action === "create") kind = "write";
  }

  if (parsed) {
    switch (kind) {
      case "shell": {
        const command = textOf(pick(parsed, ["command", "cmd", "commands", "script"]));
        if (command) {
          parts.push(
            `<code class="live-call-line live-call-command"><span class="live-call-prompt">$</span> ${esc(
              clipText(command, 600),
            )}</code>`,
          );
        }
        const extras = [];
        const workdir = textOf(
          pick(parsed, ["workdir", "cwd", "working_directory", "workingDirectory"]),
        );
        if (workdir) extras.push(`工作目录 ${clipText(workdir, 180)}`);
        const timeout = pick(parsed, ["timeout", "timeout_ms", "timeoutMs"]);
        if (timeout !== undefined) {
          extras.push(
            Number.isFinite(Number(timeout))
              ? `超时 ${fmtInt(timeout)} ms`
              : `超时 ${clipText(timeout, 30)}`,
          );
        }
        const description = textOf(pick(parsed, ["description"]));
        if (description) extras.push(`说明 ${clipText(description, 180)}`);
        note(extras.join(" · "));
        break;
      }
      case "edit": {
        const path = textOf(
          pick(parsed, [
            "path",
            "filePath",
            "file_path",
            "file",
            "filename",
            "target_file",
            "targetFile",
          ]),
        );
        parts.push(pathHtml(path));

        let oldText = textOf(
          pick(parsed, ["oldString", "old_string", "old_str", "oldText", "old_text", "search", "old"]),
        );
        let newText = textOf(
          pick(parsed, ["newString", "new_string", "new_str", "newText", "new_text", "replace", "new"]),
        );
        const diffText = textOf(pick(parsed, ["diff", "patch", "input"]));
        if ((!oldText || !newText) && diffText) {
          const parsedDiff = parseSearchReplace(diffText);
          if (parsedDiff) {
            oldText = parsedDiff.oldText;
            newText = parsedDiff.newText;
          }
        }

        if (oldText || newText) {
          const diff = [];
          if (oldText) diff.push(`<span class="live-call-del">− ${esc(firstLine(oldText))}</span>`);
          if (newText) diff.push(`<span class="live-call-add">+ ${esc(firstLine(newText))}</span>`);
          parts.push(`<div class="live-call-diff">${diff.join("")}</div>`);
          parts.push(
            `<p class="live-call-stat"><span class="live-call-add">+${fmtInt(
              countLines(newText),
            )} 行</span><span class="live-call-del">−${fmtInt(countLines(oldText))} 行</span></p>`,
          );
        } else if (diffText) {
          note(`补丁 ${fmtInt(countLines(diffText))} 行`);
        }
        break;
      }
      case "write": {
        const path = textOf(
          pick(parsed, ["path", "filePath", "file_path", "file", "filename", "target_file", "targetFile"]),
        );
        parts.push(pathHtml(path));
        const content = textOf(
          pick(parsed, ["content", "file_text", "fileText", "file_content", "text"]),
        );
        if (content) {
          parts.push(
            `<p class="live-call-stat"><span class="live-call-add">+${fmtInt(
              countLines(content),
            )} 行</span><span class="live-call-size">${fmtInt(content.length)} 字符</span></p>`,
          );
        }
        break;
      }
      case "read": {
        const path = textOf(
          pick(parsed, ["path", "filePath", "file_path", "file", "filename", "target_file", "targetFile"]),
        );
        parts.push(pathHtml(path));
        const extras = [];
        if (parsed.offset !== undefined) extras.push(`从第 ${fmtInt(parsed.offset)} 行开始`);
        if (parsed.limit !== undefined) extras.push(`读取 ${fmtInt(parsed.limit)} 行`);
        if (parsed.range !== undefined) extras.push(`范围 ${clipText(textOf(parsed.range), 60)}`);
        note(extras.join(" · "));
        break;
      }
      case "grep": {
        line(textOf(pick(parsed, ["pattern", "regex", "query", "search"])), "live-call-pattern");
        const extras = [];
        const path = textOf(pick(parsed, ["path", "filePath", "file_path", "directory", "dir"]));
        if (path) extras.push(`范围 ${clipText(path, 180)}`);
        const include = textOf(pick(parsed, ["include", "glob", "file_pattern", "filePattern"]));
        if (include) extras.push(`文件 ${clipText(include, 80)}`);
        note(extras.join(" · "));
        break;
      }
      case "glob": {
        line(textOf(pick(parsed, ["pattern", "glob", "query"])), "live-call-pattern");
        const path = textOf(pick(parsed, ["path", "directory", "dir"]));
        if (path) note(`范围 ${clipText(path, 200)}`);
        break;
      }
      case "webfetch": {
        line(textOf(pick(parsed, ["url", "uri", "href"])));
        const format = textOf(pick(parsed, ["format"]));
        if (format) note(`格式 ${clipText(format, 40)}`);
        break;
      }
      case "task": {
        line(textOf(pick(parsed, ["description", "title"])));
        const prompt = textOf(pick(parsed, ["prompt", "message", "input"]));
        if (prompt) note(clipText(firstLine(prompt), 200));
        break;
      }
      case "list": {
        const dirPath = textOf(pick(parsed, ["path", "directory", "dir"]));
        if (dirPath) parts.push(pathHtml(dirPath));
        else note("当前目录");
        if (parsed.recursive) note("包含子目录");
        break;
      }
      case "apply_patch": {
        const patch = textOf(pick(parsed, ["input", "patch", "diff"]));
        if (patch) {
          const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
            (match) => match[1],
          );
          if (files.length) parts.push(files.map(pathHtml).join(""));
          const size = `补丁 ${fmtInt(countLines(patch))} 行`;
          note(files.length ? `涉及 ${fmtInt(files.length)} 个文件 · ${size}` : size);
        }
        break;
      }
    }
  }

  if (!parts.some(Boolean)) {
    const raw = args ? prettyArgs(args) : "（无参数）";
    parts.push(
      `<div class="live-call-fallback"><span class="live-call-label">参数</span><pre class="live-call-args">${esc(
        clipText(raw, 800),
      )}</pre></div>`,
    );
  }

  const label = TOOL_LABELS[kind];
  return `<div class="live-call" data-tool="${esc(name)}">
    <div class="live-call-head">
      <span class="live-call-title">${esc(label ?? name)}</span>
      ${label ? `<span class="live-call-name">${esc(name)}</span>` : ""}
    </div>
    <div class="live-call-body">${parts.filter(Boolean).join("")}</div>
  </div>`;
}

function cardHtml(session) {
  const status = session.status;
  const statusLabel = status === "streaming" ? "生成中" : status === "error" ? "失败" : "已完成";
  const toolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];
  const hasToolCalls = toolCalls.length > 0;
  const text = session.text || "";
  const showText = Boolean(text) || status === "streaming";
  const showEmpty = !showText && !hasToolCalls && !session.error;
  const rawOpen = !session.text && !hasToolCalls && !session.error;
  const usage = session.usage;
  const cachedTokens = usage ? Math.max(0, usage.cachedPromptTokens || 0) : 0;
  const inputTokens = usage ? Math.max(0, usage.promptTokens - cachedTokens) : 0;
  const meta = [
    [session.stream ? "流式" : "非流式", ""],
    [session.failovers > 0 ? `故障转移 ${fmtInt(session.failovers)} 次` : null, "hold"],
    [session.latencyMs > 0 ? fmtMs(session.latencyMs) : null, ""],
    [usage ? `输入 ${fmtTokens(inputTokens)}` : null, ""],
    [usage && cachedTokens > 0 ? `缓存 ${fmtTokens(cachedTokens)}` : null, ""],
    [usage ? `输出 ${fmtTokens(usage.completionTokens)}` : null, ""],
    [session.bytes > 0 ? fmtBytes(session.bytes) : null, ""],
    [session.truncated ? "已截断" : null, "hold"],
    [
      session.finishReason
        ? `结束原因：${FINISH_LABELS[session.finishReason] ?? session.finishReason}`
        : null,
      "",
    ],
  ]
    .filter(([text]) => Boolean(text))
    .map(([text, tone]) => `<span${tone ? ` data-tone="${tone}"` : ""}>${esc(text)}</span>`)
    .join("");

  return `
    <article class="live-item" data-live-id="${session.id}" data-status="${status}" data-api="${esc(
      session.api,
    )}" data-finish="${esc(session.finishReason || "")}">
      <header class="live-head">
        <time class="live-time" datetime="${esc(session.at)}">${fmtClock(session.at)}</time>
        <span class="api-badge" title="${esc(API_TITLES[session.api] ?? session.api)}">${esc(
          API_LABELS[session.api] ?? session.api,
        )}</span>
        <code class="live-model" title="${esc(session.model)}">${esc(session.model)}</code>
        <span class="live-chip">${esc(session.caller)}</span>
        ${
          session.provider && !session.model.startsWith(`${session.provider}/`)
            ? `<span class="live-chip">${esc(session.provider)}</span>`
            : ""
        }
        ${
          session.requested && session.requested !== session.model && session.requested !== "auto"
            ? `<span class="live-chip">请求 ${esc(session.requested)}</span>`
            : ""
        }
        <span class="live-status" data-status="${status}">${statusLabel}</span>
        <span class="live-meta">${meta}</span>
      </header>
      ${session.error ? `<div class="live-error">${esc(session.error)}</div>` : ""}
      ${showText ? `<pre class="live-text" data-role="text">${esc(text)}</pre>` : ""}
      ${hasToolCalls ? `<div class="live-calls">${toolCalls.map(toolCallHtml).join("")}</div>` : ""}
      ${showEmpty ? `<p class="live-empty">本轮响应没有文本内容</p>` : ""}
      ${session.rawLength > 0 && status !== "streaming"
        ? `<details class="live-raw"${rawOpen ? " open" : ""} data-live-raw="${session.id}">
          <summary>${rawOpen ? "原始响应 · 无文本内容" : "原始响应"}</summary>
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
    <p class="empty-title">${active ? "没有匹配的记录" : "暂无实时输出"}</p>
    <p>${
      active
        ? "调整关键词或协议筛选后重试。"
        : "发起一次模型请求后，响应会实时显示在这里。"
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