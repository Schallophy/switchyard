import assert from "node:assert/strict";
import test from "node:test";

import { TZ_ALIASES, TZ_ZONES } from "../src/ui/js/tzdata.js";

const zones = TZ_ZONES.map(([zone]) => zone);
const zoneSet = new Set(zones);

function offsetOf(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  const value = parts.find((part) => part.type === "timeZoneName")?.value;
  assert.ok(value, zone);
  return value;
}

test("每个代表时区只出现一次，并包含 UTC 与主要城市", () => {
  assert.equal(zoneSet.size, zones.length);
  assert.ok(zones.length >= 300);
  for (const zone of ["UTC", "Asia/Shanghai", "Asia/Kolkata", "Europe/Kyiv", "America/Nuuk"]) {
    assert.ok(zoneSet.has(zone), zone);
  }
  assert.ok(!zoneSet.has("Asia/Calcutta"));
  assert.ok(!zoneSet.has("Europe/Copenhagen"));
});

test("别名全部指向已列出的代表时区，且不覆盖代表时区", () => {
  for (const [alias, canonical] of Object.entries(TZ_ALIASES)) {
    assert.ok(zoneSet.has(canonical), `${alias} -> ${canonical}`);
    assert.ok(!zoneSet.has(alias), alias);
  }
  assert.equal(TZ_ALIASES["Asia/Calcutta"], "Asia/Kolkata");
  assert.equal(TZ_ALIASES["Europe/Kiev"], "Europe/Kyiv");
  assert.equal(TZ_ALIASES["Europe/Copenhagen"], "Europe/Berlin");
  assert.equal(TZ_ALIASES["US/Pacific"], "America/Los_Angeles");
  assert.equal(TZ_ALIASES.GMT, "UTC");
});

test("浏览器支持的每个 IANA 时区都能落到一个代表时区", () => {
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    assert.ok(zoneSet.has(zone) || TZ_ALIASES[zone], zone);
  }
});

test("代表时区覆盖当前全部 UTC 偏移", () => {
  const covered = new Set(zones.map(offsetOf));
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    assert.ok(covered.has(offsetOf(zone)), `${zone} ${offsetOf(zone)}`);
  }
  for (const offset of ["GMT-11:00", "GMT-09:30", "GMT+05:45", "GMT+08:45", "GMT+13:45", "GMT+14:00"]) {
    assert.ok(covered.has(offset), offset);
  }
});

test("所有代表时区都能被 Intl 识别", () => {
  for (const zone of zones) {
    assert.doesNotThrow(() => offsetOf(zone), zone);
  }
});
