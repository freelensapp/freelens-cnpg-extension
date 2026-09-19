/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// A sparkline over the in-memory series of the poller: a trend, not a chart.
// The stroke takes the current text color, so both themes are right for free.

import { sparkline } from "./series";

import type { SeriesPoint } from "./series";

export interface SparklineProps {
  points: readonly SeriesPoint[] | undefined;
  /** What the line shows and over how long, for the tooltip. */
  label: string;
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({ points, label, width = 96, height = 24, className }: SparklineProps) {
  const geometry = sparkline(points ?? [], width, height);
  if (!geometry) return null;
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: from ${geometry.min} to ${geometry.max} since the page opened`}
    >
      <title>{`${label}: minimum ${geometry.min}, maximum ${geometry.max}, since the page opened`}</title>
      <polyline points={geometry.points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
