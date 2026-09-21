/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canSwitchover,
  formatBytes,
  HEALTHY_PHASE,
  HIBERNATED_SWITCHOVER_REASON,
  lagWords,
  NO_ELIGIBLE_REASON,
  NO_STANDBY_REASON,
  preselectedCandidate,
  switchoverBlockReason,
  switchoverCandidates,
  switchoverDialogFacts,
  switchoverNotes,
  switchoverWarnings,
  WAITING_FOR_USER_PHASE,
} from "./switchover";
import { REPLICA_CLUSTER_REASON } from "./write-actions";

import type {
  InstancePodFacts,
  PrimaryReplicationFacts,
  SwitchoverCandidate,
  SwitchoverClusterFacts,
} from "./switchover";

function cluster(overrides: Partial<SwitchoverClusterFacts> = {}): SwitchoverClusterFacts {
  return {
    name: "pg",
    namespace: "db",
    resourceVersion: "42",
    hibernated: false,
    fenced: [],
    spec: { instances: 3 },
    status: {
      phase: HEALTHY_PHASE,
      currentPrimary: "pg-1",
      targetPrimary: "pg-1",
      instanceNames: ["pg-1", "pg-2", "pg-3"],
      instancesStatus: { healthy: ["pg-1", "pg-2", "pg-3"] },
    },
    ...overrides,
  };
}

function pod(name: string, overrides: Partial<InstancePodFacts> = {}): InstancePodFacts {
  return {
    name,
    labels: { "cnpg.io/cluster": "pg", "cnpg.io/podRole": "instance" },
    ready: true,
    nodeName: `node-${name.at(-1)}`,
    ...overrides,
  };
}

const PODS = [pod("pg-1"), pod("pg-2"), pod("pg-3")];

const REPLICATION: PrimaryReplicationFacts = {
  currentLsn: "0/5000000",
  rows: [
    { applicationName: "pg-2", state: "streaming", syncState: "async", replayLsn: "0/5000000" },
    { applicationName: "pg-3", state: "streaming", syncState: "async", replayLsn: "0/4000000" },
  ],
};

function candidate(name: string, overrides: Partial<SwitchoverCandidate> = {}): SwitchoverCandidate {
  return { name, eligible: true, ...overrides };
}

describe("switchoverCandidates", () => {
  it("lists every instance but the primary, with its node, state and lag", () => {
    expect(switchoverCandidates(cluster(), PODS, REPLICATION)).toEqual([
      {
        name: "pg-2",
        eligible: true,
        reason: undefined,
        nodeName: "node-2",
        state: "streaming",
        syncState: "async",
        lagBytes: 0n,
      },
      {
        name: "pg-3",
        eligible: true,
        reason: undefined,
        nodeName: "node-3",
        state: "streaming",
        syncState: "async",
        lagBytes: 16n * 1024n * 1024n,
      },
    ]);
  });

  it("keeps an instance that cannot be promoted, with the reason", () => {
    const reasonOf = (facts: SwitchoverClusterFacts, pods: InstancePodFacts[]) =>
      switchoverCandidates(facts, pods, REPLICATION).find((row) => row.name === "pg-2");

    expect(reasonOf(cluster(), [pod("pg-1"), pod("pg-3")])).toMatchObject({
      eligible: false,
      reason: "Its pod does not exist",
    });
    expect(
      reasonOf(cluster(), [pod("pg-2", { labels: { "cnpg.io/cluster": "other", "cnpg.io/podRole": "instance" } })]),
    ).toMatchObject({
      eligible: false,
      reason: "A pod of this name exists, but it is not an instance of this cluster",
    });
    expect(reasonOf(cluster(), [pod("pg-2", { labels: { "cnpg.io/cluster": "pg" } })])?.eligible).toBe(false);
    expect(reasonOf(cluster({ fenced: ["pg-2"] }), PODS)).toMatchObject({ eligible: false, reason: "It is fenced" });
    expect(reasonOf(cluster({ fenced: ["*"] }), PODS)).toMatchObject({ eligible: false, reason: "It is fenced" });
    expect(
      reasonOf(cluster({ status: { ...cluster().status, instancesStatus: { healthy: ["pg-1", "pg-3"] } } }), PODS),
    ).toMatchObject({ eligible: false, reason: "The operator does not report it as healthy" });
    expect(reasonOf(cluster(), [pod("pg-2", { ready: false })])).toMatchObject({
      eligible: false,
      reason: "Its pod is not ready",
    });
  });

  it("never lists the primary itself", () => {
    expect(switchoverCandidates(cluster(), PODS, REPLICATION).map((row) => row.name)).not.toContain("pg-1");
  });

  it("puts a standby that is ahead of the last report at zero, and leaves the lag unknown without a report", () => {
    const ahead = switchoverCandidates(cluster(), PODS, {
      currentLsn: "0/5000000",
      rows: [{ applicationName: "pg-2", replayLsn: "0/5000100" }],
    });

    expect(ahead[0].lagBytes).toBe(0n);
    expect(ahead[1].lagBytes).toBeUndefined();
    expect(ahead[1].state).toBeUndefined();

    const unreadable = switchoverCandidates(cluster(), PODS, undefined);

    expect(unreadable.every((row) => row.eligible && row.lagBytes === undefined)).toBe(true);
    expect(lagWords(unreadable[0], undefined)).toBe("not readable");
    expect(lagWords(ahead[1], REPLICATION)).toBe("not reported");
    expect(lagWords(ahead[0], REPLICATION)).toBe("none");
    expect(lagWords(candidate("pg-3", { lagBytes: 16n * 1024n * 1024n }), REPLICATION)).toBe("16.0 MiB");
  });
});

describe("preselectedCandidate", () => {
  it("proposes a synchronous standby first, then the least lag, an unknown lag last", () => {
    expect(
      preselectedCandidate([
        candidate("pg-2", { syncState: "async", lagBytes: 0n }),
        candidate("pg-3", { syncState: "quorum", lagBytes: 4096n }),
      ]),
    ).toBe("pg-3");
    expect(preselectedCandidate([candidate("pg-2", { lagBytes: 4096n }), candidate("pg-3", { lagBytes: 0n })])).toBe(
      "pg-3",
    );
    expect(preselectedCandidate([candidate("pg-2"), candidate("pg-3", { lagBytes: 4096n })])).toBe("pg-3");
    expect(preselectedCandidate([candidate("pg-3"), candidate("pg-2")])).toBe("pg-2");
  });

  it("never proposes an instance that cannot be promoted", () => {
    expect(
      preselectedCandidate([
        candidate("pg-2", { eligible: false, reason: "It is fenced", syncState: "sync", lagBytes: 0n }),
        candidate("pg-3", { lagBytes: 4096n }),
      ]),
    ).toBe("pg-3");
    expect(preselectedCandidate([candidate("pg-2", { eligible: false, reason: "It is fenced" })])).toBeUndefined();
  });
});

describe("canSwitchover", () => {
  const eligible = [candidate("pg-2")];

  it("is offered on a healthy cluster with a standby, and while a supervised update waits", () => {
    expect(canSwitchover(cluster(), eligible).enabled).toBe(true);
    expect(
      canSwitchover(cluster({ status: { ...cluster().status, phase: WAITING_FOR_USER_PHASE } }), eligible).enabled,
    ).toBe(true);
  });

  it("is refused with a reason everywhere else", () => {
    expect(canSwitchover(cluster({ spec: { instances: 3, replica: { enabled: true } } }), eligible)).toEqual({
      enabled: false,
      reason: REPLICA_CLUSTER_REASON,
    });
    expect(canSwitchover(cluster({ hibernated: true }), eligible)).toEqual({
      enabled: false,
      reason: HIBERNATED_SWITCHOVER_REASON,
    });
    expect(canSwitchover(cluster({ spec: { instances: 1 } }), eligible)).toEqual({
      enabled: false,
      reason: NO_STANDBY_REASON,
    });
    expect(canSwitchover(cluster({ status: { phase: HEALTHY_PHASE } }), eligible).reason).toBe(
      "The cluster reports no primary yet",
    );
    expect(canSwitchover(cluster({ status: { ...cluster().status, targetPrimary: "pg-3" } }), eligible).reason).toBe(
      "A switchover or a failover is already in flight, to pg-3",
    );
    expect(canSwitchover(cluster({ status: { ...cluster().status, phase: "Failing over" } }), eligible).reason).toBe(
      'The cluster is not in a state to be switched over: "Failing over"',
    );
    expect(canSwitchover(cluster(), [candidate("pg-2", { eligible: false, reason: "It is fenced" })])).toEqual({
      enabled: false,
      reason: NO_ELIGIBLE_REASON,
    });
  });

  it("is not refused for the candidates while the pods are still loading", () => {
    expect(canSwitchover(cluster(), undefined).enabled).toBe(true);
  });
});

describe("switchoverBlockReason", () => {
  it("asks for a choice, and refuses a row that is gone or has just become ineligible", () => {
    const rows = [candidate("pg-2"), candidate("pg-3", { eligible: false, reason: "Its pod is not ready" })];

    expect(switchoverBlockReason(rows, undefined)).toBe("Choose the standby to promote");
    expect(switchoverBlockReason(rows, "pg-2")).toBeUndefined();
    expect(switchoverBlockReason(rows, "pg-3")).toBe("pg-3 cannot be promoted: Its pod is not ready");
    expect(switchoverBlockReason(rows, "pg-9")).toBe("pg-9 is not an instance of the cluster anymore");
  });
});

describe("the dialog", () => {
  it("names the cluster, asks for its name and spells the four fields of the one write", () => {
    const facts = switchoverDialogFacts(cluster(), [candidate("pg-2")], "pg-2");

    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.typedName).toBe("pg");
    expect(facts.writes).toEqual([
      {
        verb: "patch",
        text: `patch Cluster db/pg (status): targetPrimary pg-1 -> pg-2, targetPrimaryTimestamp now, phase "${HEALTHY_PHASE}" -> "Switchover in progress", phaseReason "Switching over to pg-2"`,
      },
    ]);
  });

  it("says what happens in order, with the cluster's own switchover delay", () => {
    expect(switchoverNotes(cluster(), "pg-2")).toEqual([
      "In order: the primary pg-1 is shut down first and comes back as a standby, then pg-2 is promoted. The shutdown is a fast one, within the operator's default time limit. Clients of the read-write service are disconnected and reconnect to the new primary.",
    ]);
    expect(switchoverNotes(cluster({ spec: { instances: 3, switchoverDelay: 40 } }), "pg-2")[0]).toContain(
      "after 40 s (.spec.switchoverDelay) it becomes an immediate one.",
    );
  });

  it("says that a supervised rolling update is waiting for this", () => {
    const notes = switchoverNotes(cluster({ status: { ...cluster().status, phase: WAITING_FOR_USER_PHASE } }), "pg-2");

    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("supervised rolling update");
  });

  it("warns on a candidate that is more than one WAL segment behind, and only then", () => {
    const segment = 16n * 1024n * 1024n;

    expect(switchoverWarnings(cluster(), [candidate("pg-2", { lagBytes: segment })], "pg-2")).toEqual([]);
    expect(switchoverWarnings(cluster(), [candidate("pg-2", { lagBytes: segment + 1n })], "pg-2")).toEqual([
      "pg-2 is 16.0 MiB behind: it has that much to replay before it can be promoted, and writes wait for it.",
    ]);
    expect(switchoverWarnings(cluster(), [candidate("pg-2")], "pg-2")).toEqual([]);
  });

  it("warns when required synchronous replication is left without its standbys", () => {
    const synchronous = (dataDurability?: "required" | "preferred", number = 1) =>
      cluster({ spec: { instances: 2, postgresql: { synchronous: { number, dataDurability } } } });

    expect(switchoverWarnings(synchronous("required"), [candidate("pg-2")], "pg-2")).toHaveLength(1);
    expect(switchoverWarnings(synchronous(undefined), [candidate("pg-2")], "pg-2")[0]).toContain(
      "required with 1 standby: while the old primary comes back the cluster has 0",
    );
    expect(switchoverWarnings(synchronous("preferred"), [candidate("pg-2")], "pg-2")).toEqual([]);
    expect(switchoverWarnings(synchronous("required"), [candidate("pg-2"), candidate("pg-3")], "pg-2")).toEqual([]);
    expect(switchoverWarnings(synchronous("required", 2), [candidate("pg-2"), candidate("pg-3")], "pg-2")[0]).toContain(
      "required with 2 standbys",
    );
    expect(switchoverWarnings(cluster(), [candidate("pg-2")], "pg-2")).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("speaks in binary units", () => {
    expect(formatBytes(0n)).toBe("0 B");
    expect(formatBytes(1023n)).toBe("1023 B");
    expect(formatBytes(1024n)).toBe("1.0 KiB");
    expect(formatBytes(150n * 1024n * 1024n)).toBe("150 MiB");
    expect(formatBytes(3n * 1024n * 1024n * 1024n)).toBe("3.0 GiB");
  });
});
