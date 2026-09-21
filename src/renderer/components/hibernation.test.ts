/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canHibernate,
  canResumeCluster,
  hibernateFacts,
  hibernationConsequences,
  hibernationPatch,
  hibernationState,
  hibernationWords,
  NOTHING_RELATED,
  resumeClusterFacts,
} from "./hibernation";
import { HEALTHY_PHASE } from "./switchover";

import type { HibernationClusterFacts, HibernationRelated } from "./hibernation";

function cluster(overrides: Partial<HibernationClusterFacts> = {}): HibernationClusterFacts {
  return {
    name: "pg",
    namespace: "db",
    spec: { instances: 2 },
    status: { phase: HEALTHY_PHASE, currentPrimary: "pg-2", readyInstances: 2, instanceNames: ["pg-1", "pg-2"] },
    ...overrides,
  };
}

const RELATED: HibernationRelated = {
  volumes: [{ name: "pg-1", size: "1Gi" }, { name: "pg-2", size: "1Gi" }, { name: "pg-2-wal" }],
  poolers: ["pg-rw"],
  schedules: [
    { name: "nightly", suspended: false },
    { name: "paused", suspended: true },
  ],
  declared: { databases: 2, roles: 1, publications: 0, subscriptions: 1 },
  subscribersElsewhere: ["other/orders-sub"],
};

describe("hibernationState", () => {
  it("is off without the annotation, with off, and with anything that is not on", () => {
    expect(hibernationState(cluster())).toEqual({ kind: "off" });
    expect(hibernationState(cluster({ annotation: "off" }))).toEqual({ kind: "off" });
    expect(hibernationState(cluster({ annotation: "maybe" }))).toEqual({ kind: "off" });
  });

  it("follows the condition while the annotation is on", () => {
    const on = (condition?: HibernationClusterFacts["condition"]) =>
      hibernationState(cluster({ annotation: "on", condition }));

    expect(on()).toEqual({ kind: "requested" });
    expect(on({ status: "False", reason: "WaitingForHealthy" })).toEqual({ kind: "waiting" });
    expect(on({ status: "False", reason: "DeletingPods", message: "Hibernation is in progress" })).toEqual({
      kind: "in progress",
      waitingFor: undefined,
    });
    expect(on({ status: "False", reason: "WaitingPodsDeletion", message: "Waiting for pg-1 to be deleted" })).toEqual({
      kind: "in progress",
      waitingFor: "pg-1",
    });
    expect(on({ status: "True", reason: "Hibernated" })).toEqual({ kind: "hibernated" });
    expect(on({ status: "False", reason: "SomethingNew" })).toEqual({ kind: "requested" });
    expect(hibernationState(cluster({ annotation: " ON ", condition: { status: "True" } }))).toEqual({
      kind: "hibernated",
    });
  });

  it("is resuming while the annotation is off, the condition is gone and instances are missing", () => {
    expect(
      hibernationState(cluster({ annotation: "off", status: { ...cluster().status, readyInstances: 1 } })),
    ).toEqual({ kind: "resuming", ready: 1, declared: 2 });
    // A cluster that never slept and lost an instance is not resuming.
    expect(hibernationState(cluster({ status: { ...cluster().status, readyInstances: 1 } }))).toEqual({ kind: "off" });
  });

  it("has words for every state", () => {
    expect(hibernationWords({ kind: "off" })).toBe("Off");
    expect(hibernationWords({ kind: "requested" })).toContain("has not answered yet");
    expect(hibernationWords({ kind: "waiting" })).toContain("once the cluster is healthy");
    expect(hibernationWords({ kind: "in progress", waitingFor: "pg-1" })).toBe(
      "In progress: waiting for pg-1 to be deleted",
    );
    expect(hibernationWords({ kind: "in progress" })).toContain("the primary first");
    expect(hibernationWords({ kind: "hibernated" })).toBe("Hibernated: no pod runs, every volume is kept");
    expect(hibernationWords({ kind: "resuming", ready: 1, declared: 2 })).toBe("Resuming: 1 of 2 instances ready");
  });
});

describe("the guards", () => {
  it("hibernates a cluster whose annotation is not on, whatever its phase", () => {
    expect(canHibernate(cluster()).enabled).toBe(true);
    expect(canHibernate(cluster({ annotation: "off" })).enabled).toBe(true);
    expect(canHibernate(cluster({ status: { phase: "Upgrading cluster" } })).enabled).toBe(true);
    expect(canHibernate(cluster({ annotation: "on" }))).toEqual({
      enabled: false,
      reason: "The hibernation is requested already",
    });
  });

  it("resumes a cluster whose annotation is on", () => {
    expect(canResumeCluster(cluster({ annotation: "on" })).enabled).toBe(true);
    expect(canResumeCluster(cluster())).toEqual({ enabled: false, reason: "The cluster is not hibernated" });
    expect(canResumeCluster(cluster({ annotation: "off" })).enabled).toBe(false);
  });
});

describe("hibernationConsequences", () => {
  it("lists the pods with the primary first, the volumes with their sizes, and what is attached", () => {
    const lists = hibernationConsequences(cluster(), RELATED);

    expect(lists.map((list) => list.id)).toEqual([
      "pods",
      "volumes",
      "poolers",
      "schedules",
      "declared",
      "subscriptions",
    ]);
    expect(lists[0].lines).toEqual(["pg-2 (primary, first: no switchover happens)", "pg-1"]);
    expect(lists[1].lines).toEqual(["pg-1 (1Gi)", "pg-2 (1Gi)", "pg-2-wal"]);
    expect(lists[2].lines).toEqual(["pg-rw"]);
    // A schedule that is suspended already produces nothing: it is not a consequence.
    expect(lists[3].lines).toEqual(["nightly"]);
    expect(lists[3].scheduleNames).toEqual(["nightly"]);
    expect(lists[4].lines).toEqual(["2 Databases", "1 DatabaseRole", "1 Subscription"]);
    expect(lists[5].lines).toEqual(["other/orders-sub"]);
  });

  it("leaves out every list that is empty", () => {
    expect(hibernationConsequences(cluster(), NOTHING_RELATED).map((list) => list.id)).toEqual(["pods"]);
    expect(hibernationConsequences(cluster({ status: {} }), NOTHING_RELATED)).toEqual([]);
    expect(
      hibernationConsequences(cluster(), { ...NOTHING_RELATED, schedules: [{ name: "paused", suspended: true }] }).map(
        (list) => list.id,
      ),
    ).toEqual(["pods"]);
  });
});

describe("the bodies and the dialogs", () => {
  it("writes the explicit values", () => {
    expect(hibernationPatch("on")).toEqual({ metadata: { annotations: { "cnpg.io/hibernation": "on" } } });
    expect(hibernationPatch("off")).toEqual({ metadata: { annotations: { "cnpg.io/hibernation": "off" } } });
  });

  it("asks for the name before hibernating, and warns when the request will wait", () => {
    const facts = hibernateFacts(cluster());

    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.typedName).toBe("pg");
    expect(facts.writes).toEqual([
      { verb: "patch", text: "patch Cluster db/pg: annotation cnpg.io/hibernation (unset) -> on" },
    ]);
    expect(facts.warnings).toEqual([]);
    expect(hibernateFacts(cluster({ annotation: "off" })).writes[0].text).toContain("off -> on");
    expect(hibernateFacts(cluster({ status: { phase: "Upgrading cluster" } })).warnings).toEqual([
      'The operator starts a hibernation only on a healthy cluster, and this one says "Upgrading cluster": the request is accepted and waits.',
    ]);
  });

  it("resumes with one click and says on which volumes the instances come back", () => {
    const facts = resumeClusterFacts(cluster({ annotation: "on" }), RELATED);

    expect(facts.typedName).toBeUndefined();
    expect(facts.writes[0].text).toBe("patch Cluster db/pg: annotation cnpg.io/hibernation on -> off");
    expect(facts.notes).toEqual([
      "The operator recreates 2 instances on the volumes that were kept (pg-1, pg-2, pg-2-wal), and the cluster comes back with its data.",
    ]);
    expect(resumeClusterFacts(cluster({ annotation: "on", spec: { instances: 1 } }), NOTHING_RELATED).notes).toEqual([
      "The operator recreates 1 instance on the volumes that were kept, and the cluster comes back with its data.",
    ]);
  });
});
