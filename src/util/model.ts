const FAMILIES: Array<{ test: RegExp; name: string }> = [
  { test: /^qwen/i, name: "Qwen" },
  { test: /^kimi/i, name: "Kimi" },
  { test: /^deepseek/i, name: "DeepSeek" },
  { test: /^glm/i, name: "GLM" },
  { test: /^llama/i, name: "Llama" },
  { test: /^mistral/i, name: "Mistral" },
  { test: /^ernie/i, name: "ERNIE" },
  { test: /^doubao/i, name: "Doubao" },
  { test: /^gpt/i, name: "GPT" },
  { test: /^claude/i, name: "Claude" },
  { test: /^gemini/i, name: "Gemini" },
  { test: /^moonshot/i, name: "Moonshot" },
  { test: /^minimax/i, name: "MiniMax" },
  { test: /^baichuan/i, name: "Baichuan" },
  { test: /^yi/i, name: "Yi" },
];

export function familyOf(code: string): string {
  for (const entry of FAMILIES) {
    if (entry.test.test(code)) return entry.name;
  }
  return "Other";
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (Math.abs(value) >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.replace(/\.0$/, "");
}
