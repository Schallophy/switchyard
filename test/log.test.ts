import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/util/log.ts";

test("log files rotate and keep the configured number of copies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-log-"));
  try {
    const file = join(dir, "switchyard.log");
    const logger = createLogger({ file, pretty: false, maxBytes: 400, maxFiles: 2 });
    for (let index = 0; index < 40; index += 1) logger.info("line", { index });
    await logger.flush();

    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ["switchyard.log", "switchyard.log.1", "switchyard.log.2"]);

    const current = await readFile(file, "utf8");
    assert.ok(Buffer.byteLength(current) <= 400);
    assert.ok(current.trim().length > 0);

    const newest = lastIndex(await readFile(`${file}.1`, "utf8"));
    const oldest = lastIndex(await readFile(`${file}.2`, "utf8"));
    assert.ok(newest > oldest, "switchyard.log.1 应该比 .2 新");
    assert.ok(lastIndex(current) > newest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation can be disabled with maxBytes = 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-log-"));
  try {
    const file = join(dir, "switchyard.log");
    const logger = createLogger({ file, pretty: false, maxBytes: 0, maxFiles: 2 });
    for (let index = 0; index < 50; index += 1) logger.info("line", { index });
    await logger.flush();

    const names = await readdir(dir);
    assert.deepEqual(names, ["switchyard.log"]);
    assert.ok(Buffer.byteLength(await readFile(file, "utf8")) > 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new logger resumes the existing file size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-log-"));
  try {
    const file = join(dir, "switchyard.log");
    const first = createLogger({ file, pretty: false, maxBytes: 300, maxFiles: 1 });
    for (let index = 0; index < 5; index += 1) first.info("line", { index });
    await first.flush();

    const second = createLogger({ file, pretty: false, maxBytes: 300, maxFiles: 1 });
    for (let index = 5; index < 20; index += 1) second.info("line", { index });
    await second.flush();

    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ["switchyard.log", "switchyard.log.1"]);
    assert.ok(Buffer.byteLength(await readFile(file, "utf8")) <= 300);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function lastIndex(text: string): number {
  const line = text.trim().split("\n").at(-1) ?? "{}";
  return Number((JSON.parse(line) as Record<string, unknown>).index);
}