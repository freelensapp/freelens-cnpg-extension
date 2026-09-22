/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The memory of a sparkline (SPEC-0006): the last samples of one figure since
// the page opened, in a fixed-size buffer. Nothing is persisted: the series
// dies with the page. Long-range charts belong to M7.

export interface SeriesPoint {
  time: number;
  value: number;
}

/** 720 samples: an hour at the five second status interval (SPEC-0028 raised it from ten minutes). */
export const DEFAULT_SERIES_CAPACITY = 720;

/** A new array with the point appended and the oldest dropped past the capacity. Non-finite values are skipped. */
export function appendPoint(
  points: readonly SeriesPoint[],
  point: SeriesPoint,
  capacity: number = DEFAULT_SERIES_CAPACITY,
): SeriesPoint[] {
  if (!Number.isFinite(point.value)) return [...points];
  const next = [...points, point];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

export interface SparklineGeometry {
  /** SVG polyline points in a `width` by `height` box, y growing downwards. */
  points: string;
  min: number;
  max: number;
  last: number;
}

/**
 * The polyline of a series. A flat series draws a line in the middle, a single
 * point draws nothing (a trend needs two); the range always includes zero when
 * `fromZero` is set, so a small wobble on a large figure is not blown up.
 */
export function sparkline(
  points: readonly SeriesPoint[],
  width: number,
  height: number,
  { fromZero = true }: { fromZero?: boolean } = {},
): SparklineGeometry | undefined {
  if (points.length < 2) return undefined;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = fromZero ? Math.min(0, ...values) : Math.min(...values);
  const span = max - min;
  const startTime = points[0].time;
  const duration = points[points.length - 1].time - startTime || 1;
  const coordinates = points.map((point) => {
    const x = ((point.time - startTime) / duration) * width;
    const y = span === 0 ? height / 2 : height - ((point.value - min) / span) * height;
    return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
  });
  return { points: coordinates.join(" "), min, max, last: values[values.length - 1] };
}
