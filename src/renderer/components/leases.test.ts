/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  holderPod,
  leaseFacts,
  leaseOfCluster,
  leaseTimingWords,
  primaryLeaseHealth,
  primaryLeaseTimings,
} from "./leases";

import type { ClusterSpec } from "../api/cnpg/cluster-v1";
import type { LeaseLike, LeaseSpec } from "../api/core/lease";

const NOW = new Date("2026-09-19T14:10:30Z");

function lease(spec: LeaseSpec, name = "pg", namespace = "db"): LeaseLike {
  return { metadata: { name, namespace, labels: { "cnpg.io/cluster": name } }, spec };
}

function cluster({
  primary = "pg-1" as string | undefined,
  hibernated = false,
  spec = {} as Partial<ClusterSpec>,
} = {}): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "pg", namespace: "db", annotations: hibernated ? { "cnpg.io/hibernation": "on" } : {} },
    spec: { instances: 3, ...spec },
    status: { currentPrimary: primary },
  } as never);
}

// As observed on the E2E cluster (operator 1.30.0): MicroTime with six fractional digits.
const HELD: LeaseSpec = {
  acquireTime: "2026-09-18T16:09:12.562280Z",
  holderIdentity: "pg-1",
  leaseDurationSeconds: 15,
  leaseTransitions: 1,
  renewTime: "2026-09-19T14:10:25.291932Z",
};

describe("leaseFacts", () => {
  it("reads the facts of a lease and whether it is being renewed", () => {
    const facts = leaseFacts(lease(HELD), NOW);
    expect(facts).toMatchObject({ holder: "pg-1", durationSeconds: 15, transitions: 1, current: true });
    expect(facts.acquiredAt?.toISOString()).toBe("2026-09-18T16:09:12.562Z");
    expect(facts.renewedAt?.toISOString()).toBe("2026-09-19T14:10:25.291Z");
  });

  it("calls a lease current up to twice its duration after the last renewal", () => {
    expect(leaseFacts(lease({ ...HELD, renewTime: "2026-09-19T14:10:00Z" }), NOW).current).toBe(true);
    expect(leaseFacts(lease({ ...HELD, renewTime: "2026-09-19T14:09:59Z" }), NOW).current).toBe(false);
    expect(leaseFacts(lease({}), NOW)).toMatchObject({ holder: "", transitions: 0, current: false });
  });

  it("finds the pod behind a leader election identity", () => {
    expect(holderPod("cnpg-controller-manager-9f5cd66db-ph9nt_f5466d82-6f46-4bd8-bb2a-a39efbc40955")).toBe(
      "cnpg-controller-manager-9f5cd66db-ph9nt",
    );
    expect(holderPod("pg-1")).toBe("pg-1");
  });
});

describe("primaryLeaseHealth", () => {
  it("is held when the primary holds and renews it", () => {
    expect(primaryLeaseHealth(lease(HELD), cluster(), NOW)).toMatchObject({
      state: "Held",
      className: "success",
      reason: "Held and renewed by the primary, pg-1",
    });
  });

  // As observed on the hibernated E2E cluster: no holder, a one second duration.
  it("is released without a holder, and says why on a hibernated cluster", () => {
    const released = lease({
      acquireTime: "2026-09-19T10:26:03.885537Z",
      holderIdentity: "",
      leaseDurationSeconds: 1,
      leaseTransitions: 1,
      renewTime: "2026-09-19T10:26:03.885537Z",
    });
    expect(primaryLeaseHealth(released, cluster({ hibernated: true, primary: "pg-1" }), NOW)).toMatchObject({
      state: "Released",
      className: "info",
      reason: "Released: the cluster is hibernated, nobody is primary",
    });
    expect(primaryLeaseHealth(released, cluster(), NOW).reason).toBe(
      "Released: the last primary shut down cleanly, any eligible instance may take it",
    );
  });

  it("is stale when the holder stopped renewing it", () => {
    const stale = primaryLeaseHealth(lease({ ...HELD, renewTime: "2026-09-19T14:08:30Z" }), cluster(), NOW);
    expect(stale).toMatchObject({ state: "Stale", className: "warning" });
    expect(stale.reason).toBe("pg-1 stopped renewing it 2m ago: once it expires another instance may promote");
  });

  it("is a mismatch while the holder is not the primary the cluster reports", () => {
    const moving = primaryLeaseHealth(lease({ ...HELD, holderIdentity: "pg-2" }), cluster(), NOW);
    expect(moving).toMatchObject({ state: "Mismatch", className: "warning" });
    expect(moving.reason).toContain("Held by pg-2 while the cluster reports pg-1 as primary");
    // Without a reported primary there is nothing to disagree with.
    expect(primaryLeaseHealth(lease(HELD), cluster({ primary: undefined }), NOW).state).toBe("Held");
  });

  it("is missing without the object", () => {
    expect(primaryLeaseHealth(undefined, cluster(), NOW)).toMatchObject({ state: "Missing", className: "info" });
  });
});

describe("helpers", () => {
  it("finds the lease of a cluster by name and namespace", () => {
    const own = lease(HELD);
    expect(leaseOfCluster(cluster(), [lease(HELD, "pg", "other"), lease(HELD, "pg2"), own])).toBe(own);
    expect(leaseOfCluster(cluster(), [])).toBeUndefined();
  });

  it("reads the timings in effect and words them", () => {
    expect(primaryLeaseTimings(cluster())).toEqual({
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      releasedLeaseDurationSeconds: 1,
    });
    const tuned = cluster({ spec: { primaryLease: { leaseDurationSeconds: 30 } } });
    expect(primaryLeaseTimings(tuned).leaseDurationSeconds).toBe(30);
    expect(primaryLeaseTimings(tuned).retryPeriodSeconds).toBe(2);
    expect(leaseTimingWords(cluster())).toBe(
      "A primary that dies without releasing it holds a promotion back for up to 15 s; it gives up after 10 s of failed renewals; the others retry every 2 s (the defaults)",
    );
    expect(leaseTimingWords(tuned)).toContain("for up to 30 s");
    expect(leaseTimingWords(tuned)).not.toContain("defaults");
  });
});
