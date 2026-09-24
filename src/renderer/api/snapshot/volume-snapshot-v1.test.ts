/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { orderSnapshots, snapshotFacts, snapshotLabel, snapshotReason } from "./volume-snapshot-v1";

import type { SnapshotFacts, SnapshotLike } from "./volume-snapshot-v1";

/** As the operator wrote it on a real cold backup (v1.30.0): the role is an annotation, the rest are labels. */
const DATA: SnapshotLike = {
  metadata: {
    name: "e2e-snapshot-ok",
    labels: {
      "cnpg.io/backupDate": "20260924",
      "cnpg.io/backupName": "e2e-snapshot-ok",
      "cnpg.io/cluster": "e2e-snapshots",
    },
    annotations: { "cnpg.io/onlineBackup": "false", "cnpg.io/pvcRole": "PG_DATA" },
  },
  spec: { volumeSnapshotClassName: "csi-hostpath-snapclass" },
  status: { readyToUse: true, creationTime: "2026-09-24T10:30:16Z" },
};

const TABLESPACE: SnapshotLike = {
  metadata: {
    name: "e2e-snapshot-ok-tbs-analytics",
    labels: { "cnpg.io/backupName": "e2e-snapshot-ok", "cnpg.io/tablespaceName": "analytics" },
    annotations: { "cnpg.io/pvcRole": "PG_TABLESPACE", "cnpg.io/onlineBackup": "true" },
  },
  status: { readyToUse: true },
};

describe("snapshotFacts", () => {
  it("reads the role from the annotation, the rest from the labels, and the day from the date label", () => {
    expect(snapshotFacts(DATA)).toEqual({
      name: "e2e-snapshot-ok",
      role: "PG_DATA",
      tablespace: undefined,
      backup: "e2e-snapshot-ok",
      cluster: "e2e-snapshots",
      date: "2026-09-24",
      hot: false,
      ready: true,
      className: "csi-hostpath-snapclass",
    });
    expect(snapshotFacts(TABLESPACE)).toMatchObject({ role: "PG_TABLESPACE", tablespace: "analytics", hot: true });
  });

  it("falls back on the creation time for the day and says nothing it does not know", () => {
    const facts = snapshotFacts({ metadata: { name: "manual" }, status: { creationTime: "2026-09-23T08:00:00Z" } });
    expect(facts).toEqual({
      name: "manual",
      role: undefined,
      tablespace: undefined,
      backup: undefined,
      cluster: undefined,
      date: "2026-09-23",
      hot: undefined,
      ready: false,
      className: undefined,
    });
  });
});

describe("snapshotLabel and snapshotReason", () => {
  it("says the backup, the cluster, the day and hot or cold on one line", () => {
    expect(snapshotLabel(snapshotFacts(DATA))).toBe(
      "e2e-snapshot-ok (backup e2e-snapshot-ok, of e2e-snapshots, 2026-09-24, cold)",
    );
    expect(snapshotLabel({ name: "manual", ready: true })).toBe("manual");
  });

  it("dims what is not ready, not the operator's, of another role or of another tablespace", () => {
    expect(snapshotReason(snapshotFacts(DATA), "PG_DATA")).toBeUndefined();
    expect(snapshotReason({ name: "x", ready: false, role: "PG_DATA" }, "PG_DATA")).toBe("not ready to use yet");
    expect(snapshotReason({ name: "x", ready: true }, "PG_DATA")).toBe(
      "not taken by the operator: its content is unknown",
    );
    expect(snapshotReason(snapshotFacts(DATA), "PG_WAL")).toBe("a PG_DATA snapshot, not PG_WAL");
    expect(snapshotReason(snapshotFacts(TABLESPACE), "PG_TABLESPACE", "analytics")).toBeUndefined();
    expect(snapshotReason(snapshotFacts(TABLESPACE), "PG_TABLESPACE", "reports")).toBe(
      "the snapshot of the tablespace analytics, not reports",
    );
  });
});

describe("orderSnapshots", () => {
  it("puts the usable snapshots of the wanted kind first, newest first", () => {
    const all: SnapshotFacts[] = [
      { name: "old-data", role: "PG_DATA", date: "2026-09-01", ready: true },
      { name: "wal", role: "PG_WAL", date: "2026-09-24", ready: true },
      { name: "new-data", role: "PG_DATA", date: "2026-09-24", ready: true },
      { name: "pending-data", role: "PG_DATA", date: "2026-09-25", ready: false },
    ];
    expect(orderSnapshots(all, "PG_DATA").map((facts) => facts.name)).toEqual([
      "new-data",
      "old-data",
      "pending-data",
      "wal",
    ]);
  });
});
