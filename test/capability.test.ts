import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapabilityIndex,
  matchCapability,
  parseLeaderboardHtml,
  type CapabilityModel,
} from "../src/core/capability.ts";

function model(slug: string, score: number | null, extra: Partial<CapabilityModel> = {}): CapabilityModel {
  return {
    slug,
    name: slug,
    creator: null,
    score,
    contextWindow: 128_000,
    reasoning: false,
    ...extra,
  };
}

function htmlWithModels(models: CapabilityModel[]): string {
  const record = models.map((item) => ({
    slug: item.slug,
    name: item.name,
    modelCreatorName: item.creator,
    intelligenceIndex: item.score,
    contextWindowTokens: item.contextWindow,
    isReasoning: item.reasoning,
  }));
  const payload = `22:["$","div",null,{"initialModels":${JSON.stringify(record)}}]`;
  const split = Math.floor(payload.length / 2);
  return [
    `<script>self.__next_f.push([1,${JSON.stringify(payload.slice(0, split))}])</script>`,
    `<script>self.__next_f.push([1,${JSON.stringify(payload.slice(split))}])</script>`,
  ].join("");
}

test("parses models from the Next.js flight payload", () => {
  const html = htmlWithModels([
    model("claude-opus-5-5", 59.1, {
      name: "Claude Opus 5.5",
      creator: "Anthropic",
      contextWindow: 200_000,
      reasoning: true,
    }),
    model("unscored-model", null),
  ]);

  const models = parseLeaderboardHtml(html);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    creator: "Anthropic",
    score: 59.1,
    contextWindow: 200_000,
    reasoning: true,
  });
  assert.equal(models[1]?.score, null);
});

test("a malformed flight chunk does not hide the rest of the page", () => {
  const good = htmlWithModels([model("claude-opus-5-5", 59.1)]);
  const html = `<script>self.__next_f.push([1,"not json"])</script>${good}`;
  assert.equal(parseLeaderboardHtml(html).length, 1);
  assert.deepEqual(parseLeaderboardHtml("<html></html>"), []);
});

const models = [
  model("deepseek-v4-pro", 23.1),
  model("deepseek-v4-1-flash-1017", 32.6),
  model("deepseek-v4-1-flash-1017-non-reasoning", 18.5),
  model("claude-opus-5-5", 59.1),
  model("claude-opus-5-5-low", 34.8),
  model("gemini-3-5-flash-lite", 11.7),
  model("glm-5-3", 31.7),
  model("deepseek-v4-flash-vision", 8.4),
  model("minimax-m3", 18.9),
  model("unscored-model", null),
];

const index = buildCapabilityIndex(models);

function matchedSlug(name: string): string | null {
  return matchCapability(index, name)?.model.slug ?? null;
}

test("matches exact slugs and provider-prefixed upstream names", () => {
  assert.equal(matchedSlug("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(matchedSlug("deepseek/deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(matchedSlug("MiniMax/MiniMax-M3"), "minimax-m3");
});

test("matches dots, dates and non-capability suffixes", () => {
  assert.equal(matchedSlug("deepseek-v4.1-flash"), "deepseek-v4-1-flash-1017");
  assert.equal(matchedSlug("deepseek-v4.1-flash-1017"), "deepseek-v4-1-flash-1017");
  assert.equal(matchedSlug("deepseek-v4.1-flash-free"), "deepseek-v4-1-flash-1017");
  assert.equal(matchedSlug("deepseek-v4-pro-0813"), "deepseek-v4-pro");
  assert.equal(matchedSlug("deepseek/deepseek-v4-pro:batch"), "deepseek-v4-pro");
});

test("uses the highest reasoning effort when the catalog has no effort suffix", () => {
  const match = matchCapability(index, "claude-opus-5-5");
  assert.equal(match?.model.slug, "claude-opus-5-5");
  assert.equal(match?.model.score, 59.1);
});

test("keeps an explicit effort variant distinct", () => {
  const match = matchCapability(index, "claude-opus-5-5-low");
  assert.equal(match?.model.slug, "claude-opus-5-5-low");
  assert.equal(match?.model.score, 34.8);
  assert.equal(match?.cost, 0);
});

test("does not match a different version or a different model family", () => {
  assert.equal(matchedSlug("glm-5"), null);
  assert.equal(matchedSlug("gemini-3.5-flash"), null);
  assert.equal(matchedSlug("deepseek-v4-flash"), null);
  assert.equal(matchedSlug("unscored-model"), null);
  assert.equal(matchedSlug(""), null);
});