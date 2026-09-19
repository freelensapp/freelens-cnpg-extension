/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { HEALTHY_PHASE } from "./cluster-health";
import { certificateHorizon, compareTiles, isBackupOverdue, summarize } from "./overview-model";

import type { ClusterStatus } from "../api/cnpg/cluster-v1";
import type { KubeCondition } from "../api/types";

const NOW = new Date("2026-09-18T20:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function condition(type: string, status: KubeCondition["status"], reason?: string, message?: string): KubeCondition {
  return { type, status, reason, message };
}

function cluster(
  name: string,
  { namespace = "db", instances = 3, annotations = {}, status = {} } = {} as {
    namespace?: string;
    instances?: number;
    annotations?: Record<string, string>;
    status?: ClusterStatus;
  },
): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace, annotations },
    spec: { instances },
    status: {
      phase: HEALTHY_PHASE,
      instances,
      readyInstances: instances,
      instanceNames: Array.from({ length: instances }, (_, i) => `${name}-${i + 1}`),
      currentPrimary: `${name}-1`,
      targetPrimary: `${name}-1`,
      conditions: [condition("Ready", "True"), condition("ContinuousArchiving", "True")],
      pgDataImageInfo: { image: "ghcr.io/cloudnative-pg/postgresql:18.4", majorVersion: 18 },
      certificates: {
        serverCASecret: `${name}-ca`,
        serverTLSSecret: `${name}-server`,
        clientCASecret: `${name}-ca`,
        replicationTLSSecret: `${name}-replication`,
        expirations: {
          [`${name}-ca`]: "2026-12-17 16:03:14 +0000 UTC",
          [`${name}-server`]: "2026-12-17 16:03:14 +0000 UTC",
          [`${name}-replication`]: "2026-12-17 16:03:14 +0000 UTC",
        },
      },
      ...status,
    },
  } as never);
}

function backup(name: string, clusterName: string, phase: string, stoppedAt?: string, namespace = "db"): Backup {
  return new Backup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace, creationTimestamp: "2026-09-18T09:00:00Z" },
    spec: { cluster: { name: clusterName }, method: "plugin" },
    status: { phase, stoppedAt },
  } as never);
}

function schedule(name: string, clusterName: string, nextScheduleTime?: string, suspend = false): ScheduledBackup {
  return new ScheduledBackup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ScheduledBackup",
    metadata: { name, namespace: "db" },
    spec: { cluster: { name: clusterName }, schedule: "0 0 2 * * *", suspend },
    status: { nextScheduleTime },
  } as never);
}

describe("summarize", () => {
  it("counts the fleet and orders the tiles by urgency, then namespace and name", () => {
    const clusters = [
      cluster("zeta"),
      cluster("alpha"),
      cluster("degraded", { status: { readyInstances: 2 } }),
      cluster("failed", { status: { phase: "Invalid cluster definition" } }),
      cluster("sleeping", {
        instances: 1,
        annotations: { "cnpg.io/hibernation": "on" },
        status: { readyInstances: 0 },
      }),
      cluster("moving", { status: { phase: "Switchover in progress", readyInstances: 2 } }),
      cluster("mystery", { status: { phase: "Something else" } }),
      cluster("early", { namespace: "aaa" }),
    ];
    const summary = summarize(clusters, [], [], NOW);

    expect(summary.clusters).toBe(8);
    expect(summary.byState).toEqual({ Healthy: 3, Progressing: 1, Degraded: 1, Failed: 1, Hibernated: 1, Unknown: 1 });
    expect(summary.tiles.map((tile) => tile.name)).toEqual([
      "failed",
      "degraded",
      "moving",
      "mystery",
      "early",
      "alpha",
      "zeta",
      "sleeping",
    ]);
    // 7 clusters of 3 declared instances plus the hibernated one; ready: 3+3+3+3+2+2+3 = 19
    expect(summary.instancesTotal).toBe(22);
    expect(summary.instancesReady).toBe(19);
  });

  it("counts archiving failures, overdue backups and certificate horizons", () => {
    const clusters = [
      cluster("fresh"),
      cluster("stale"),
      cluster("never"),
      cluster("archive", {
        status: {
          conditions: [condition("Ready", "True"), condition("ContinuousArchiving", "False", "Failing", "boom")],
        },
      }),
      cluster("certs", {
        status: {
          certificates: {
            serverCASecret: "certs-ca",
            expirations: { "certs-ca": new Date(NOW.getTime() + 10 * DAY).toISOString() },
          },
        },
      }),
      cluster("sleeping", { instances: 1, annotations: { "cnpg.io/hibernation": "on" } }),
    ];
    const backups = [
      backup("b-fresh", "fresh", "completed", new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString()),
      backup("b-stale", "stale", "completed", new Date(NOW.getTime() - 3 * DAY).toISOString()),
      backup("b-archive", "archive", "completed", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()),
      backup("b-certs", "certs", "completed", new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()),
      backup("b-other-ns", "never", "completed", NOW.toISOString(), "elsewhere"),
    ];
    const summary = summarize(clusters, backups, [], NOW);

    expect(summary.archivingFailing).toBe(1);
    // stale (3 days), never (no backup); fresh, archive, certs are recent; sleeping is exempt
    expect(summary.backupsOverdue).toBe(2);
    expect(summary.certificatesExpiring).toBe(1);

    const byName = Object.fromEntries(summary.tiles.map((tile) => [tile.name, tile]));
    expect(byName.fresh.backupOverdue).toBe(false);
    expect(byName.stale.backupOverdue).toBe(true);
    expect(byName.never.backupOverdue).toBe(true);
    expect(byName.never.backups.source).toBe("none");
    expect(byName.sleeping.backupOverdue).toBe(false);
    expect(byName.archive.health.state).toBe("Degraded");
    expect(byName.archive.archiving.state).toBe("Failing");
    expect(byName.certs.certificateHorizon).toMatchObject({ state: "expiring", daysLeft: 10 });
    expect(byName.fresh.certificateHorizon.state).toBe("ok");
    expect(byName.fresh.certificateHorizon.earliest?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
  });

  it("carries the primary, the target primary during a switchover, the major version and the next schedule", () => {
    const moving = cluster("moving", {
      status: { phase: "Switchover in progress", targetPrimary: "moving-2", readyInstances: 3 },
    });
    const schedules = [
      schedule("nightly", "moving", "2026-09-19T02:00:00Z"),
      schedule("weekly", "moving", "2026-09-21T02:00:00Z"),
      schedule("paused", "moving", "2026-09-18T21:00:00Z", true),
    ];
    const [tile] = summarize([moving], [], schedules, NOW).tiles;

    expect(tile.primary).toBe("moving-1");
    expect(tile.targetPrimary).toBe("moving-2");
    expect(tile.postgresMajor).toBe(18);
    expect(tile.nextScheduledBackup?.toISOString()).toBe("2026-09-19T02:00:00.000Z");
    expect(tile.scheduledBackupSuspended).toBe(false);
    expect(tile.instances.map((instance) => instance.role)).toEqual(["primary", "replica", "replica"]);
  });

  it("reports a suspended schedule only when no active one exists", () => {
    const only = summarize([cluster("pg")], [], [schedule("paused", "pg", "2026-09-19T02:00:00Z", true)], NOW).tiles[0];
    expect(only.scheduledBackupSuspended).toBe(true);
    expect(only.nextScheduledBackup?.toISOString()).toBe("2026-09-19T02:00:00.000Z");
    expect(summarize([cluster("pg")], [], [], NOW).tiles[0].nextScheduledBackup).toBeUndefined();
  });

  it("is empty and stable for empty inputs", () => {
    expect(summarize([], [], [], NOW)).toEqual({
      clusters: 0,
      byState: { Healthy: 0, Progressing: 0, Degraded: 0, Failed: 0, Hibernated: 0, Unknown: 0 },
      instancesReady: 0,
      instancesTotal: 0,
      archivingFailing: 0,
      backupsOverdue: 0,
      certificatesExpiring: 0,
      tiles: [],
    });
  });
});

describe("certificateHorizon", () => {
  it("is unknown without parsed expirations and takes the earliest otherwise", () => {
    expect(certificateHorizon([], NOW)).toEqual({ state: "unknown" });
    expect(certificateHorizon([{ role: "server CA", state: "unknown" }], NOW)).toEqual({ state: "unknown" });
    const horizon = certificateHorizon(
      [
        { role: "server CA", secretName: "a", expiresAt: new Date(NOW.getTime() + 100 * DAY), state: "ok" },
        { role: "server TLS", secretName: "b", expiresAt: new Date(NOW.getTime() + 5 * DAY), state: "expiring" },
      ],
      NOW,
    );
    expect(horizon).toEqual({ state: "expiring", earliest: new Date(NOW.getTime() + 5 * DAY), daysLeft: 5 });
    const expired = certificateHorizon(
      [{ role: "server CA", secretName: "a", expiresAt: new Date(NOW.getTime() - 2 * DAY), state: "expired" }],
      NOW,
    );
    expect(expired).toMatchObject({ state: "expired", daysLeft: -2 });
  });
});

describe("isBackupOverdue and compareTiles", () => {
  it("judges the 24 hour window and exempts hibernated clusters", () => {
    const healthy = { state: "Healthy" } as never;
    const hibernated = { state: "Hibernated" } as never;
    const recent = { lastSuccessful: new Date(NOW.getTime() - DAY + 1000), source: "backups", count: 1 } as never;
    const old = { lastSuccessful: new Date(NOW.getTime() - DAY - 1000), source: "backups", count: 1 } as never;
    const none = { source: "none", count: 0 } as never;
    expect(isBackupOverdue(healthy, recent, NOW)).toBe(false);
    expect(isBackupOverdue(healthy, old, NOW)).toBe(true);
    expect(isBackupOverdue(healthy, none, NOW)).toBe(true);
    expect(isBackupOverdue(hibernated, none, NOW)).toBe(false);
  });

  it("orders by urgency first", () => {
    const tiles = summarize(
      [cluster("b"), cluster("a", { status: { phase: "Invalid cluster definition" } })],
      [],
      [],
      NOW,
    ).tiles;
    expect([...tiles].sort(compareTiles).map((tile) => tile.name)).toEqual(["a", "b"]);
  });
});
