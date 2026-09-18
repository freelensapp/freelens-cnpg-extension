/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parseGoTime } from "./go-time";

describe("parseGoTime", () => {
  it("parses the Go time.String() layout with a named UTC zone", () => {
    // The value CloudNativePG 1.30.0 writes in status.certificates.expirations.
    expect(parseGoTime("2026-12-17 16:03:14 +0000 UTC")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
  });

  it("parses fractional seconds up to nanoseconds, keeping millisecond precision", () => {
    expect(parseGoTime("2026-12-17 16:03:14.123456789 +0000 UTC")?.toISOString()).toBe("2026-12-17T16:03:14.123Z");
    expect(parseGoTime("2026-12-17 16:03:14.5 +0000 UTC")?.toISOString()).toBe("2026-12-17T16:03:14.500Z");
  });

  it("applies positive and negative numeric offsets", () => {
    expect(parseGoTime("2026-12-17 18:03:14 +0200 CEST")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
    expect(parseGoTime("2026-12-17 11:03:14 -0500 EST")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
    expect(parseGoTime("2026-12-17 16:33:14 +0030")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
  });

  it("accepts a zone written as a numeric abbreviation and the monotonic clock suffix", () => {
    expect(parseGoTime("2026-12-17 16:03:14 +0000 +0000")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
    expect(parseGoTime("2026-12-17 16:03:14 +0000 UTC m=+0.000123456")?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
  });

  it("falls back to RFC 3339", () => {
    expect(parseGoTime("2026-09-18T16:14:03Z")?.toISOString()).toBe("2026-09-18T16:14:03.000Z");
    expect(parseGoTime("2026-09-18T18:14:03+02:00")?.toISOString()).toBe("2026-09-18T16:14:03.000Z");
  });

  it("returns undefined for empty, missing and unparseable values", () => {
    expect(parseGoTime(undefined)).toBeUndefined();
    expect(parseGoTime(null)).toBeUndefined();
    expect(parseGoTime("")).toBeUndefined();
    expect(parseGoTime("   ")).toBeUndefined();
    expect(parseGoTime("not a date")).toBeUndefined();
    expect(parseGoTime("2026-13-45 99:99:99 +0000 UTC")).toBeUndefined();
  });
});
