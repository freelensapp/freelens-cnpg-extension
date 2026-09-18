/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { compareLsn, lsnDistance, parseLsn } from "./lsn";

describe("parseLsn", () => {
  it("parses the two hexadecimal halves into one 64 bit position", () => {
    expect(parseLsn("0/0")).toBe(0n);
    expect(parseLsn("0/1D000060")).toBe(0x1d000060n);
    expect(parseLsn("1/0")).toBe(1n << 32n);
    expect(parseLsn("FFFFFFFF/FFFFFFFF")).toBe((1n << 64n) - 1n);
    expect(parseLsn("a/b")).toBe((0xan << 32n) + 0xbn);
  });

  it("rejects malformed values", () => {
    expect(parseLsn(undefined)).toBeUndefined();
    expect(parseLsn(null)).toBeUndefined();
    expect(parseLsn("")).toBeUndefined();
    expect(parseLsn("1D000060")).toBeUndefined();
    expect(parseLsn("0/1D0000G0")).toBeUndefined();
    expect(parseLsn("0/1/2")).toBeUndefined();
    expect(parseLsn("0/123456789")).toBeUndefined();
  });
});

describe("compareLsn", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareLsn("0/F000000", "0/10000000")).toBeLessThan(0);
    expect(compareLsn("0/10000000", "0/F000000")).toBeGreaterThan(0);
    expect(compareLsn("0/1D000060", "0/1D000060")).toBe(0);
    expect(compareLsn("1/0", "0/FFFFFFFF")).toBeGreaterThan(0);
  });

  it("sorts malformed values first and treats them as equal to each other", () => {
    expect(compareLsn(undefined, "0/1")).toBeLessThan(0);
    expect(compareLsn("0/1", "garbage")).toBeGreaterThan(0);
    expect(compareLsn(undefined, "garbage")).toBe(0);
    // Array.prototype.sort always moves undefined to the end, so the sort case
    // uses a malformed string to exercise the comparator.
    const sorted = ["0/10000000", "garbage", "0/F000000", "1/0"].sort(compareLsn);
    expect(sorted).toEqual(["garbage", "0/F000000", "0/10000000", "1/0"]);
  });
});

describe("lsnDistance", () => {
  it("returns the byte distance between two positions", () => {
    expect(lsnDistance("0/1D000060", "0/1D000160")).toBe(0x100n);
    expect(lsnDistance("0/FFFFFFFF", "1/0")).toBe(1n);
    expect(lsnDistance("1/0", "0/FFFFFFFF")).toBe(-1n);
  });

  it("is undefined when either side is malformed", () => {
    expect(lsnDistance(undefined, "0/1")).toBeUndefined();
    expect(lsnDistance("0/1", "x")).toBeUndefined();
  });
});
