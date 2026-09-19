/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  archivingState,
  backupFacts,
  certificateFacts,
  classifyCluster,
  FAILED_PHASES,
  HEALTHY_PHASE,
  instanceFacts,
  KNOWN_PHASES,
  PROGRESSING_PHASES,
} from "./cluster-health";

import type { BackupSpec, BackupStatus } from "../api/cnpg/backup-v1";
import type { ClusterStatus } from "../api/cnpg/cluster-v1";
import type { KubeCondition } from "../api/types";

const NOW = new Date("2026-09-18T20:00:00Z");

function condition(type: string, status: KubeCondition["status"], reason?: string, message?: string): KubeCondition {
  return { type, status, reason, message };
}

interface ClusterFixture {
  name?: string;
  namespace?: string;
  annotations?: Record<string, string>;
  instances?: number;
  status?: ClusterStatus | null;
}

function makeCluster({
  name = "pg",
  namespace = "db",
  annotations = {},
  instances = 3,
  status,
}: ClusterFixture = {}): Cluster {
  const defaultStatus: ClusterStatus = {
    phase: HEALTHY_PHASE,
    instances,
    readyInstances: instances,
    instanceNames: Array.from({ length: instances }, (_, i) => `${name}-${i + 1}`),
    currentPrimary: `${name}-1`,
    targetPrimary: `${name}-1`,
    conditions: [
      condition("Ready", "True", "ClusterIsReady", "Cluster is Ready"),
      condition("ContinuousArchiving", "True", "ContinuousArchivingSuccess", "Continuous archiving is working"),
      condition("LastBackupSucceeded", "True", "LastBackupSucceeded", "Backup was successful"),
    ],
  };
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace, annotations, creationTimestamp: "2026-09-18T10:00:00Z" },
    spec: { instances },
    status: status === null ? undefined : { ...defaultStatus, ...status },
  } as never);
}

function makeBackup(
  name: string,
  cluster: string,
  status: BackupStatus,
  { namespace = "db", spec = {} }: { namespace?: string; spec?: Partial<BackupSpec> } = {},
): Backup {
  return new Backup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace, creationTimestamp: "2026-09-18T09:00:00Z" },
    spec: { cluster: { name: cluster }, method: "plugin", ...spec },
    status,
  } as never);
}

describe("classifyCluster", () => {
  it("is Healthy when the phase is healthy, Ready is True and every instance is ready", () => {
    const result = classifyCluster(makeCluster());
    expect(result).toMatchObject({ state: "Healthy", label: "Healthy", className: "success", token: "--colorOk" });
    expect(result.reason).toBe(HEALTHY_PHASE);
  });

  it("is Hibernated when the hibernation annotation is on, whatever the phase says", () => {
    const cluster = makeCluster({
      annotations: { "cnpg.io/hibernation": "on" },
      status: { readyInstances: undefined },
    });
    expect(classifyCluster(cluster)).toMatchObject({
      state: "Hibernated",
      className: "info",
      token: "--colorTerminated",
    });
    expect(classifyCluster(makeCluster({ annotations: { "cnpg.io/hibernation": "off" } })).state).toBe("Healthy");
  });

  it("is Unknown without a status or without a phase", () => {
    expect(classifyCluster(makeCluster({ status: null }))).toMatchObject({
      state: "Unknown",
      reason: "No status reported yet",
    });
    expect(classifyCluster(makeCluster({ status: { phase: "" } })).state).toBe("Unknown");
  });

  it("is Unknown for a phase string it does not know, never a guess", () => {
    const result = classifyCluster(makeCluster({ status: { phase: "Doing something new" } }));
    expect(result.state).toBe("Unknown");
    expect(result.reason).toBe('Unknown phase "Doing something new"');
  });

  it.each(PROGRESSING_PHASES)("is Progressing for the phase %s", (phase) => {
    const result = classifyCluster(makeCluster({ status: { phase, readyInstances: 1 } }));
    expect(result).toMatchObject({ state: "Progressing", className: "info" });
    expect(result.reason).toBe(phase);
  });

  it.each(FAILED_PHASES)("is Failed for the phase %s", (phase) => {
    const result = classifyCluster(makeCluster({ status: { phase, phaseReason: "details" } }));
    expect(result).toMatchObject({ state: "Failed", className: "error", token: "--colorError" });
    expect(result.reason).toBe(`${phase}: details`);
  });

  it("knows all 22 phase strings of CloudNativePG 1.30.0", () => {
    expect(KNOWN_PHASES).toHaveLength(22);
    expect(new Set(KNOWN_PHASES).size).toBe(22);
  });

  it("is Failed when Ready is False outside a progressing phase, with the condition message", () => {
    const cluster = makeCluster({
      status: {
        conditions: [condition("Ready", "False", "ClusterIsNotReady", "Cluster Is Not Ready")],
      },
    });
    expect(classifyCluster(cluster)).toMatchObject({ state: "Failed", reason: "Cluster Is Not Ready" });
  });

  it("stays Progressing when Ready is False during a progressing phase", () => {
    const cluster = makeCluster({
      status: {
        phase: "Failing over",
        readyInstances: 2,
        conditions: [condition("Ready", "False", "ClusterIsNotReady")],
      },
    });
    expect(classifyCluster(cluster).state).toBe("Progressing");
  });

  it("is Degraded when fewer instances are ready than declared", () => {
    const result = classifyCluster(makeCluster({ status: { readyInstances: 2 } }));
    expect(result).toMatchObject({ state: "Degraded", className: "warning", reason: "2 of 3 instances ready" });
  });

  it("treats an omitted readyInstances as zero", () => {
    const result = classifyCluster(makeCluster({ instances: 1, status: { readyInstances: undefined } }));
    expect(result).toMatchObject({ state: "Degraded", reason: "0 of 1 instances ready" });
  });

  it("is Degraded when WAL archiving is failing, with the condition message", () => {
    const cluster = makeCluster({
      status: {
        conditions: [
          condition("Ready", "True", "ClusterIsReady"),
          condition(
            "ContinuousArchiving",
            "False",
            "ContinuousArchivingFailing",
            "unexpected failure invoking barman-cloud-wal-archive",
          ),
        ],
      },
    });
    expect(classifyCluster(cluster)).toMatchObject({
      state: "Degraded",
      reason: "unexpected failure invoking barman-cloud-wal-archive",
    });
  });

  it("is Degraded when the last backup failed, falling back to the reason when there is no message", () => {
    const cluster = makeCluster({
      status: {
        conditions: [condition("Ready", "True"), condition("LastBackupSucceeded", "False", "LastBackupFailed")],
      },
    });
    expect(classifyCluster(cluster)).toMatchObject({ state: "Degraded", reason: "LastBackupFailed" });
  });

  it("is Degraded when an instance is fenced, even with a healthy phase and Ready True", () => {
    // Observed on the E2E cluster: fencing keeps the phase and Ready untouched.
    const cluster = makeCluster({
      instances: 1,
      annotations: { "cnpg.io/fencedInstances": '["pg-1"]' },
      status: { readyInstances: undefined, instancesStatus: { replicating: ["pg-1"] } },
    });
    expect(classifyCluster(cluster)).toMatchObject({
      state: "Degraded",
      reason: "Fenced instances: pg-1; 0 of 1 instances ready",
    });
  });

  it("expands the fencing wildcard to every instance", () => {
    const cluster = makeCluster({ annotations: { "cnpg.io/fencedInstances": '["*"]' } });
    expect(classifyCluster(cluster).reason).toBe("Fenced instances: pg-1, pg-2, pg-3");
  });

  it("ignores a malformed fencing annotation", () => {
    expect(classifyCluster(makeCluster({ annotations: { "cnpg.io/fencedInstances": "not json" } })).state).toBe(
      "Healthy",
    );
    expect(classifyCluster(makeCluster({ annotations: { "cnpg.io/fencedInstances": '{"a":1}' } })).state).toBe(
      "Healthy",
    );
  });

  it("is Degraded, not Progressing, when the cluster waits for a human", () => {
    const result = classifyCluster(
      makeCluster({ status: { phase: "Waiting for user action", phaseReason: "Switchover requires approval" } }),
    );
    expect(result).toMatchObject({
      state: "Degraded",
      reason: "Waiting for user action: Switchover requires approval",
    });
  });

  it("joins several degradation reasons in a stable order", () => {
    const cluster = makeCluster({
      status: {
        readyInstances: 2,
        conditions: [
          condition("Ready", "True"),
          condition("ContinuousArchiving", "False", "ContinuousArchivingFailing", "archive failing"),
          condition("LastBackupSucceeded", "False", "LastBackupFailed", "backup failed"),
        ],
      },
    });
    expect(classifyCluster(cluster).reason).toBe("2 of 3 instances ready; archive failing; backup failed");
  });
});

describe("archivingState", () => {
  it("maps the ContinuousArchiving condition", () => {
    expect(archivingState(makeCluster())).toMatchObject({ state: "Archiving", reason: "ContinuousArchivingSuccess" });
    const failing = makeCluster({
      status: { conditions: [condition("ContinuousArchiving", "False", "ContinuousArchivingFailing", "boom")] },
    });
    expect(archivingState(failing)).toEqual({
      state: "Failing",
      message: "boom",
      reason: "ContinuousArchivingFailing",
    });
    expect(archivingState(makeCluster({ status: { conditions: [] } }))).toEqual({
      state: "Unknown",
      message: undefined,
      reason: undefined,
    });
    expect(archivingState(makeCluster({ status: null })).state).toBe("Unknown");
  });
});

describe("backupFacts", () => {
  it("derives the facts from the Backup objects of the cluster only", () => {
    const cluster = makeCluster();
    const backups = [
      makeBackup("b1", "pg", { phase: "completed", stoppedAt: "2026-09-16T01:00:00Z" }),
      makeBackup("b2", "pg", { phase: "completed", stoppedAt: "2026-09-18T01:00:00Z" }),
      makeBackup("b3", "pg", { phase: "failed", startedAt: "2026-09-17T01:00:00Z", error: "exit status 1" }),
      makeBackup("b4", "pg", { phase: "running" }),
      makeBackup("other", "other-cluster", { phase: "completed", stoppedAt: "2026-09-18T12:00:00Z" }),
      makeBackup(
        "other-ns",
        "pg",
        { phase: "completed", stoppedAt: "2026-09-18T12:00:00Z" },
        { namespace: "elsewhere" },
      ),
    ];
    const facts = backupFacts(cluster, backups);
    expect(facts.source).toBe("backups");
    expect(facts.count).toBe(4);
    expect(facts.lastSuccessful?.toISOString()).toBe("2026-09-18T01:00:00.000Z");
    expect(facts.lastFailed?.toISOString()).toBe("2026-09-17T01:00:00.000Z");
    expect(facts.firstRecoverabilityPoint?.toISOString()).toBe("2026-09-16T01:00:00.000Z");
  });

  it("uses the creation time of a failed backup that never started", () => {
    const facts = backupFacts(makeCluster(), [makeBackup("b", "pg", { phase: "failed", error: "invalid" })]);
    expect(facts.lastFailed?.toISOString()).toBe("2026-09-18T09:00:00.000Z");
    expect(facts.lastSuccessful).toBeUndefined();
  });

  it("falls back to the deprecated status fields only when the cluster has no Backup object", () => {
    const cluster = makeCluster({
      status: {
        lastSuccessfulBackup: "2026-09-15T01:00:00Z",
        lastFailedBackup: "2026-09-14T01:00:00Z",
        firstRecoverabilityPoint: "2026-09-10T01:00:00Z",
      },
    });
    const fallback = backupFacts(cluster, []);
    expect(fallback.source).toBe("status");
    expect(fallback.lastSuccessful?.toISOString()).toBe("2026-09-15T01:00:00.000Z");
    expect(fallback.lastFailed?.toISOString()).toBe("2026-09-14T01:00:00.000Z");
    expect(fallback.firstRecoverabilityPoint?.toISOString()).toBe("2026-09-10T01:00:00.000Z");

    const fromBackups = backupFacts(cluster, [makeBackup("b", "pg", { phase: "failed" })]);
    expect(fromBackups.source).toBe("backups");
    expect(fromBackups.lastSuccessful).toBeUndefined();
  });

  it("reports no source when neither Backup objects nor status fields exist", () => {
    expect(backupFacts(makeCluster(), [])).toEqual({
      lastSuccessful: undefined,
      lastFailed: undefined,
      firstRecoverabilityPoint: undefined,
      source: "none",
      count: 0,
    });
  });
});

describe("certificateFacts", () => {
  const certificates = {
    serverCASecret: "pg-ca",
    serverTLSSecret: "pg-server",
    clientCASecret: "pg-ca",
    replicationTLSSecret: "pg-replication",
    expirations: {
      "pg-ca": "2026-12-17 16:03:14 +0000 UTC",
      "pg-server": "2026-10-01 00:00:00 +0000 UTC",
      "pg-replication": "2026-09-01 00:00:00 +0000 UTC",
    },
  };

  it("maps every role to its secret and classifies the expiry against now", () => {
    const facts = certificateFacts(makeCluster({ status: { certificates } }), NOW);
    expect(facts.map((fact) => [fact.role, fact.secretName, fact.state])).toEqual([
      ["server CA", "pg-ca", "ok"],
      ["server TLS", "pg-server", "expiring"],
      ["client CA", "pg-ca", "ok"],
      ["replication TLS", "pg-replication", "expired"],
    ]);
    expect(facts[0].expiresAt?.toISOString()).toBe("2026-12-17T16:03:14.000Z");
  });

  it("is unknown for a missing secret or an unparseable expiry", () => {
    const facts = certificateFacts(
      makeCluster({
        status: { certificates: { serverCASecret: "pg-ca", expirations: { "pg-ca": "soon" } } },
      }),
      NOW,
    );
    expect(facts.map((fact) => [fact.role, fact.secretName, fact.state, fact.expiresAt])).toEqual([
      ["server CA", "pg-ca", "unknown", undefined],
      ["server TLS", undefined, "unknown", undefined],
      ["client CA", undefined, "unknown", undefined],
      ["replication TLS", undefined, "unknown", undefined],
    ]);
    expect(certificateFacts(makeCluster({ status: null }), NOW)).toHaveLength(4);
  });

  it("treats the exact 30 day boundary as expiring and the exact expiry as expired", () => {
    const boundary = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000 - 1000);
    const facts = certificateFacts(
      makeCluster({
        status: {
          certificates: {
            serverCASecret: "a",
            serverTLSSecret: "b",
            expirations: { a: boundary.toISOString(), b: NOW.toISOString() },
          },
        },
      }),
      NOW,
    );
    expect(facts[0].state).toBe("expiring");
    expect(facts[1].state).toBe("expired");
  });
});

describe("instanceFacts", () => {
  it("combines names, reported state, health groups and fencing", () => {
    const cluster = makeCluster({
      annotations: { "cnpg.io/fencedInstances": '["pg-3"]' },
      status: {
        instancesStatus: { healthy: ["pg-1", "pg-2"], failed: ["pg-3"] },
        instancesReportedState: {
          "pg-1": { isPrimary: true, timeLineID: 2, ip: "10.0.0.1" },
          "pg-2": { isPrimary: false, timeLineID: 2, ip: "10.0.0.2" },
        },
      },
    });
    expect(instanceFacts(cluster)).toEqual([
      { name: "pg-1", role: "primary", health: "healthy", fenced: false, node: undefined, ip: "10.0.0.1", timeline: 2 },
      { name: "pg-2", role: "replica", health: "healthy", fenced: false, node: undefined, ip: "10.0.0.2", timeline: 2 },
      {
        name: "pg-3",
        role: "replica",
        health: "failed",
        fenced: true,
        node: undefined,
        ip: undefined,
        timeline: undefined,
      },
    ]);
  });

  it("marks the current primary even without a reported state", () => {
    const cluster = makeCluster({ instances: 1, status: { instancesStatus: { replicating: ["pg-1"] } } });
    expect(instanceFacts(cluster)).toEqual([
      {
        name: "pg-1",
        role: "primary",
        health: "replicating",
        fenced: false,
        node: undefined,
        ip: undefined,
        timeline: undefined,
      },
    ]);
  });

  it("falls back to the reported state keys and to unknown roles and health", () => {
    const cluster = makeCluster({
      status: {
        instanceNames: undefined,
        currentPrimary: undefined,
        instancesStatus: undefined,
        instancesReportedState: { "pg-9": { ip: "10.0.0.9" } },
      },
    });
    expect(instanceFacts(cluster)).toEqual([
      {
        name: "pg-9",
        role: "replica",
        health: "unknown",
        fenced: false,
        node: undefined,
        ip: "10.0.0.9",
        timeline: undefined,
      },
    ]);
    expect(instanceFacts(makeCluster({ status: null }))).toEqual([]);
  });
});
