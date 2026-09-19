/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { FailoverQuorum } from "../api/cnpg/failover-quorum-v1";
import { clusterOfQuorum, quorumFacts } from "./failover-quorum";

import type { FailoverQuorumStatus } from "../api/cnpg/failover-quorum-v1";

function quorum(status: FailoverQuorumStatus | undefined, name = "pg", namespace = "db"): FailoverQuorum {
  return new FailoverQuorum({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "FailoverQuorum",
    metadata: { name, namespace },
    status,
  } as never);
}

function cluster(
  healthy: string[],
  { primary = "pg-1", fenced = [] as string[], name = "pg", namespace = "db" } = {},
): Cluster {
  const all = ["pg-1", "pg-2", "pg-3"];
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name,
      namespace,
      annotations: fenced.length > 0 ? { "cnpg.io/fencedInstances": JSON.stringify(fenced) } : {},
    },
    spec: { instances: 3 },
    status: {
      currentPrimary: primary,
      instanceNames: all,
      instancesStatus: { healthy, failed: all.filter((instance) => !healthy.includes(instance)) },
    },
  } as never);
}

// As observed on the E2E cluster (operator 1.30.0): the method in upper case.
const WRITTEN: FailoverQuorumStatus = {
  method: "ANY",
  primary: "pg-1",
  standbyNames: ["pg-2", "pg-3"],
  standbyNumber: 1,
};

describe("quorumFacts", () => {
  it("is Safe when R + W > N", () => {
    expect(quorumFacts(quorum(WRITTEN), cluster(["pg-1", "pg-2", "pg-3"]))).toMatchObject({
      state: "Safe",
      className: "success",
      method: "ANY",
      named: 2,
      mustConfirm: 1,
      healthy: 2,
      writtenBy: "pg-1",
      reason:
        "A failover could be decided safely: 2 of 2 potentially synchronous standbys are healthy and 1 must confirm",
    });
  });

  it("is At risk at the edge: R + W = N", () => {
    // One of two named standbys healthy, one must confirm: 1 + 1 = 2, not greater.
    const facts = quorumFacts(quorum(WRITTEN), cluster(["pg-1", "pg-2"]));
    expect(facts).toMatchObject({ state: "At risk", className: "error", healthy: 1 });
    expect(facts.reason).toBe(
      "The operator would promote nothing: 1 of 2 potentially synchronous standbys are healthy and 1 must confirm",
    );
    expect(facts.standbys).toEqual([
      { name: "pg-2", healthy: true },
      { name: "pg-3", healthy: false },
    ]);
  });

  it("does not count a fenced standby as healthy", () => {
    expect(quorumFacts(quorum(WRITTEN), cluster(["pg-1", "pg-2", "pg-3"], { fenced: ["pg-3"] })).state).toBe("At risk");
  });

  it("is Stale when written by an instance that is no longer the primary", () => {
    expect(quorumFacts(quorum(WRITTEN), cluster(["pg-1", "pg-2", "pg-3"], { primary: "pg-2" }))).toMatchObject({
      state: "Stale",
      className: "warning",
      reason: "Written by pg-1, which is no longer the primary (pg-2 is)",
    });
  });

  it("is Reset without standby names, with or without a status", () => {
    for (const status of [undefined, {}, { method: "ANY", standbyNames: [] }]) {
      expect(quorumFacts(quorum(status), cluster(["pg-1"]))).toMatchObject({
        state: "Reset",
        className: "warning",
        named: 0,
      });
    }
  });

  it("is Orphan without its cluster, and says nothing about health it cannot see", () => {
    const facts = quorumFacts(quorum(WRITTEN), undefined);
    expect(facts).toMatchObject({ state: "Orphan", className: "info", healthy: 0 });
    expect(facts.standbys).toEqual([
      { name: "pg-2", healthy: undefined },
      { name: "pg-3", healthy: undefined },
    ]);
  });
});

describe("clusterOfQuorum", () => {
  it("matches the cluster of the same name and namespace", () => {
    const clusters = [cluster([], { name: "pg", namespace: "elsewhere" }), cluster([], { name: "other" }), cluster([])];
    expect(clusterOfQuorum(quorum(WRITTEN), clusters)).toBe(clusters[2]);
    expect(clusterOfQuorum(quorum(WRITTEN, "missing"), clusters)).toBeUndefined();
  });
});
