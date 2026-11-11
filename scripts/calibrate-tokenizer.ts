/**
 * Measures how far Switchyard's pre-flight token estimate is from the
 * provider's own `usage.prompt_tokens`.
 *
 * The estimator is only used to reject requests that clearly exceed
 * `chain.context.window`; it never feeds the usage dashboard. This script
 * makes that gap measurable: it sends a few fixed prompts through the gateway
 * and compares `estimateRequestTokens` with what the provider reports.
 *
 * Usage:
 *   node scripts/calibrate-tokenizer.ts
 *   SWITCHYARD_CALIBRATION_URL=http://127.0.0.1:8789/v1 node scripts/calibrate-tokenizer.ts
 *   SWITCHYARD_CALIBRATION_MODEL=deepseek-v4.1-flash-1017 node scripts/calibrate-tokenizer.ts
 *
 * Each sample asks for a single output token, so the cost is only the prompt.
 */

import { estimateRequestTokens } from "../src/util/context.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const URL = (process.env.SWITCHYARD_CALIBRATION_URL ?? "http://127.0.0.1:8788/v1").replace(/\/+$/, "");
const MODEL = process.env.SWITCHYARD_CALIBRATION_MODEL ?? "auto";
const KEY = process.env.SWITCHYARD_CALIBRATION_KEY ?? "sk-calibration";
const ONLY = process.env.SWITCHYARD_CALIBRATION_ONLY?.trim() || null;

interface Sample {
  name: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  tools?: unknown[];
}

const SAMPLES: Sample[] = [
  {
    name: "english-prose",
    messages: [
      {
        role: "user",
        content:
          "A gateway sits between the client and several upstream providers. It keeps a prioritized list of models and picks the first one that can serve the request. When a provider runs out of quota, the gateway retries the next candidate behind the same client request, so the caller sees a normal response instead of an error. Health, throttling and invalid models are tracked separately because they recover on different schedules.",
      },
    ],
  },
  {
    name: "chinese-prose",
    messages: [
      {
        role: "user",
        content:
          "网关位于客户端和多个上游提供商之间，维护一条按优先级排序的模型列表，并从中选出当前可用的模型。当某个模型额度耗尽、失效或限流时，网关会在同一次请求内按顺序切换到下一个候选模型，客户端仍然只会看到一次正常的响应。模型健康状态、限流与失效原因分别记录，因为它们的恢复时间并不相同。",
      },
    ],
  },
  {
    name: "mixed-cjk-latin",
    messages: [
      {
        role: "user",
        content:
          "用React和TypeScript重写Switchyard看板的用量页：输入列改成真实新增Token，新增cacheHitRate字段，并在ModelRecord里补上cachedPromptTokens与cacheTrackedPromptTokens。注意tokenizer只用于上下文拦截，计费以provider返回的usage为准。",
      },
    ],
  },
  {
    name: "typescript-code",
    messages: [
      {
        role: "user",
        content: [
          "export function pick(codes: string[], start: number): string | null {",
          "  for (let offset = 0; offset < codes.length; offset += 1) {",
          "    const code = codes[(start + offset) % codes.length];",
          "    const record = store.get(code);",
          "    if (record?.health === 'invalid') continue;",
          "    if (record?.health === 'dead' && !isDeadRetryDue(record)) continue;",
          "    return code;",
          "  }",
          "  return null;",
          "}",
        ].join("\n"),
      },
    ],
  },
  {
    name: "json-minified",
    messages: [
      {
        role: "user",
        content:
          '{"version":1,"chain":{"active":"deepseek-v4.1-flash-1017","models":["deepseek-v4.1-flash-1017"],"context":{"window":512000,"onOverflow":"reject"},"retryDeadAfterMinutes":1440},"failover":{"maxAttempts":8,"throttleCooldownMs":60000},"server":{"maxBodyBytes":16777216,"cors":true}}',
      },
    ],
  },
  {
    name: "markdown-table",
    messages: [
      {
        role: "user",
        content: [
          "| 调用方 | 请求 | 输入 | 缓存率 | 输出 |",
          "| --- | ---: | ---: | ---: | ---: |",
          "| opencode | 882 | 87.4M | 98.7% | 570K |",
          "| cline | 41 | 12.1M | 91.2% | 88K |",
          "",
          "说明：输入为扣除缓存命中后的新增部分；历史数据没有缓存明细时显示 —。",
        ].join("\n"),
      },
    ],
  },
  {
    name: "camel-identifiers",
    messages: [
      {
        role: "user",
        content:
          "HTTPRequestHandler parseContentLengthHeader getOrCreateSessionByID XMLHttpRequestObject readRequestBodyFromIncomingMessage normalizeConfigPathForWindows ProviderKeyInfoMap FailoverAttemptRecorder cachedPromptTokens cacheTrackedPromptTokens estimateRequestTokens",
      },
    ],
  },
  {
    name: "numbers-logs",
    messages: [
      {
        role: "user",
        content: [
          "2026-11-10T18:03:03.019Z INFO  requests=882 failovers=95 prompt=90698797 cached=3265536 completion=584280 rate=98.76%",
          "2026-11-10T18:03:04.120Z WARN  attempt=3/8 model=qwen3.8-flash status=429 retryAfter=12.5s latency=842ms",
          "2026-11-10T18:03:05.000Z ERROR upstream=10.0.0.42:8080 bytes=16777216 code=EADDRINUSE pid=25592",
        ].join("\n"),
      },
    ],
  },
  {
    name: "emoji-symbols",
    messages: [
      {
        role: "user",
        content: "部署完成 ✅ 🚀 缓存命中率 98.7% ↑ 输出 570K → 账单 ¥0.0321；注意 ⚠️ 温度 -5°C…next→done",
      },
    ],
  },
  {
    name: "shell-paths",
    messages: [
      {
        role: "user",
        content:
          "$env:SWITCHYARD_CONFIG='C:\\Users\\schallophy\\projects\\switchyard\\config.json'; node --env-file-if-exists=.env src/index.ts --host 127.0.0.1 --port 8788 | tee -a data/switchyard.log",
      },
    ],
  },
  {
    name: "tool-schema",
    messages: [{ role: "user", content: "列出当前目录下的文件，然后告诉我哪个最大。" }],
    tools: [
      {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in a directory with their sizes.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path to list." },
              recursive: { type: "boolean", description: "Whether to descend into subdirectories." },
              limit: { type: "integer", minimum: 1, maximum: 1000 },
            },
            required: ["path"],
          },
        },
      },
    ],
  },
  {
    name: "long-english",
    messages: [
      {
        role: "user",
        content: Array.from(
          { length: 6 },
          () =>
            "Failover only happens before the first byte reaches the client. Once an SSE stream has started, later errors end the stream instead of silently retrying, because splicing two responses together would corrupt the output.",
        ).join(" "),
      },
    ],
  },
];

interface Row {
  name: string;
  chars: number;
  estimate: number;
  provider: number;
  error: number;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function measure(sample: Sample): Promise<Row> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: sample.messages,
    max_tokens: 1,
    temperature: 0,
    stream: false,
  };
  if (sample.tools) body.tools = sample.tools;

  const estimate = estimateRequestTokens("chat", body).promptTokens;
  const response = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${sample.name}: HTTP ${response.status} ${text.slice(0, 180)}`);

  const payload = JSON.parse(text) as { usage?: { prompt_tokens?: number } };
  const provider = payload.usage?.prompt_tokens;
  if (typeof provider !== "number" || provider <= 0) {
    throw new Error(`${sample.name}: provider did not return usage.prompt_tokens`);
  }

  const chars = sample.messages.reduce((sum, message) => sum + message.content.length, 0);
  return { name: sample.name, chars, estimate, provider, error: (estimate - provider) / provider };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const samples = ONLY ? SAMPLES.filter((sample) => sample.name === ONLY) : SAMPLES;
  if (samples.length === 0) throw new Error(`unknown sample: ${ONLY}`);

  console.log(`endpoint ${URL}  model ${MODEL}  samples ${samples.length}\n`);
  const rows: Row[] = [];
  for (const sample of samples) {
    try {
      rows.push(await measure(sample));
    } catch (error) {
      console.log(`- ${sample.name.padEnd(18)} skipped: ${(error as Error).message}`);
    }
  }
  if (rows.length === 0) throw new Error("no samples completed");

  console.log(`${pad("sample", 18)}${pad("chars", 8)}${pad("estimate", 10)}${pad("provider", 10)}${pad("error", 9)}`);
  for (const row of rows) {
    console.log(
      `${pad(row.name, 18)}${pad(String(row.chars), 8)}${pad(String(row.estimate), 10)}${pad(
        String(row.provider),
        10,
      )}${pad(pct(row.error), 9)}`,
    );
  }

  const errors = rows.map((row) => row.error);
  const abs = errors.map((value) => Math.abs(value));
  const bias = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const meanAbs = abs.reduce((sum, value) => sum + value, 0) / abs.length;

  console.log(
    `\nbias ${pct(bias)}  mean abs ${pct(meanAbs)}  p95 abs ${pct(percentile(abs, 0.95))}  max abs ${pct(
      Math.max(...abs),
    )}`,
  );
  console.log(
    "The estimate only gates the context window; the dashboard uses provider usage, so a few percent of drift never affects billed totals.",
  );
}

await main();