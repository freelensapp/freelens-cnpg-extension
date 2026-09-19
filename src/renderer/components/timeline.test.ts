/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { buildTimeline, categoryCounts, filterTimeline, groupTimeline, isEventOfCluster } from "./timeline";

import type { ClusterStatus } from "../api/cnpg/cluster-v1";
import type { KubeEventLike, TimelineInput } from "./timeline";

const NOW = new Date("2026-09-19T15:00:00Z");

function cluster(name = "pg", status: ClusterStatus = {}, namespace = "db"): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace, creationTimestamp: "2026-09-18T10:00:00Z" },
    spec: { instances: 2 },
    status: { instanceNames: [`${name}-1`, `${name}-2`], currentPrimary: `${name}-1`, ...status },
  } as never);
}

function backup(name: string, phase: string, startedAt?: string, stoppedAt?: string, clusterName = "pg"): Backup {
  return new Backup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace: "db", creationTimestamp: startedAt },
    spec: { cluster: { name: clusterName }, method: "plugin" },
    status: { phase, startedAt, stoppedAt, error: phase === "failed" ? "exit status 4" : undefined },
  } as never);
}

function schedule(name: string, next?: string, suspend = false): ScheduledBackup {
  return new ScheduledBackup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ScheduledBackup",
    metadata: { name, namespace: "db" },
    spec: { cluster: { name: "pg" }, schedule: "0 0 2 * * *", suspend },
    status: { nextScheduleTime: next },
  } as never);
}

function event(
  kind: string,
  name: string,
  reason: string,
  at: string,
  extra: Partial<KubeEventLike> = {},
): KubeEventLike {
  return {
    metadata: { name: `${name}.${reason}`, namespace: "db", uid: `${name}-${reason}-${at}` },
    involvedObject: { kind, name, namespace: "db" },
    reason,
    message: `${reason} on ${name}`,
    type: "Normal",
    lastTimestamp: at,
    ...extra,
  };
}

describe("isEventOfCluster", () => {
  const input: TimelineInput = {
    cluster: cluster(),
    clusters: [cluster(), cluster("pg-2")],
    backups: [backup("nightly-1", "completed", "2026-09-19T02:00:00Z", "2026-09-19T02:01:00Z")],
    schedules: [schedule("nightly")],
    owned: [
      { kind: "Pod", metadata: { name: "pg-1-join-abcde", namespace: "db", labels: { "cnpg.io/cluster": "pg" } } },
      { kind: "Pod", metadata: { name: "pgadmin-0", namespace: "db", labels: {} } },
    ],
  };

  it("takes the events of the cluster, of its instances and of what carries its label", () => {
    expect(isEventOfCluster(event("Cluster", "pg", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("Pod", "pg-1", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("Pod", "pg-1-join-abcde", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("Backup", "nightly-1", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("ScheduledBackup", "nightly", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
  });

  it("leaves out what belongs to somebody else", () => {
    expect(isEventOfCluster(event("Cluster", "pg-2", "x", "2026-09-19T14:00:00Z"), input)).toBe(false);
    expect(isEventOfCluster(event("Pod", "pgadmin-0", "x", "2026-09-19T14:00:00Z"), input)).toBe(false);
    expect(isEventOfCluster(event("Backup", "somebody-else", "x", "2026-09-19T14:00:00Z"), input)).toBe(false);
    const elsewhere = event("Pod", "pg-1", "x", "2026-09-19T14:00:00Z");
    elsewhere.involvedObject = { kind: "Pod", name: "pg-1", namespace: "other" };
    expect(isEventOfCluster(elsewhere, input)).toBe(false);
  });

  it("tells pg from pg-2 by name when the object is already gone", () => {
    expect(isEventOfCluster(event("Pod", "pg-3", "Killing", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("Pod", "pg-2-1", "Killing", "2026-09-19T14:00:00Z"), input)).toBe(false);
    expect(isEventOfCluster(event("PersistentVolumeClaim", "pg-3-wal", "x", "2026-09-19T14:00:00Z"), input)).toBe(true);
    expect(isEventOfCluster(event("Deployment", "pg-something", "x", "2026-09-19T14:00:00Z"), input)).toBe(false);
  });
});

describe("buildTimeline", () => {
  const input: TimelineInput = {
    cluster: cluster("pg", {
      currentPrimaryTimestamp: "2026-09-18T10:05:00.000000Z",
      conditions: [
        { type: "Ready", status: "True", lastTransitionTime: "2026-09-18T10:06:00Z", reason: "ClusterIsReady" },
        {
          type: "ContinuousArchiving",
          status: "False",
          lastTransitionTime: "2026-09-19T09:00:00Z",
          message: "unexpected failure invoking barman-cloud-wal-archive",
        },
      ],
    }),
    events: [
      event("Pod", "pg-2", "Unhealthy", "2026-09-19T14:30:00Z", { type: "Warning", count: 12 }),
      event("Cluster", "pg-2", "NotOurs", "2026-09-19T14:31:00Z"),
    ],
    backups: [
      backup("ok", "completed", "2026-09-19T02:00:00Z", "2026-09-19T02:01:30Z"),
      backup("bad", "failed", "2026-09-19T03:00:00Z", "2026-09-19T03:00:10Z"),
      backup("foreign", "completed", "2026-09-19T04:00:00Z", "2026-09-19T04:01:00Z", "pg-2"),
    ],
    schedules: [
      schedule("nightly", "2026-09-20T02:00:00Z"),
      schedule("paused", "2026-09-20T03:00:00Z", true),
      schedule("stale", "2026-09-19T02:00:00Z"),
    ],
    lease: {
      metadata: { name: "pg", namespace: "db" },
      spec: {
        holderIdentity: "pg-1",
        acquireTime: "2026-09-18T10:05:01.000000Z",
        renewTime: "2026-09-19T14:59:58.000000Z",
        leaseDurationSeconds: 15,
        leaseTransitions: 1,
      },
    },
    now: NOW,
  };
  const entries = buildTimeline(input);

  it("puts events, backups, the primary, the conditions and what is to come on one axis, newest first", () => {
    expect(entries.map((entry) => entry.id)).toEqual([
      "scheduled/backup/nightly",
      "event/pg-2-Unhealthy-2026-09-19T14:30:00Z",
      "condition/ContinuousArchiving",
      "backup/bad/failed",
      "backup/bad/started",
      "backup/ok/completed",
      "backup/ok/started",
      "condition/Ready",
      "primary/lease",
      "primary/current",
      "cluster/created",
    ]);
  });

  it("gives every entry the level a reader expects", () => {
    const level = (id: string) => entries.find((entry) => entry.id === id)?.level;
    expect(level("event/pg-2-Unhealthy-2026-09-19T14:30:00Z")).toBe("warning");
    expect(level("backup/bad/failed")).toBe("error");
    expect(level("backup/ok/completed")).toBe("success");
    expect(level("condition/ContinuousArchiving")).toBe("error");
    expect(level("condition/Ready")).toBe("success");
    expect(level("scheduled/backup/nightly")).toBe("info");
  });

  it("keeps the count of a repeated event and the words of the facts", () => {
    const unhealthy = entries.find((entry) => entry.category === "Event");
    expect(unhealthy).toMatchObject({
      title: "Unhealthy: Pod pg-2",
      detail: "Unhealthy on pg-2",
      count: 12,
      object: { kind: "Pod", name: "pg-2", namespace: "db" },
    });
    expect(entries.find((entry) => entry.id === "primary/current")?.title).toBe("pg-1 became primary");
    expect(entries.find((entry) => entry.id === "primary/lease")?.title).toBe("pg-1 acquired the primary lease");
    expect(entries.find((entry) => entry.id === "condition/ContinuousArchiving")?.detail).toBe(
      "unexpected failure invoking barman-cloud-wal-archive",
    );
    expect(entries.filter((entry) => entry.future).map((entry) => entry.id)).toEqual(["scheduled/backup/nightly"]);
  });

  it("adds the certificates that are going to expire", () => {
    const withCertificates = buildTimeline({
      cluster: cluster("pg", {
        certificates: {
          serverTLSSecret: "pg-server",
          serverCASecret: "pg-ca",
          expirations: { "pg-server": "2026-10-01 10:00:00 +0000 UTC", "pg-ca": "2026-12-17 10:00:00 +0000 UTC" },
        },
      }),
      now: NOW,
    });
    // One entry for the first to expire, not one per certificate.
    expect(withCertificates.filter((entry) => entry.category === "Scheduled")).toHaveLength(1);
    expect(withCertificates[0]).toMatchObject({
      id: "scheduled/certificate",
      category: "Scheduled",
      level: "warning",
      title: "The server TLS certificate expires",
      detail: "The first of 2 certificates to expire; the operator renews its own before then",
      object: { kind: "Secret", name: "pg-server", namespace: "db" },
      future: true,
    });
  });

  it("is stable on a cluster nobody knows anything about", () => {
    const bare = new Cluster({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: "pg", namespace: "db" },
      spec: { instances: 1 },
    } as never);
    expect(buildTimeline({ cluster: bare, now: NOW })).toEqual([]);
  });

  it("filters by category and by what needs attention, and counts the categories", () => {
    expect(
      filterTimeline(entries, { categories: ["Backup"], attention: false }).map((entry) => entry.category),
    ).toEqual(["Backup", "Backup", "Backup", "Backup"]);
    expect(filterTimeline(entries, { categories: [], attention: true }).map((entry) => entry.id)).toEqual([
      "event/pg-2-Unhealthy-2026-09-19T14:30:00Z",
      "condition/ContinuousArchiving",
      "backup/bad/failed",
    ]);
    expect(categoryCounts(entries)).toEqual([
      { category: "Event", count: 1 },
      { category: "Backup", count: 4 },
      { category: "Primary", count: 2 },
      { category: "Condition", count: 3 },
      { category: "Scheduled", count: 1 },
    ]);
  });

  it("groups by day with what is to come on top", () => {
    // Noon local time of the same day, whatever the zone of the machine that runs the test.
    const local = new Date(2026, 8, 19, 12, 0, 0);
    const at = (hoursFromNow: number, future = false) => ({
      id: `e${hoursFromNow}`,
      time: new Date(local.getTime() + hoursFromNow * 3600_000),
      category: "Event" as const,
      level: "info" as const,
      title: "x",
      future,
    });
    const groups = groupTimeline([at(30, true), at(-1), at(-2), at(-24), at(-72)], local);
    expect(groups.map((group) => `${group.label}:${group.entries.length}`)).toEqual([
      "To come:1",
      "Today:2",
      "Yesterday:1",
      "2026-09-16:1",
    ]);
  });
});
