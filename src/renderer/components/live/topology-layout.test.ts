/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { layoutTopology } from "./topology-layout";

import type { LiveEdge, LiveInstance } from "./live-model";

function instance(name: string, role: LiveInstance["role"]): LiveInstance {
  return { name, role, fenced: false, pending: false, flags: [] };
}

function edge(standby: string, level: LiveEdge["level"] = "ok", streaming = true): LiveEdge {
  return { standby, streaming, state: streaming ? "streaming" : "not streaming", level };
}

describe("layoutTopology", () => {
  it("puts the primary on the left and draws a line to the middle of every standby row", () => {
    const layout = layoutTopology(
      [instance("pg-1", "primary"), instance("pg-2", "standby"), instance("pg-3", "standby")],
      [edge("pg-3", "warning"), edge("pg-2")],
      "pg-1",
    );
    expect(layout.primary?.name).toBe("pg-1");
    expect(layout.rows.map((row) => row.instance.name)).toEqual(["pg-3", "pg-2"]);
    expect(layout.height).toBe(200);
    expect(layout.lines).toEqual([
      { standby: "pg-3", y1: 100, y2: 50, labelY: 75, level: "warning", streaming: true },
      { standby: "pg-2", y1: 100, y2: 150, labelY: 125, level: "ok", streaming: true },
    ]);
  });

  it("lists the instances without an edge after the others, by name, with no line", () => {
    const layout = layoutTopology(
      [
        instance("pg-1", "primary"),
        instance("pg-4", "unknown"),
        instance("pg-2", "standby"),
        instance("pg-3", "unknown"),
      ],
      [edge("pg-2", "error", false)],
      "pg-1",
    );
    expect(layout.rows.map((row) => [row.instance.name, Boolean(row.edge)])).toEqual([
      ["pg-2", true],
      ["pg-3", false],
      ["pg-4", false],
    ]);
    expect(layout.lines).toEqual([{ standby: "pg-2", y1: 150, y2: 50, labelY: 100, level: "error", streaming: false }]);
  });

  it("draws no line without a primary, and a single instance alone", () => {
    const orphaned = layoutTopology(
      [instance("pg-1", "unknown"), instance("pg-2", "standby")],
      [edge("pg-2")],
      undefined,
    );
    expect(orphaned.primary).toBeUndefined();
    expect(orphaned.rows).toHaveLength(2);
    expect(orphaned.lines).toEqual([]);

    const single = layoutTopology([instance("pg-1", "primary")], [], "pg-1");
    expect(single).toMatchObject({ rows: [], lines: [], height: 100 });
  });

  it("ignores an edge towards an instance the cluster does not declare", () => {
    const layout = layoutTopology([instance("pg-1", "primary")], [edge("ghost")], "pg-1");
    expect(layout.rows).toEqual([]);
    expect(layout.lines).toEqual([]);
  });
});
