/**
 * 模型能力评分来自 Artificial Analysis 的公开排行榜。
 *
 * 页面是 Next.js 的流式渲染结果，数据藏在 `self.__next_f.push([1,"..."])` 的
 * flight payload 里。这里只做两件事：把 payload 拼起来取出 `initialModels`，
 * 再用模型名把排行榜条目匹配到目录里的上游模型。
 *
 * 评分只缓存在进程内存里，不写磁盘，也不进入 config.json / state.json。
 */

const LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const EFFORT_SUFFIXES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
  "non-reasoning",
  "reasoning",
];

/** 这些后缀不改变模型本身，去掉后仍可视为同一个模型。 */
const VARIANT_SUFFIXES = ["free", "batch", "realtime", "online", "turbo", "latest", "preview", "exp"];

export interface CapabilityModel {
  slug: string;
  name: string;
  creator: string | null;
  /** Artificial Analysis Intelligence Index；页面里也可能出现 null。 */
  score: number | null;
  contextWindow: number | null;
  reasoning: boolean;
}

interface IndexedModel {
  model: CapabilityModel;
  /** 匹配这个 key 对 AA slug 做了多少归一化，0 表示原样。 */
  cost: number;
}

export type CapabilityIndex = Map<string, IndexedModel[]>;

export interface CapabilityMatch {
  model: CapabilityModel;
  cost: number;
}

export interface CapabilitySnapshot {
  models: CapabilityModel[];
  index: CapabilityIndex;
  fetchedAt: string | null;
  cached: boolean;
  total: number;
  scored: number;
  error: string | null;
}

interface CapabilityDataset {
  models: CapabilityModel[];
  index: CapabilityIndex;
  fetchedAt: number;
  total: number;
  scored: number;
}

let cache: CapabilityDataset | null = null;
let inflight: Promise<CapabilityDataset> | null = null;

/** 拉一份排行榜快照。首次访问会请求 Artificial Analysis，之后 10 分钟内走内存缓存。 */
export async function capabilitySnapshot(options: { refresh?: boolean; now?: number } = {}): Promise<CapabilitySnapshot> {
  const now = options.now ?? Date.now();
  if (!options.refresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return snapshotOf(cache, true, null);
  }

  if (inflight) {
    try {
      const dataset = await inflight;
      return snapshotOf(dataset, true, null);
    } catch {
      // 走到下面重新发起一次请求，把失败信息带回给调用方。
    }
  }

  const task = fetchDataset();
  inflight = task;
  try {
    const dataset = await task;
    cache = dataset;
    return snapshotOf(dataset, false, null);
  } catch (error) {
    if (cache) return snapshotOf(cache, true, describeError(error));
    return {
      models: [],
      index: new Map(),
      fetchedAt: null,
      cached: false,
      total: 0,
      scored: 0,
      error: describeError(error),
    };
  } finally {
    if (inflight === task) inflight = null;
  }
}

export const capabilitySourceUrl = LEADERBOARD_URL;

function snapshotOf(dataset: CapabilityDataset, cached: boolean, error: string | null): CapabilitySnapshot {
  return {
    models: dataset.models,
    index: dataset.index,
    fetchedAt: new Date(dataset.fetchedAt).toISOString(),
    cached,
    total: dataset.total,
    scored: dataset.scored,
    error,
  };
}

async function fetchDataset(): Promise<CapabilityDataset> {
  const response = await fetch(LEADERBOARD_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; Switchyard/0.1; +https://github.com/Schallophy/switchyard)",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  if (html.length > MAX_BODY_BYTES) throw new Error("排行榜页面过大");

  const models = parseLeaderboardHtml(html);
  if (models.length === 0) throw new Error("页面里没有找到模型数据");
  const scored = models.filter((model) => model.score !== null).length;
  if (scored === 0) throw new Error("排行榜里还没有评分数据");

  return {
    models,
    index: buildCapabilityIndex(models),
    fetchedAt: Date.now(),
    total: models.length,
    scored,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "请求 Artificial Analysis 超时";
    return error.message;
  }
  return String(error);
}

/** 从排行榜 HTML 里取得模型列表；导出用于单元测试。 */
export function parseLeaderboardHtml(html: string): CapabilityModel[] {
  const payload = flightPayload(html);
  if (!payload) return [];
  const raw = extractJsonArray(payload, "initialModels");
  if (!Array.isArray(raw)) return [];

  const models: CapabilityModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const slug = asString(record.slug);
    if (!slug) continue;
    models.push({
      slug,
      name: asString(record.name) ?? slug,
      creator: asString(record.modelCreatorName),
      score: asNumber(record.intelligenceIndex),
      contextWindow: asNumber(record.contextWindowTokens),
      reasoning: record.isReasoning === true,
    });
  }
  return models;
}

/** 把 Next.js 的多个 flight chunk 拼成一个可搜索的字符串。 */
function flightPayload(html: string): string {
  const pattern = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let payload = "";
  for (const match of html.matchAll(pattern)) {
    const encoded = match[1];
    if (!encoded) continue;
    try {
      payload += JSON.parse(encoded) as string;
    } catch {
      // 单个 chunk 损坏不应让整页数据失效。
    }
  }
  return payload;
}

/** 从字符串里取出 `"key":[...]` 后的数组，按括号配对并正确处理字符串转义。 */
function extractJsonArray(text: string, key: string): unknown[] | null {
  const marker = `"${key}":`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 为所有带评分的 AA 条目建匹配索引。每个 slug 会生成多个归一化 key，
 * 并记录归一化代价，匹配时优先选代价最低的条目。
 */
export function buildCapabilityIndex(models: CapabilityModel[]): CapabilityIndex {
  const index: CapabilityIndex = new Map();
  for (const model of models) {
    if (model.score === null) continue;
    for (const variant of nameVariants(model.slug)) {
      const list = index.get(variant.key) ?? [];
      const existing = list.find((entry) => entry.model.slug === model.slug);
      if (existing) {
        existing.cost = Math.min(existing.cost, variant.cost);
      } else {
        list.push({ model, cost: variant.cost });
      }
      index.set(variant.key, list);
    }
  }
  return index;
}

/** 把目录里的上游模型名匹配到 AA 条目；没有评分或匹配不到时返回 null。 */
export function matchCapability(index: CapabilityIndex, upstream: string): CapabilityMatch | null {
  let best: { model: CapabilityModel; cost: number; score: number } | null = null;

  for (const variant of nameVariants(upstream)) {
    for (const entry of index.get(variant.key) ?? []) {
      const cost = Math.max(variant.cost, entry.cost);
      const score = entry.model.score ?? Number.NEGATIVE_INFINITY;
      if (!best || cost < best.cost || (cost === best.cost && score > best.score)) {
        best = { model: entry.model, cost, score };
      }
    }
  }

  return best ? { model: best.model, cost: best.cost } : null;
}

function nameVariants(value: string): Array<{ key: string; cost: number }> {
  const base = normalizeModelName(value);
  if (!base) return [];

  const out = new Map<string, number>();
  const add = (key: string, cost: number) => {
    if (!key) return;
    const previous = out.get(key);
    if (previous === undefined || cost < previous) out.set(key, cost);
  };

  const noEffort = stripSuffix(base, EFFORT_SUFFIXES);
  const noVariant = stripSuffix(base, VARIANT_SUFFIXES);
  const noVariantDate = stripDate(noVariant);

  add(base, 0);
  add(noEffort, 1);
  add(noVariant, 1);
  add(stripDate(base), 2);
  add(noVariantDate, 2);
  add(stripSuffix(stripDate(base), EFFORT_SUFFIXES), 3);
  add(stripSuffix(noVariantDate, EFFORT_SUFFIXES), 3);

  return [...out].map(([key, cost]) => ({ key, cost }));
}

/** `提供商/模型名` 的上游部分可能还带厂商标识，例如 deepseek/deepseek-v4-pro。 */
export function normalizeModelName(value: string): string {
  let name = value.trim().toLowerCase();
  const firstSlash = name.indexOf("/");
  if (firstSlash >= 0) name = name.slice(firstSlash + 1);

  return name
    .replace(/[._\s]+/g, "-")
    .replace(/:[a-z0-9._-]+$/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripSuffix(value: string, suffixes: string[]): string {
  let out = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (out.endsWith(`-${suffix}`)) {
        out = out.slice(0, -(suffix.length + 1));
        changed = true;
      }
    }
  }
  return out;
}

function stripDate(value: string): string {
  return value.replace(/-(20\d{2}[-.]\d{2}[-.]\d{2}|\d{8}|\d{6}|\d{4})$/g, "");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}