import { DEFAULT_MODEL_APIS, type ApiKind, type ModelApiMap } from "../config/schema.ts";

const PATH_TO_API: Record<string, ApiKind> = {
  "chat/completions": "chat",
  completions: "completions",
  responses: "responses",
  embeddings: "embeddings",
};

export function apiKindForPath(path: string): ApiKind {
  return PATH_TO_API[path] ?? "chat";
}

export function apisFor(map: ModelApiMap, code: string): ApiKind[] {
  return map[code] ?? [...DEFAULT_MODEL_APIS];
}

export function supportsApi(map: ModelApiMap, code: string, api: ApiKind): boolean {
  return apisFor(map, code).includes(api);
}
