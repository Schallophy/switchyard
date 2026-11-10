import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type EventKind =
  | "start"
  | "failover"
  | "dead"
  | "throttle"
  | "revive"
  | "catalog"
  | "config"
  | "error";

export type EventLevel = "info" | "warn" | "error";

export interface AppEvent {
  id: number;
  at: string;
  kind: EventKind;
  level: EventLevel;
  message: string;
  model?: string | null;
  chain?: string | null;
  detail?: Record<string, unknown>;
}

export class EventLog {
  #file: string;
  #capacity: number;
  #items: AppEvent[] = [];
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, capacity = 400) {
    this.#file = file;
    this.#capacity = capacity;
  }

  push(input: Omit<AppEvent, "id" | "at">): AppEvent {
    const event: AppEvent = { id: this.#nextId, at: new Date().toISOString(), ...input };
    this.#nextId += 1;
    this.#items.push(event);
    if (this.#items.length > this.#capacity) {
      this.#items.splice(0, this.#items.length - this.#capacity);
    }
    const line = JSON.stringify(event);
    this.#queue = this.#queue
      .then(async () => {
        await mkdir(dirname(this.#file), { recursive: true });
        await appendFile(this.#file, `${line}\n`, "utf8");
      })
      .catch(() => undefined);
    return event;
  }

  recent(limit = 120, kind?: EventKind): AppEvent[] {
    const source = kind ? this.#items.filter((item) => item.kind === kind) : this.#items;
    return source.slice(-limit).reverse();
  }

  async flush(): Promise<void> {
    await this.#queue;
  }
}
