/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePgInterval } from "./pg-interval";

describe("parsePgInterval", () => {
  it("reads the time part with and without a fraction", () => {
    expect(parsePgInterval("00:00:00")).toBe(0);
    expect(parsePgInterval("00:00:00.012345")).toBe(12);
    expect(parsePgInterval("00:01:05")).toBe(65_000);
    expect(parsePgInterval("26:00:00")).toBe(26 * 3_600_000);
    expect(parsePgInterval("  00:00:01  ")).toBe(1000);
  });

  it("reads days, months and years before the time part, or alone", () => {
    expect(parsePgInterval("1 day 02:03:04")).toBe(86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 4000);
    expect(parsePgInterval("2 days")).toBe(2 * 86_400_000);
    expect(parsePgInterval("1 mon 3 days")).toBe(33 * 86_400_000);
    expect(parsePgInterval("1 year")).toBe(365.25 * 86_400_000);
  });

  it("reads negative intervals", () => {
    expect(parsePgInterval("-00:00:01.5")).toBe(-1500);
    expect(parsePgInterval("-1 days")).toBe(-86_400_000);
  });

  it("gives undefined, never zero, for what it cannot read", () => {
    expect(parsePgInterval(undefined)).toBeUndefined();
    expect(parsePgInterval("")).toBeUndefined();
    expect(parsePgInterval("soon")).toBeUndefined();
    expect(parsePgInterval("1 fortnight")).toBeUndefined();
    expect(parsePgInterval("00:00")).toBeUndefined();
    expect(parsePgInterval("3")).toBeUndefined();
  });
});
