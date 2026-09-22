/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  cronError,
  cronFromPreset,
  cronPresetErrors,
  defaultCronPresetValues,
  FIVE_FIELDS_REASON,
  formatRun,
  nextRuns,
  parseCron,
  runInterval,
} from "./cron";

const FROM = new Date("2026-09-22T10:15:30Z");

function runs(expression: string, count = 3, from = FROM): string[] {
  return nextRuns(expression, from, count).map((date) => date.toISOString());
}

describe("the grammar of the operator's parser", () => {
  it("reads six fields seconds first and refuses five with the reason", () => {
    expect(cronError("0 0 3 * * *")).toBeUndefined();
    expect(cronError("0 0 3 * *")).toBe(FIVE_FIELDS_REASON);
    expect(cronError("0 0 3 * * * *")).toMatch(/six fields.*found 7/);
    expect(cronError("")).toBe("A schedule is required");
    expect(cronError("  0   0 3 * * *  ")).toBeUndefined();
  });

  it("checks every field against its range and grammar", () => {
    expect(cronError("60 0 3 * * *")).toBe("seconds: 60 is out of range 0-59");
    expect(cronError("0 0 24 * * *")).toBe("hours: 24 is out of range 0-23");
    expect(cronError("0 0 3 0 * *")).toBe("day of month: 0 is out of range 1-31");
    expect(cronError("0 0 3 * 13 *")).toBe("month: 13 is out of range 1-12");
    expect(cronError("0 0 3 * * 7")).toBe("day of week: 7 is out of range 0-6");
    expect(cronError("0 0 3 * * x")).toBe("day of week: x is not a number or a name");
    expect(cronError("0 0 5-3 * * *")).toMatch(/beginning of the range 5 is beyond its end 3/);
    expect(cronError("0 */0 3 * * *")).toMatch(/step 0 is not a positive number/);
    expect(cronError("0 0 3 * * 1,,2")).toMatch(/empty entry/);
    expect(cronError("0 0 1-2-3 * * *")).toMatch(/too many hyphens/);
    expect(cronError("0 0 */2/3 * * *")).toMatch(/too many slashes/);
  });

  it("accepts names, lists, ranges, steps and the question mark", () => {
    expect(cronError("0 30 4 * JAN-MAR MON-FRI")).toBeUndefined();
    expect(cronError("0 0 */6 ? * ?")).toBeUndefined();
    expect(cronError("0 0,30 8-18/2 1,15 * *")).toBeUndefined();
    expect(cronError("0 5/10 * * * *")).toBeUndefined();
    const parsed = parseCron("0 5/10 * * * *");
    expect(parsed).not.toBeTypeOf("string");
    if (typeof parsed !== "string" && parsed.kind === "fields") {
      expect([...parsed.fields[1].values]).toEqual([5, 15, 25, 35, 45, 55]);
      expect(parsed.fields[2].star).toBe(true);
      expect(parsed.fields[1].star).toBe(false);
    }
  });

  it("accepts the descriptors, @every with a Go duration, and nothing else with an at sign", () => {
    expect(cronError("@daily")).toBeUndefined();
    expect(cronError("@hourly")).toBeUndefined();
    expect(cronError("@every 1h30m")).toBeUndefined();
    expect(cronError("@every soon")).toMatch(/wants a duration/);
    expect(cronError("@fortnightly")).toMatch(/not a descriptor/);
    const every = parseCron("@every 90s");
    expect(every).toEqual({ kind: "every", seconds: 90, expression: "@every 90s" });
    expect(parseCron("@every 500ms")).toEqual({ kind: "every", seconds: 1, expression: "@every 500ms" });
  });
});

describe("the next runs", () => {
  it("computes daily, hourly and weekly runs in UTC", () => {
    expect(runs("0 0 3 * * *")).toEqual([
      "2026-09-23T03:00:00.000Z",
      "2026-09-24T03:00:00.000Z",
      "2026-09-25T03:00:00.000Z",
    ]);
    expect(runs("0 30 * * * *")).toEqual([
      "2026-09-22T10:30:00.000Z",
      "2026-09-22T11:30:00.000Z",
      "2026-09-22T12:30:00.000Z",
    ]);
    // 2026-09-22 is a Tuesday: the next Sunday is the 27th.
    expect(runs("0 0 3 * * 0", 2)).toEqual(["2026-09-27T03:00:00.000Z", "2026-10-04T03:00:00.000Z"]);
    expect(runs("0 0 3 * * SUN", 1)).toEqual(["2026-09-27T03:00:00.000Z"]);
  });

  it("handles steps, month ends, leap years and the two day fields", () => {
    expect(runs("0 */20 * * * *", 4)).toEqual([
      "2026-09-22T10:20:00.000Z",
      "2026-09-22T10:40:00.000Z",
      "2026-09-22T11:00:00.000Z",
      "2026-09-22T11:20:00.000Z",
    ]);
    expect(runs("0 0 0 31 * *", 3)).toEqual([
      "2026-10-31T00:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
      "2027-01-31T00:00:00.000Z",
    ]);
    expect(runs("0 0 0 29 2 *", 2)).toEqual(["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
    // Both day fields restricted: either matches (the 1st, or any Monday).
    expect(runs("0 0 0 1 * 1", 3)).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    ]);
    // One day field a star: both must match (the 1st only when it is a Monday would be too rare, so a star on dow means every 1st).
    expect(runs("0 0 0 1 * *", 2)).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(runs("0 0 0 * * 1", 2)).toEqual(["2026-09-28T00:00:00.000Z", "2026-10-05T00:00:00.000Z"]);
  });

  it("runs the descriptors and @every from the given time", () => {
    expect(runs("@daily", 1)).toEqual(["2026-09-23T00:00:00.000Z"]);
    expect(runs("@weekly", 1)).toEqual(["2026-09-27T00:00:00.000Z"]);
    expect(runs("@monthly", 1)).toEqual(["2026-10-01T00:00:00.000Z"]);
    expect(runs("@yearly", 1)).toEqual(["2027-01-01T00:00:00.000Z"]);
    expect(runs("@every 1h30m", 2)).toEqual(["2026-09-22T11:45:30.000Z", "2026-09-22T13:15:30.000Z"]);
    expect(runs("0 0 3 * *")).toEqual([]);
  });

  it("gives up on a schedule that never fires", () => {
    expect(runs("0 0 0 31 2 *", 1)).toEqual([]);
  });

  it("measures the interval for the warning about frequent runs", () => {
    expect(runInterval("0 */5 * * * *", FROM)).toBe(300);
    expect(runInterval("0 0 3 * * *", FROM)).toBe(86400);
    expect(runInterval("@every 10m", FROM)).toBe(600);
    expect(runInterval("nonsense", FROM)).toBeUndefined();
  });

  it("prints a run as the form does", () => {
    expect(formatRun(new Date("2026-09-23T03:00:00Z"))).toBe("2026-09-23 03:00:00 UTC");
  });
});

describe("the presets", () => {
  it("build the six fields with seconds at zero", () => {
    const values = defaultCronPresetValues();
    expect(cronFromPreset(values)).toBe("0 0 3 * * *");
    expect(cronFromPreset({ ...values, preset: "hourly", minute: "15" })).toBe("0 15 * * * *");
    expect(cronFromPreset({ ...values, preset: "weekly", weekday: "6", hour: "22", minute: "30" })).toBe(
      "0 30 22 * * 6",
    );
    expect(cronFromPreset({ ...values, preset: "monthly", monthDay: "15" })).toBe("0 0 3 15 * *");
    expect(cronFromPreset({ ...values, preset: "custom", custom: " 0  0 */6 * * * " })).toBe("0 0 */6 * * *");
  });

  it("refuse the numbers that are out of their field", () => {
    const values = defaultCronPresetValues();
    expect(cronPresetErrors(values)).toEqual({});
    expect(cronPresetErrors({ ...values, minute: "60" }).minute).toBe("The minute is a number from 0 to 59");
    expect(cronPresetErrors({ ...values, hour: "24" }).hour).toBe("The hour is a number from 0 to 23");
    expect(cronPresetErrors({ ...values, preset: "weekly", weekday: "7" }).weekday).toBe(
      "The day of the week is a number from 0 to 6",
    );
    expect(cronPresetErrors({ ...values, preset: "monthly", monthDay: "0" }).monthDay).toBe(
      "The day of the month is a number from 1 to 31",
    );
    expect(cronPresetErrors({ ...values, preset: "hourly", hour: "99" })).toEqual({});
    expect(cronPresetErrors({ ...values, preset: "custom", custom: "0 0 3 * *" }).custom).toBe(FIVE_FIELDS_REASON);
  });
});
