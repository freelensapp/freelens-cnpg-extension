/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { lastStamp, mergeLines } from "./log-buffer";
import { filterLines, levelCounts, NO_FILTER, sourceCounts } from "./log-filter";
import { parseLogLine } from "./log-line";

function line(pod: string, second: number, message: string, extra = ""): ReturnType<typeof parseLogLine> {
  const stamp = `2026-09-19T14:00:${String(second).padStart(2, "0")}.000000001Z`;
  return parseLogLine(
    `${stamp} {"level":"info","ts":"${stamp}","logger":"instance-manager","msg":"${message}"${extra}}`,
    pod,
  );
}

describe("mergeLines", () => {
  it("merges the lines of several instances by time", () => {
    const merged = mergeLines(
      [line("pg-1", 1, "a"), line("pg-1", 5, "c")],
      [line("pg-2", 3, "b"), line("pg-2", 7, "d")],
    );
    expect(merged.map((entry) => `${entry.pod}:${entry.message}`)).toEqual(["pg-1:a", "pg-2:b", "pg-1:c", "pg-2:d"]);
  });

  it("drops what a sinceTime read brings back, and returns the same buffer when nothing is new", () => {
    const buffer = mergeLines([], [line("pg-1", 1, "a"), line("pg-1", 2, "b")]);
    expect(mergeLines(buffer, [line("pg-1", 2, "b")])).toBe(buffer);
    expect(mergeLines(buffer, [line("pg-1", 2, "b"), line("pg-1", 3, "c")]).map((entry) => entry.message)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // The same stamp on another pod is another line.
    expect(mergeLines(buffer, [line("pg-2", 2, "b")])).toHaveLength(3);
  });

  it("keeps the newest lines under the cap", () => {
    const many = Array.from({ length: 10 }, (_, index) => line("pg-1", index, `m${index}`));
    expect(mergeLines([], many, 4).map((entry) => entry.message)).toEqual(["m6", "m7", "m8", "m9"]);
  });

  it("knows the last stamp seen for a pod", () => {
    const buffer = mergeLines([], [line("pg-1", 1, "a"), line("pg-2", 4, "b"), line("pg-1", 3, "c")]);
    expect(lastStamp(buffer, "pg-1")).toBe("2026-09-19T14:00:03.000000001Z");
    expect(lastStamp(buffer, "pg-3")).toBeUndefined();
  });
});

describe("filterLines", () => {
  const error = parseLogLine(
    '2026-09-19T14:00:09Z {"level":"error","logger":"wal-archive","msg":"Error while calling ArchiveWAL","error":"exit status 4"}',
    "pg-2",
  );
  const warning = parseLogLine(
    '2026-09-19T14:00:08Z {"level":"info","logger":"postgres","msg":"record","record":{"error_severity":"WARNING","message":"out of shared memory"}}',
    "pg-1",
  );
  const lines = [line("pg-1", 1, "started"), warning, error];

  it("passes everything without a filter", () => {
    expect(filterLines(lines, NO_FILTER)).toHaveLength(3);
  });

  it("filters by instance, source, minimum level and text", () => {
    expect(filterLines(lines, { ...NO_FILTER, pods: ["pg-2"] })).toEqual([error]);
    expect(filterLines(lines, { ...NO_FILTER, sources: ["PostgreSQL"] })).toEqual([warning]);
    expect(filterLines(lines, { ...NO_FILTER, minimum: "warning" })).toEqual([warning, error]);
    expect(filterLines(lines, { ...NO_FILTER, minimum: "error" })).toEqual([error]);
    // The text is looked for in the raw line, so a field matches too.
    expect(filterLines(lines, { ...NO_FILTER, text: "EXIT STATUS" })).toEqual([error]);
  });

  it("counts the sources in a fixed order and the levels", () => {
    expect(sourceCounts(lines)).toEqual([
      { source: "PostgreSQL", count: 1 },
      { source: "Instance manager", count: 1 },
      { source: "WAL archiving", count: 1 },
    ]);
    expect(levelCounts(lines)).toEqual({ error: 1, warning: 1, info: 1, debug: 0 });
  });
});
