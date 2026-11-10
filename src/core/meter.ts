import type { ModelRecord } from "../types.ts";

export function isThrottled(record: ModelRecord, now: number): boolean {
  return record.throttledUntil !== null && Date.parse(record.throttledUntil) > now;
}
