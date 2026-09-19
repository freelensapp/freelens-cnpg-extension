/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import {
  buildLiveView,
  LAG_WARNING_BYTES,
  LAG_WARNING_MS,
  LONG_TRANSACTION_SECONDS,
  READY_WAL_WARNING,
  XID_AGE_ERROR,
  XID_AGE_WARNING,
} from "./live-model";

import type { PostgresqlStatus, ReplicationInfo } from "../../api/instance/postgresql-status";
import type { InstanceReading, InstanceSeed } from "./live-model";

const SEEDS: InstanceSeed[] = [
  { name: "pg-1", fenced: false, node: "worker-a" },
  { name: "pg-2", fenced: false, node: "worker-b" },
  { name: "pg-3", fenced: false, node: "worker-a" },
];

function primaryStatus(overrides: Partial<PostgresqlStatus> = {}): PostgresqlStatus {
  return {
    isPrimary: true,
    pod: { metadata: { name: "pg-1" } },
    currentLsn: "0/B000060",
    timeLineID: 1,
    instanceManagerVersion: "1.30.0",
    instanceArch: "amd64",
    ...overrides,
  };
}

function standbyStatus(name: string, overrides: Partial<PostgresqlStatus> = {}): PostgresqlStatus {
  return {
    isPrimary: false,
    pod: { metadata: { name } },
    receivedLsn: "0/B000060",
    replayLsn: "0/B000060",
    isWalReceiverActive: true,
    timeLineID: 1,
    instanceManagerVersion: "1.30.0",
    instanceArch: "amd64",
    lastArchivedWALTime: "-infinity",
    lastFailedWALTime: "-infinity",
    ...overrides,
  };
}

function streaming(applicationName: string, overrides: Partial<ReplicationInfo> = {}): ReplicationInfo {
  return {
    applicationName,
    state: "streaming",
    receivedLsn: "0/B000060",
    replayLsn: "0/B000060",
    writeLag: "00:00:00",
    flushLag: "00:00:00",
    replayLag: "00:00:00",
    syncState: "async",
    syncPriority: "0",
    ...overrides,
  };
}

function ok(status: PostgresqlStatus, metrics?: string): InstanceReading {
  return {
    status: { ok: true, value: status },
    metrics: metrics === undefined ? undefined : { ok: true, value: parsePrometheusText(metrics) },
  };
}

function view(readings: Record<string, InstanceReading>, declaredPrimary: string | undefined = "pg-1", seeds = SEEDS) {
  return buildLiveView({ instances: seeds, declaredPrimary, readings: new Map(Object.entries(readings)) });
}

describe("topology", () => {
  it("draws one edge per standby with the lag as time and as bytes, the worst first", () => {
    const live = view({
      "pg-1": ok(
        primaryStatus({
          currentLsn: "0/C000000",
          replicationInfo: [
            streaming("pg-2", { syncState: "quorum", syncPriority: "1" }),
            streaming("pg-3", { replayLsn: "0/B000000", replayLag: "00:00:12.5" }),
          ],
        }),
      ),
      "pg-2": ok(standbyStatus("pg-2")),
      "pg-3": ok(standbyStatus("pg-3")),
    });

    expect(live.primary).toBe("pg-1");
    expect(live.primaryDisagreement).toBeUndefined();
    expect(live.instances.map((instance) => [instance.name, instance.role, instance.node])).toEqual([
      ["pg-1", "primary", "worker-a"],
      ["pg-2", "standby", "worker-b"],
      ["pg-3", "standby", "worker-a"],
    ]);
    expect(live.edges.map((edge) => edge.standby)).toEqual(["pg-3", "pg-2"]);
    expect(live.edges[0]).toMatchObject({
      streaming: true,
      replayLagMs: 12_500,
      replayBytes: BigInt(0xc000000 - 0xb000000),
      level: "warning",
    });
    expect(live.edges[1]).toMatchObject({ syncState: "quorum", syncPriority: 1, replayLagMs: 0, level: "ok" });
  });

  it("warns past the thresholds, not at them", () => {
    const at = (replayLag: string, replayLsn: string) =>
      view({
        "pg-1": ok(
          primaryStatus({ currentLsn: "1/0", replicationInfo: [streaming("pg-2", { replayLag, replayLsn })] }),
        ),
        "pg-2": ok(standbyStatus("pg-2")),
      }).edges[0].level;
    const behind = (bytes: bigint) => `0/${(0x100000000n - bytes).toString(16)}`;

    expect(LAG_WARNING_MS).toBe(10_000);
    expect(at("00:00:10", "1/0")).toBe("ok");
    expect(at("00:00:10.001", "1/0")).toBe("warning");
    expect(at("00:00:00", behind(LAG_WARNING_BYTES))).toBe("ok");
    expect(at("00:00:00", behind(LAG_WARNING_BYTES + 1n))).toBe("warning");
  });

  it("draws a standby the primary does not list as detached, and one that is not streaming in error", () => {
    const live = view({
      "pg-1": ok(primaryStatus({ replicationInfo: [streaming("pg-2", { state: "catchup" })] })),
      "pg-2": ok(standbyStatus("pg-2")),
      "pg-3": ok(standbyStatus("pg-3", { isWalReceiverActive: false })),
    });
    expect(live.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ standby: "pg-3", streaming: false, state: "not streaming", level: "error" }),
        expect.objectContaining({ standby: "pg-2", streaming: false, state: "catchup", level: "error" }),
      ]),
    );
    expect(live.instances[2].flags).toContain("WAL receiver down");
  });

  it("keeps the edge of a standby that streams but did not answer", () => {
    const live = view({
      "pg-1": ok(primaryStatus({ replicationInfo: [streaming("pg-2")] })),
      "pg-2": { status: { ok: false, failure: { kind: "timeout" } } },
    });
    expect(live.edges).toEqual([expect.objectContaining({ standby: "pg-2", streaming: true, level: "ok" })]);
    expect(live.instances[1]).toMatchObject({ role: "unknown", statusFailure: { kind: "timeout" }, pending: false });
    expect(live.instances[2]).toMatchObject({ pending: true });
  });

  it("shows a disagreement about the primary instead of hiding it", () => {
    const moved = view({
      "pg-1": ok(standbyStatus("pg-1")),
      "pg-2": ok(primaryStatus({ pod: { metadata: { name: "pg-2" } } })),
    });
    expect(moved.primary).toBe("pg-2");
    expect(moved.primaryDisagreement).toBe("pg-2 says it is the primary while the cluster status names pg-1");

    const split = view({
      "pg-1": ok(primaryStatus()),
      "pg-2": ok(primaryStatus({ pod: { metadata: { name: "pg-2" } } })),
    });
    expect(split.primary).toBe("pg-1");
    expect(split.primaryDisagreement).toContain("More than one instance says it is the primary: pg-1, pg-2");
  });

  it("does not take a fenced instance for a primary: the manager answers, PostgreSQL does not", () => {
    // As observed on the E2E cluster: isPrimary true, empty system ID, the masked error.
    const fenced = view(
      {
        "pg-1": ok({
          isPrimary: true,
          systemID: "",
          pod: { metadata: { name: "pg-1" } },
          mightBeUnavailable: true,
          mightBeUnavailableMaskedError: "failed to connect to `user=postgres database=postgres`: no such file\nmore",
        }),
      },
      "pg-1",
      [{ name: "pg-1", fenced: true }],
    );
    expect(fenced.primary).toBeUndefined();
    expect(fenced.instances[0]).toMatchObject({
      role: "unknown",
      fenced: true,
      postgresDown: "failed to connect to `user=postgres database=postgres`: no such file",
      flags: ["fenced"],
    });
    expect(fenced.wal).toBeUndefined();
  });

  it("carries the instance flags and warns about missing synchronous standbys", () => {
    const live = view({
      "pg-1": ok(
        primaryStatus({ pendingRestart: true }),
        'cnpg_collector_sync_replicas{value="observed"} 0\ncnpg_collector_sync_replicas{value="min"} 1\n',
      ),
      "pg-2": ok(standbyStatus("pg-2", { replayPaused: true, isPgRewindRunning: true })),
    });
    expect(live.instances[0].flags).toEqual(["pending restart"]);
    expect(live.instances[1].flags).toEqual(["replay paused", "pg_rewind running"]);
    expect(live.syncWarning).toBe("0 synchronous standbys observed, 1 required");
  });
});

const PRIMARY_METRICS = `
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="cnpg_metrics_exporter"} 1
cnpg_backends_total{application_name="pg-2",datname="",state="active",usename="streaming_replica"} 1
cnpg_backends_total{application_name="api",datname="app",state="active",usename="app"} 3
cnpg_backends_total{application_name="api",datname="app",state="idle",usename="app"} 7
cnpg_backends_total{application_name="psql",datname="postgres",state="idle in transaction",usename="alice"} 1
cnpg_backends_max_tx_duration_seconds{application_name="pg-2",datname="",state="active",usename="streaming_replica"} 90000
cnpg_backends_max_tx_duration_seconds{application_name="psql",datname="postgres",state="idle in transaction",usename="alice"} ${LONG_TRANSACTION_SECONDS + 1}
cnpg_backends_waiting_total 2
cnpg_pg_settings_setting{name="max_connections"} 100
cnpg_pg_database_size_bytes{datname="app"} 4e+09
cnpg_pg_database_size_bytes{datname="postgres"} 8e+06
cnpg_pg_database_size_bytes{datname="template1"} 8e+06
cnpg_pg_database_xid_age{datname="app"} ${XID_AGE_ERROR + 1}
cnpg_pg_database_xid_age{datname="postgres"} ${XID_AGE_WARNING + 1}
cnpg_pg_database_xid_age{datname="template1"} ${XID_AGE_WARNING}
cnpg_pg_stat_archiver_archived_count 13
cnpg_pg_stat_archiver_failed_count 18
cnpg_collector_pg_wal{value="count"} 12
cnpg_collector_pg_wal{value="size"} 2.01326592e+08
cnpg_collector_pg_wal{value="volume_size"} NaN
cnpg_collector_pg_wal_archive_status{value="ready"} 3
cnpg_pg_replication_slots_pg_wal_lsn_diff{database="",slot_name="_cnpg_pg_2",slot_type="physical"} 0
cnpg_pg_replication_slots_pg_wal_lsn_diff{database="",slot_name="old_logical",slot_type="logical"} 5e+08
`;

const STANDBY_METRICS = `
cnpg_backends_total{application_name="report",datname="app",state="active",usename="reader"} 2
cnpg_backends_waiting_total 1
cnpg_pg_database_size_bytes{datname="app"} 4e+09
`;

describe("tiles", () => {
  const live = view({
    "pg-1": ok(
      primaryStatus({
        replicationInfo: [streaming("pg-2")],
        currentWAL: "00000001000000000000000B",
        lastArchivedWAL: "00000001000000000000000A",
        lastArchivedWALTime: "2026-09-19T08:02:24.28131Z",
        lastFailedWAL: "000000010000000000000001",
        lastFailedWALTime: "2026-09-18T16:14:05.246717Z",
        replicationSlotsInfo: [
          {
            slotName: "old_logical",
            slotType: "logical",
            active: false,
            restartLsn: "0/1000000",
            walStatus: "extended",
          },
          {
            slotName: "_cnpg_pg_2",
            slotType: "physical",
            active: true,
            restartLsn: "0/B000060",
            walStatus: "reserved",
          },
        ],
      }),
      PRIMARY_METRICS,
    ),
    "pg-2": ok(standbyStatus("pg-2"), STANDBY_METRICS),
  });

  it("sums the sessions over the instances and tells the platform's own apart", () => {
    expect(live.sessions).toMatchObject({
      total: 15,
      system: 2,
      user: 13,
      primary: 13,
      standbys: 2,
      waiting: 3,
      maxConnections: 100,
      longestTransactionSeconds: LONG_TRANSACTION_SECONDS + 1,
      longestTransactionLevel: "warning",
    });
    // Ties are broken by name, so the order never flickers between two polls.
    expect(live.sessions?.byState).toEqual([
      { state: "active", count: 7 },
      { state: "idle", count: 7 },
      { state: "idle in transaction", count: 1 },
    ]);
    expect(live.sessions?.topDatabases).toEqual([
      { name: "app", count: 12 },
      { name: "postgres", count: 1 },
    ]);
    expect(live.sessions?.topUsers.map((entry) => entry.name)).toEqual(["app", "reader", "alice"]);
  });

  it("reads the databases from the primary only, largest first, with the transaction ID age levels", () => {
    expect(live.databases.map((database) => [database.name, database.sizeBytes, database.level])).toEqual([
      ["app", 4_000_000_000, "error"],
      ["postgres", 8_000_000, "warning"],
      ["template1", 8_000_000, "ok"],
    ]);
    expect(live.databases[0].share).toBe(1);
    expect(live.databases[1].share).toBeCloseTo(0.002, 5);
  });

  it("reads WAL and archiving from the primary, with NaN figures left out", () => {
    expect(live.wal).toMatchObject({
      state: "Archiving",
      currentWal: "00000001000000000000000B",
      lastArchivedWal: "00000001000000000000000A",
      readyFiles: 3,
      readyLevel: "ok",
      archivedCount: 13,
      failedCount: 18,
      walFiles: 12,
      walSizeBytes: 201_326_592,
      volumeSizeBytes: undefined,
    });
    expect(live.wal?.lastArchivedAt?.toISOString()).toBe("2026-09-19T08:02:24.281Z");
  });

  it("warns about an inactive slot that holds WAL back, not about an active one", () => {
    expect(live.slots).toEqual([
      expect.objectContaining({ name: "_cnpg_pg_2", active: true, retainedBytes: 0, level: "ok" }),
      expect.objectContaining({ name: "old_logical", active: false, retainedBytes: 500_000_000, level: "warning" }),
    ]);
  });
});

describe("archiving refinement", () => {
  const stateOf = (overrides: Partial<PostgresqlStatus>) => view({ "pg-1": ok(primaryStatus(overrides)) }).wal;

  it("is Failing when the last failure is newer than the last success", () => {
    expect(
      stateOf({ lastArchivedWALTime: "2026-09-19T08:00:00Z", lastFailedWALTime: "2026-09-19T08:05:00Z" })?.state,
    ).toBe("Failing");
    expect(stateOf({ lastFailedWALTime: "2026-09-19T08:05:00Z" })?.state).toBe("Failing");
    expect(stateOf({ lastArchivedWALTime: "-infinity", lastFailedWALTime: "-infinity" })?.state).toBe("Unknown");
  });

  it("warns about the files waiting past the threshold, reading the status before the metrics", () => {
    expect(stateOf({ readyWalFiles: READY_WAL_WARNING })?.readyLevel).toBe("ok");
    expect(stateOf({ readyWalFiles: READY_WAL_WARNING + 1 })).toMatchObject({
      readyFiles: READY_WAL_WARNING + 1,
      readyLevel: "warning",
    });
  });
});

describe("page level states", () => {
  it("is pending until something answers and forbidden only when every instance says so", () => {
    expect(view({}).pending).toBe(true);
    const forbidden: InstanceReading = { status: { ok: false, failure: { kind: "forbidden", status: 403 } } };
    expect(view({ "pg-1": forbidden, "pg-2": forbidden, "pg-3": forbidden })).toMatchObject({
      forbidden: true,
      pending: false,
    });
    expect(view({ "pg-1": forbidden, "pg-2": ok(standbyStatus("pg-2")), "pg-3": forbidden }).forbidden).toBe(false);
    expect(view({ "pg-1": forbidden }).forbidden).toBe(false);
  });

  it("notices instance managers of different versions", () => {
    const skewed = view({
      "pg-1": ok(primaryStatus()),
      "pg-2": ok(standbyStatus("pg-2", { instanceManagerVersion: "1.29.2", isInstanceManagerUpgrading: true })),
    });
    expect(skewed.manager.skew).toBe(true);
    expect(skewed.manager.instances[1]).toEqual({ name: "pg-2", version: "1.29.2", arch: "amd64", upgrading: true });
    expect(view({ "pg-1": ok(primaryStatus()), "pg-2": ok(standbyStatus("pg-2")) }).manager.skew).toBe(false);
  });

  it("has no sessions, databases or WAL without metrics and without a primary", () => {
    const live = view({ "pg-2": ok(standbyStatus("pg-2")) });
    expect(live).toMatchObject({ primary: undefined, sessions: undefined, databases: [], wal: undefined, slots: [] });
  });
});
