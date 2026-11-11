const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const intFormat = new Intl.NumberFormat("zh-CN");

export function fmtInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? intFormat.format(Math.round(number)) : "0";
}

function trimDecimal(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export function fmtTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1e9) return `${trimDecimal(number / 1e9)}B`;
  if (number >= 1e6) return `${trimDecimal(number / 1e6)}M`;
  if (number >= 1e3) return `${trimDecimal(number / 1e3)}K`;
  return fmtInt(number);
}

export function fmtPercent(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${(number * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

const CURRENCY_SYMBOLS = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  KRW: "₩",
};

export function fmtMoney(value, currency = "CNY") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  if (number === 0) return `${symbol}0`;

  const abs = Math.abs(number);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  const text = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
  return `${symbol}${text}`;
}

export function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

export function fmtMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "不自动重试";
  if (value < 60) return `${Math.round(value)} 分钟`;
  const hours = value / 60;
  if (Number.isInteger(hours)) return `${hours} 小时`;
  return `${hours.toFixed(1)} 小时`;
}

export function fmtWindow(tokens) {
  const value = Number(tokens) || 0;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${trimDecimal(millions)}M`;
  }
  if (value >= 1_000) {
    // 上下文窗口习惯按 2 的幂称呼（262144 叫 256K），但 200000 这类十进制值
    // 也应显示成 200K；先取能整除的十进制，再退到整除的二进制。
    const decimal = value / 1_000;
    if (Number.isInteger(decimal)) return `${decimal}K`;
    if (value % 1024 === 0) return `${value / 1024}K`;
    return `${Math.round(decimal)}K`;
  }
  return fmtInt(value);
}

export function fmtMs(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function fmtUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${trimDecimal(value / (1024 * 1024))} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function fmtClock(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtAgo(iso) {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(iso);
}

export function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dayLabel(key) {
  if (key === "unknown") return "未知日期";
  const today = dayKey(new Date().toISOString());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate.toISOString());
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  return key;
}

/**
 * 选路状态。tone 决定颜色与轨道节点：
 * ready 就绪 / hold 冷却 / stop 失效或无效 / idle 未检测。
 */
export function statusOf(model, chain, now = Date.now()) {
  if (!model) {
    return { tone: "stop", text: "无可用模型", note: "列表为空" };
  }

  const throttleUntil = model.throttledUntil ? Date.parse(model.throttledUntil) : Number.NaN;
  if (Number.isFinite(throttleUntil) && throttleUntil > now) {
    return {
      tone: "hold",
      text: "冷却中",
      until: throttleUntil,
      prefix: "",
      suffix: "",
      done: "冷却结束",
    };
  }

  if (model.health === "alive") {
    return { tone: "ready", text: "就绪" };
  }

  if (model.health === "dead") {
    const retryMs = Math.max(0, Number(chain?.retryDeadAfterMinutes) || 0) * 60_000;
    const checkedAt = model.checkedAt ? Date.parse(model.checkedAt) : Number.NaN;
    if (retryMs > 0 && Number.isFinite(checkedAt)) {
      const due = checkedAt + retryMs;
      if (due > now) {
        return {
          tone: "stop",
          text: "已失效",
          until: due,
          prefix: "",
          suffix: "后重试",
          done: "可重试",
        };
      }
      return { tone: "stop", text: "已失效", note: "可重试" };
    }
    return {
      tone: "stop",
      text: "已失效",
      note: retryMs === 0 ? "不会自动重试" : "等待手动重置",
    };
  }

  if (model.health === "invalid") {
    return { tone: "stop", text: "无效", note: "不会自动恢复" };
  }

  return { tone: "idle", text: "未检测" };
}

export function tickCountdowns(scope = document) {
  const now = Date.now();
  for (const node of scope.querySelectorAll("[data-until]")) {
    const until = Number(node.dataset.until);
    if (!Number.isFinite(until)) continue;
    const left = until - now;
    if (left <= 0) {
      node.textContent = node.dataset.done || "即将重试";
      node.removeAttribute("data-until");
      continue;
    }
    node.textContent = `${node.dataset.prefix || ""}${fmtCountdown(left)}${node.dataset.suffix || ""}`;
  }
}

export function countdownHtml(status) {
  if (status.until) {
    return `<span class="rail-count" data-until="${status.until}" data-prefix="${esc(
      status.prefix || "",
    )}" data-suffix="${esc(status.suffix || "")}" data-done="${esc(status.done || "")}">${esc(
      `${status.prefix || ""}${fmtCountdown(status.until - Date.now())}${status.suffix || ""}`,
    )}</span>`;
  }
  if (status.note) return `<span class="rail-count">${esc(status.note)}</span>`;
  return "";
}

export const EVENT_KINDS = [
  ["start", "启动"],
  ["failover", "切换"],
  ["dead", "失效"],
  ["throttle", "限流"],
  ["revive", "恢复"],
  ["catalog", "目录"],
  ["config", "配置"],
  ["error", "错误"],
];

const EVENT_LABELS = new Map(EVENT_KINDS);

export function eventLabel(kind) {
  return EVENT_LABELS.get(kind) || kind || "事件";
}

export function eventTone(kind) {
  if (kind === "start" || kind === "revive" || kind === "catalog") return "ok";
  if (kind === "failover" || kind === "throttle" || kind === "config") return "hold";
  if (kind === "dead" || kind === "error") return "stop";
  return "idle";
}