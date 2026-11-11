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
const VARIANT_SUFFIXES = [
  "free",
  "batch",
  "realtime",
  "online",
  "turbo",
  "latest",
  "preview",
  "exp",
  "it",
  "instruct",
  "highspeed",
  "ultraspeed",
];

/** AA 的部分 slug 带厂商前缀，而目录里的上游名已经去掉了厂商层。 */
const VENDOR_PREFIXES = ["nvidia", "tencent"];

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
 * 为所有 AA 条目建匹配索引。带评分的条目正常入索引；未评分条目也入索引，
 * 用来阻止同名模型退而匹配到带后缀的相邻条目（例如未评分的 foo 挡住 foo-preview）。
 * 唯一的例外是 AA 同时提供了仅多日期后缀的有评分快照，此时以该快照为准。
 */
export function buildCapabilityIndex(models: CapabilityModel[]): CapabilityIndex {
  const superseded = dateSupersededSlugs(models);
  const index: CapabilityIndex = new Map();
  for (const model of models) {
    if (model.score === null && superseded.has(normalizeModelName(model.slug))) continue;
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

/**
 * 有评分且带日期后缀的 slug，例如 ling-3-1-flash-1019。
 * 对应的无日期条目往往是同一个模型的未评分快照，不应挡住这个评分。
 */
function dateSupersededSlugs(models: CapabilityModel[]): Set<string> {
  const superseded = new Set<string>();
  for (const model of models) {
    if (model.score === null) continue;
    const base = normalizeModelName(model.slug);
    const stripped = stripDate(base);
    if (stripped !== base) superseded.add(stripped);
  }
  return superseded;
}

/**
 * 把目录里的上游模型名匹配到 AA 条目；没有评分或匹配不到时返回 null。
 *
 * 只接受归一化代价最低的那一档候选：如果最低档只有未评分条目，说明目录里的
 * 就是那个未评分模型，不能退而求其次去匹配一个更不像的有评分模型。
 */
export function matchCapability(index: CapabilityIndex, upstream: string): CapabilityMatch | null {
  const candidates: Array<{ model: CapabilityModel; cost: number }> = [];

  for (const variant of nameVariants(upstream, { parameterAlias: true })) {
    for (const entry of index.get(variant.key) ?? []) {
      candidates.push({ model: entry.model, cost: Math.max(variant.cost, entry.cost) });
    }
  }
  if (candidates.length === 0) return null;

  let lowest = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) lowest = Math.min(lowest, candidate.cost);

  let best: CapabilityMatch | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = candidate.model.score;
    if (candidate.cost !== lowest || score === null) continue;
    if (!best || score > bestScore) {
      best = { model: candidate.model, cost: candidate.cost };
      bestScore = score;
    }
  }
  return best;
}

function nameVariants(value: string, options: { parameterAlias?: boolean } = {}): Array<{ key: string; cost: number }> {
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
  add(stripTrailingZero(base), 2);

  // 只对目录侧启用参数别名：把 muse-glimmer-30b 映射到 AA 的无尺寸名 muse-glimmer。
  // 反向不启用，避免把 llama-3-8b 之类的尺寸变体错误合并到另一个尺寸。
  if (options.parameterAlias) add(stripParameter(base), 2);

  for (const prefix of VENDOR_PREFIXES) {
    if (base.startsWith(`${prefix}-`)) add(base.slice(prefix.length + 1), 1);
  }

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

/** 只去掉一个表示 x.0 版本的结尾 `-0`，不碰更长的版本号。 */
function stripTrailingZero(value: string): string {
  return value.endsWith("-0") ? value.slice(0, -2) : value;
}

/**
 * 去掉结尾的模型尺寸（30b、120b、a3b、e4b…），把 muse-glimmer-30b 还原成 muse-glimmer。
 * 只在名字主体不含数字、且至少有两段时启用，避免把 qwen3-14b、deepseek-r1-8b
 * 之类的版本号当成尺寸剥掉。
 */
function stripParameter(value: string): string {
  const match = /-([a-z]?\d+(?:\.\d+)?[bm])$/.exec(value);
  if (!match) return value;
  const head = value.slice(0, match.index);
  if (!/[a-z]/.test(head) || /\d/.test(head)) return value;
  if (head.split("-").filter(Boolean).length < 2) return value;
  return head;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}