/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure layout of the replication topology (SPEC-0006 "The page grid"): the
// primary on the left, one row per other instance on the right, one line from
// the primary to every standby it has an edge with. The component draws the
// lines in an SVG whose viewBox is `LINE_BOX_WIDTH` wide and `ROW_UNITS` tall
// per row, stretched over the middle column, so no pixel is measured.

import type { Level, LiveEdge, LiveInstance } from "./live-model";

export const ROW_UNITS = 100;
export const LINE_BOX_WIDTH = 100;

export interface TopologyRow {
  instance: LiveInstance;
  /** Absent for an instance that has no relationship with the primary to draw. */
  edge?: LiveEdge;
}

export interface TopologyLine {
  standby: string;
  /** Vertical start (the middle of the primary) and end (the middle of the row), in viewBox units. */
  y1: number;
  y2: number;
  level: Level;
  streaming: boolean;
}

export interface TopologyLayout {
  primary?: LiveInstance;
  rows: TopologyRow[];
  lines: TopologyLine[];
  /** Height of the lines box in viewBox units. */
  height: number;
}

export function layoutTopology(
  instances: readonly LiveInstance[],
  edges: readonly LiveEdge[],
  primaryName: string | undefined,
): TopologyLayout {
  const primary = instances.find((instance) => instance.name === primaryName);
  const others = instances.filter((instance) => instance !== primary);

  // The edges come worst first from the model: the rows keep that order, then
  // the instances without an edge follow by name.
  const withEdge: TopologyRow[] = [];
  for (const edge of edges) {
    const instance = others.find((candidate) => candidate.name === edge.standby);
    if (instance) withEdge.push({ instance, edge });
  }
  const withoutEdge: TopologyRow[] = others
    .filter((instance) => !withEdge.some((row) => row.instance === instance))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((instance) => ({ instance }));
  const rows: TopologyRow[] = [...withEdge, ...withoutEdge];

  const height = Math.max(1, rows.length) * ROW_UNITS;
  const lines: TopologyLine[] = primary
    ? rows.flatMap((row, index) =>
        row.edge
          ? [
              {
                standby: row.instance.name,
                y1: height / 2,
                y2: index * ROW_UNITS + ROW_UNITS / 2,
                level: row.edge.level,
                streaming: row.edge.streaming,
              },
            ]
          : [],
      )
    : [];

  return { primary, rows, lines, height };
}
