/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { appendPoint, sparkline } from "./series";

import type { SeriesPoint } from "./series";

describe("appendPoint", () => {
  it("appends, drops the oldest past the capacity and never mutates", () => {
    const start: SeriesPoint[] = [
      { time: 1, value: 1 },
      { time: 2, value: 2 },
    ];
    const next = appendPoint(start, { time: 3, value: 3 }, 2);
    expect(next).toEqual([
      { time: 2, value: 2 },
      { time: 3, value: 3 },
    ]);
    expect(start).toHaveLength(2);
  });

  it("skips what is not a number", () => {
    expect(appendPoint([], { time: 1, value: Number.NaN })).toEqual([]);
    expect(appendPoint([], { time: 1, value: Number.POSITIVE_INFINITY })).toEqual([]);
  });
});

describe("sparkline", () => {
  it("needs two points to draw a trend", () => {
    expect(sparkline([], 100, 20)).toBeUndefined();
    expect(sparkline([{ time: 1, value: 5 }], 100, 20)).toBeUndefined();
  });

  it("maps time to x and value to y, from zero by default", () => {
    const geometry = sparkline(
      [
        { time: 0, value: 0 },
        { time: 5, value: 10 },
        { time: 10, value: 5 },
      ],
      100,
      20,
    );
    expect(geometry).toEqual({ points: "0,20 50,0 100,10", min: 0, max: 10, last: 5 });
  });

  it("does not blow up a small wobble on a large figure unless asked to", () => {
    const points = [
      { time: 0, value: 100 },
      { time: 10, value: 102 },
    ];
    expect(sparkline(points, 100, 20)?.points).toBe("0,0.4 100,0");
    expect(sparkline(points, 100, 20, { fromZero: false })?.points).toBe("0,20 100,0");
  });

  it("draws a flat series in the middle", () => {
    const flat = sparkline(
      [
        { time: 0, value: 0 },
        { time: 10, value: 0 },
      ],
      100,
      20,
    );
    expect(flat?.points).toBe("0,10 100,10");
  });
});
