/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { describeSchedule, parseGoDuration } from "./cron-text";

describe("describeSchedule", () => {
  it("describes six field expressions, seconds first", () => {
    expect(describeSchedule("0 0 3 * * *")).toBe("At 03:00");
    expect(describeSchedule("15 30 2 * * 1-5")).toBe("At 02:30:15, Monday through Friday");
    expect(describeSchedule("0 */15 * * * *")).toBe("Every 15 minutes");
    expect(describeSchedule("*/30 * * * * *")).toBe("Every 30 seconds");
    expect(describeSchedule("0 0 0 1 * *")).toBe("At 00:00, on day 1 of the month");
    expect(describeSchedule("  0   0 3 * * *  ")).toBe("At 03:00");
  });

  it("reads a five field expression the way the operator does, not as a standard crontab line", () => {
    // Seconds, minutes, hours, day of month, month: 03:00:00 every day, and
    // not "at midnight on day 3 of the month" as a crontab would read it.
    expect(describeSchedule("0 0 3 * *")).toBe("At 03:00");
  });

  it("describes the descriptors the operator accepts", () => {
    expect(describeSchedule("@daily")).toBe("Every day at 00:00");
    expect(describeSchedule("@midnight")).toBe("Every day at 00:00");
    expect(describeSchedule("@hourly")).toBe("Every hour, at minute 0");
    expect(describeSchedule("@weekly")).toBe("Every week, on Sunday at 00:00");
    expect(describeSchedule("@monthly")).toBe("Every month, on day 1 at 00:00");
    expect(describeSchedule("@yearly")).toBe(describeSchedule("@annually"));
    expect(describeSchedule("@every 6h")).toBe("Every 6 hours");
    expect(describeSchedule("@every 1h30m")).toBe("Every 1 hour 30 minutes");
    expect(describeSchedule("@every 90s")).toBe("Every 1 minute 30 seconds");
    expect(describeSchedule("@every 500ms")).toBe("Every 1 second");
  });

  it("gives undefined for anything it cannot describe", () => {
    expect(describeSchedule(undefined)).toBeUndefined();
    expect(describeSchedule("")).toBeUndefined();
    expect(describeSchedule("bad")).toBeUndefined();
    expect(describeSchedule("0 0 25 * * *")).toBeUndefined();
    expect(describeSchedule("0 0 3 * * * 2027")).toBeUndefined();
    expect(describeSchedule("0 0 3 *")).toBeUndefined();
    expect(describeSchedule("@fortnightly")).toBeUndefined();
    expect(describeSchedule("@every soon")).toBeUndefined();
    expect(describeSchedule("@every 0s")).toBeUndefined();
  });
});

describe("parseGoDuration", () => {
  it("adds up the parts of a Go duration", () => {
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("1.5h")).toBe(5_400_000);
    expect(parseGoDuration("90s")).toBe(90_000);
    expect(parseGoDuration("250ms")).toBe(250);
    expect(parseGoDuration("1h 30m")).toBeUndefined();
    expect(parseGoDuration("1d")).toBeUndefined();
    expect(parseGoDuration("")).toBeUndefined();
  });
});
