/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The lines of several instances on one time axis (SPEC-0018): merged by time,
// without the duplicates a `sinceTime` read brings back (the API answers from
// the second of the stamp, so the last lines seen come again), capped.

import type { LogLine } from "./log-line";

export const MAX_LINES = 2000;

function timeOf(line: LogLine): number {
  return line.time?.getTime() ?? 0;
}

/** Adds lines to a buffer sorted by time; returns the same array when nothing is new. */
export function mergeLines(buffer: readonly LogLine[], incoming: readonly LogLine[], cap = MAX_LINES): LogLine[] {
  const known = new Set(buffer.map((line) => line.id));
  const fresh = incoming.filter((line) => {
    if (known.has(line.id)) return false;
    known.add(line.id);
    return true;
  });
  if (fresh.length === 0) return buffer as LogLine[];
  // A stable sort keeps the order of the lines of a pod that share a timestamp.
  const merged = [...buffer, ...fresh].sort((a, b) => timeOf(a) - timeOf(b));
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** The stamp to ask a pod's log from: the last one seen for that pod. */
export function lastStamp(buffer: readonly LogLine[], pod: string): string | undefined {
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const line = buffer[index];
    if (line.pod === pod && line.stamp) return line.stamp;
  }
  return undefined;
}
