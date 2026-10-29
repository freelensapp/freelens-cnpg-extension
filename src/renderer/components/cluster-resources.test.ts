/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  clusterCounts,
  countFilterMatches,
  jobRows,
  replicaClusterFacts,
  storageRows,
  volumeRoleWords,
} from "./cluster-resources";

import type { JobShape, PvcShape } from "./cluster-resources";

const HEALTHY = "Cluster in healthy state";

function cluster(name: string, overrides: Record<string, unknown> = {}): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace: "db" },
    spec: { instances: 1 },
    status: { phase: HEALTHY, instances: 1, readyInstances: 1, currentPrimary: `${name}-1` },
    ...overrides,
  } as never);
}

/** As read on the kind cluster: e2e-snapshots has a data and a tablespace volume (operator 1.30.1). */
function claim(
  name: string,
  labels: Record<string, string>,
  request: string,
  storageClass = "csi-hostpath-sc",
): PvcShape {
  return {
    metadata: { name, namespace: "db", labels },
    spec: { storageClassName: storageClass, resources: { requests: { storage: request } } },
    status: { phase: "Bound", capacity: { storage: request } },
  };
}

describe("storage table (SPEC-0034)", () => {
  const snapshots = cluster("snap", {
    status: {
      phase: HEALTHY,
      currentPrimary: "snap-1",
      healthyPVC: ["snap-1", "snap-1-tbs-analytics", "snap-1-wal"],
      pvcCount: 3,
    },
  });
  const claims = [
    claim(
      "snap-1-tbs-analytics",
      {
        "cnpg.io/cluster": "snap",
        "cnpg.io/instanceName": "snap-1",
        "cnpg.io/pvcRole": "PG_TABLESPACE",
        "cnpg.io/tablespaceName": "analytics",
      },
      "512Mi",
    ),
    claim(
      "snap-1",
      { "cnpg.io/cluster": "snap", "cnpg.io/instanceName": "snap-1", "cnpg.io/pvcRole": "PG_DATA" },
      "1Gi",
    ),
    // Another cluster's volume in the same namespace is not this one's.
    claim(
      "other-1",
      { "cnpg.io/cluster": "other", "cnpg.io/instanceName": "other-1", "cnpg.io/pvcRole": "PG_DATA" },
      "1Gi",
    ),
  ];

  it("reads the role, the instance and the sizes from the labels and the claim, data first", () => {
    const rows = storageRows(snapshots, claims);
    expect(
      rows.map((row) => [
        row.name,
        row.instance,
        volumeRoleWords(row),
        row.state,
        row.requested,
        row.storageClass,
        row.known,
      ]),
    ).toEqual([
      ["snap-1", "snap-1", "data", "healthy", "1Gi", "csi-hostpath-sc", true],
      // Listed by the operator, not in the store: from its name alone, never dropped.
      ["snap-1-wal", "snap-1", "WAL", "healthy", undefined, undefined, false],
      ["snap-1-tbs-analytics", "snap-1", "tablespace analytics", "healthy", "512Mi", "csi-hostpath-sc", true],
    ]);
  });

  it("takes the state from the lists of the cluster's status, the worst one when a claim is in two", () => {
    const resizing = cluster("snap", {
      status: {
        phase: HEALTHY,
        healthyPVC: ["snap-1"],
        resizingPVC: ["snap-1"],
        danglingPVC: ["snap-2"],
        unusablePVC: [],
      },
    });
    const rows = storageRows(resizing, claims);
    expect(rows.find((row) => row.name === "snap-1")?.state).toBe("resizing");
    expect(rows.find((row) => row.name === "snap-2")).toMatchObject({ state: "dangling", role: "data", known: false });
    expect(rows.find((row) => row.name === "snap-1-tbs-analytics")?.state).toBe("unknown");
  });
});

describe("jobs (SPEC-0034)", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  const join = (overrides: JobShape["status"] = {}): JobShape => ({
    metadata: {
      name: "app-3-join",
      namespace: "db",
      labels: { "cnpg.io/cluster": "app", "cnpg.io/jobRole": "join", "cnpg.io/instanceName": "app-3" },
    },
    status: { active: 1, startTime: "2026-10-29T09:59:20Z", ...overrides },
  });

  it("names the role in words, the instance, the state and the duration so far", () => {
    expect(jobRows(cluster("app"), [join()], now)).toEqual([
      {
        name: "app-3-join",
        role: "join",
        roleWords: "join: clones the primary into a new instance",
        instance: "app-3",
        state: "running",
        message: undefined,
        startedAt: new Date("2026-10-29T09:59:20Z"),
        durationMs: 40_000,
      },
    ]);
  });

  it("reads completion and failure from the conditions, and keeps only the cluster's own jobs", () => {
    const done = join({
      active: 0,
      succeeded: 1,
      completionTime: "2026-10-29T09:59:50Z",
      conditions: [{ type: "Complete", status: "True" }],
    });
    const failed: JobShape = {
      ...join({
        active: 0,
        failed: 1,
        conditions: [{ type: "Failed", status: "True", message: "BackoffLimitExceeded" }],
      }),
      metadata: {
        name: "app-1-initdb",
        namespace: "db",
        labels: { "cnpg.io/cluster": "app", "cnpg.io/jobRole": "initdb" },
      },
    };
    const foreign: JobShape = {
      ...join(),
      metadata: { name: "x", namespace: "db", labels: { "cnpg.io/cluster": "other" } },
    };
    const rows = jobRows(cluster("app"), [done, failed, foreign], now);
    expect(rows.map((row) => [row.name, row.state, row.durationMs, row.message])).toEqual([
      // Started at the same time: by name.
      ["app-1-initdb", "failed", 40_000, "BackoffLimitExceeded"],
      ["app-3-join", "succeeded", 30_000, undefined],
    ]);
  });

  it("says what an unknown role is, rather than nothing", () => {
    const odd: JobShape = { ...join(), metadata: { name: "j", namespace: "db", labels: { "cnpg.io/cluster": "app" } } };
    expect(jobRows(cluster("app"), [odd], now)[0].roleWords).toBe("a job of the operator");
  });
});

describe("replica cluster (SPEC-0034)", () => {
  it("is nothing for a cluster that is not a replica", () => {
    expect(replicaClusterFacts(cluster("app"))).toBeUndefined();
    expect(
      replicaClusterFacts(cluster("app", { spec: { instances: 1, replica: { enabled: false, source: "x" } } })),
    ).toBeUndefined();
  });

  it("reads the source through its external cluster, the designated primary and the tokens", () => {
    const replica = cluster("dr", {
      spec: {
        instances: 2,
        replica: { enabled: true, source: "origin", minApplyDelay: "1h", promotionToken: "abc" },
        externalClusters: [
          {
            name: "origin",
            plugin: {
              name: "barman-cloud.cloudnative-pg.io",
              parameters: { barmanObjectName: "store", serverName: "app" },
            },
          },
        ],
      },
      status: { phase: HEALTHY, currentPrimary: "dr-1", demotionToken: "xyz" },
    });
    expect(replicaClusterFacts(replica)).toEqual({
      source: "origin",
      sourceWords: "object store store (barman-cloud.cloudnative-pg.io)",
      groupPrimary: undefined,
      self: undefined,
      distributed: false,
      designatedPrimary: "dr-1",
      minApplyDelay: "1h",
      promotionToken: "abc",
      demotionToken: "xyz",
    });
  });

  it("follows the distributed topology: a replica when the group's primary is another cluster", () => {
    const member = (primary: string) =>
      cluster("b", {
        spec: {
          instances: 1,
          replica: { primary, self: "b", source: "a" },
          externalClusters: [{ name: "a", connectionParameters: { host: "a-rw" } }],
        },
      });
    expect(replicaClusterFacts(member("a"))).toMatchObject({
      distributed: true,
      groupPrimary: "a",
      sourceWords: "streaming from a-rw",
    });
    expect(replicaClusterFacts(member("b"))).toBeUndefined();
  });
});

describe("counts of the cluster list (SPEC-0034)", () => {
  const hibernated = cluster("sleep", {
    metadata: { name: "sleep", namespace: "db", annotations: { "cnpg.io/hibernation": "on" } },
    status: { phase: HEALTHY, instances: 1, readyInstances: 0 },
  });
  const degraded = cluster("deg", {
    spec: { instances: 3 },
    status: { phase: "Failing over", instances: 3, readyInstances: 2, currentPrimary: "deg-1" },
  });
  const fleet = [cluster("a"), cluster("b"), hibernated, degraded];

  it("counts by the health model, with the instances ready of declared", () => {
    expect(clusterCounts(fleet)).toEqual({
      clusters: 4,
      healthy: 2,
      hibernated: 1,
      attention: 1,
      instancesReady: 4,
      instances: 6,
    });
  });

  it("filters the list as it counts", () => {
    expect(fleet.filter((item) => countFilterMatches(item, "healthy")).map((item) => item.getName())).toEqual([
      "a",
      "b",
    ]);
    expect(fleet.filter((item) => countFilterMatches(item, "hibernated")).map((item) => item.getName())).toEqual([
      "sleep",
    ]);
    expect(fleet.filter((item) => countFilterMatches(item, "attention")).map((item) => item.getName())).toEqual([
      "deg",
    ]);
  });
});
