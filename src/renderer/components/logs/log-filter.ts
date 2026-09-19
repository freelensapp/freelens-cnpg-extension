/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the Logs page shows of its buffer (SPEC-0018): by instance, by who
// said it, from a level up, and by text.

import type { LogLevel, LogLine, LogSource } from "./log-line";

export type MinimumLevel = "all" | "warning" | "error";

export interface LogFilter {
  /** Empty: every instance. */
  pods: readonly string[];
  /** Empty: every source. */
  sources: readonly LogSource[];
  minimum: MinimumLevel;
  text: string;
}

export const NO_FILTER: LogFilter = { pods: [], sources: [], minimum: "all", text: "" };

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const MINIMUM_RANK: Record<MinimumLevel, number> = { all: 0, warning: 2, error: 3 };

export function filterLines(lines: readonly LogLine[], filter: LogFilter): LogLine[] {
  const needle = filter.text.trim().toLowerCase();
  return lines.filter((line) => {
    if (filter.pods.length > 0 && !filter.pods.includes(line.pod)) return false;
    if (filter.sources.length > 0 && !filter.sources.includes(line.source)) return false;
    if (RANK[line.level] < MINIMUM_RANK[filter.minimum]) return false;
    if (needle && !line.raw.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** The sources that actually appear, with how many lines each, in a fixed order. */
export function sourceCounts(lines: readonly LogLine[]): { source: LogSource; count: number }[] {
  const order: LogSource[] = [
    "PostgreSQL",
    "Instance manager",
    "WAL archiving",
    "Backup",
    "Plugin",
    "Declarative objects",
    "Other",
  ];
  const counts = new Map<LogSource, number>();
  for (const line of lines) counts.set(line.source, (counts.get(line.source) ?? 0) + 1);
  return order.filter((source) => counts.has(source)).map((source) => ({ source, count: counts.get(source) ?? 0 }));
}

export function levelCounts(lines: readonly LogLine[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { error: 0, warning: 0, info: 0, debug: 0 };
  for (const line of lines) counts[line.level] += 1;
  return counts;
}
