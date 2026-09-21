/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canReload,
  canRestartCluster,
  canRestartInstance,
  FENCED_INSTANCE_REASON,
  HIBERNATED_RELOAD_REASON,
  HIBERNATED_RESTART_REASON,
  instanceRestartKind,
  isInstancePodOf,
  RELOADED_AT_ANNOTATION,
  RESTARTED_AT_ANNOTATION,
  reloadAnnotationPatch,
  reloadFacts,
  restartAnnotationPatch,
  restartClusterFacts,
  restartPlan,
  restartPrimaryFacts,
  restartStandbyFacts,
  UPGRADING_PHASE,
} from "./restart-reload";
import { HEALTHY_PHASE } from "./switchover";

import type { RestartClusterFacts } from "./restart-reload";
import type { InstancePodFacts } from "./switchover";

const NOW = new Date("2026-09-21T20:45:12.345Z");

function cluster(overrides: Partial<RestartClusterFacts> = {}): RestartClusterFacts {
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
  return { name, labels: { "cnpg.io/cluster": "pg", "cnpg.io/podRole": "instance" }, ready: true, ...overrides };
}

const PODS = [pod("pg-1"), pod("pg-2"), pod("pg-3")];

describe("the guards of the cluster", () => {
  it("offers restart and reload on a running cluster", () => {
    expect(canRestartCluster(cluster()).enabled).toBe(true);
    expect(canReload(cluster()).enabled).toBe(true);
    // A rollout that is already running does not refuse a restart: the dialog warns.
    expect(canRestartCluster(cluster({ status: { ...cluster().status, phase: UPGRADING_PHASE } })).enabled).toBe(true);
  });

  it("refuses both on a hibernated cluster, and a restart while the primary is moving", () => {
    expect(canRestartCluster(cluster({ hibernated: true }))).toEqual({
      enabled: false,
      reason: HIBERNATED_RESTART_REASON,
    });
    expect(canReload(cluster({ hibernated: true }))).toEqual({ enabled: false, reason: HIBERNATED_RELOAD_REASON });
    expect(canRestartCluster(cluster({ status: { ...cluster().status, targetPrimary: "pg-2" } })).reason).toBe(
      "A switchover or a failover is in flight, to pg-2",
    );
    expect(canReload(cluster({ status: { ...cluster().status, targetPrimary: "pg-2" } })).enabled).toBe(true);
  });
});

describe("restartPlan", () => {
  const kinds = (facts: RestartClusterFacts) => restartPlan(facts).map((step) => `${step.instance}:${step.kind}`);

  it("takes the standbys first, then the primary without a switchover by default", () => {
    const plan = restartPlan(cluster());

    expect(kinds(cluster())).toEqual(["pg-2:standby", "pg-3:standby", "pg-1:primary"]);
    expect(plan[0].text).toBe("pg-2 (standby): its pod is deleted and recreated on its volumes");
    expect(plan[2].text).toContain("without a switchover (primaryUpdateMethod: restart)");
    expect(plan[2].text).toContain("Writes are down until it is back");
  });

  it("says that the operator switches over when the cluster asks for it", () => {
    const plan = restartPlan(cluster({ spec: { instances: 3, primaryUpdateMethod: "switchover" } }));

    expect(plan[2].text).toContain("switches over to a standby of its choice");
    expect(plan[2].text).toContain("(primaryUpdateMethod: switchover)");
  });

  it("says that a supervised cluster stops and waits for a switchover, whatever the method", () => {
    const plan = restartPlan(
      cluster({ spec: { instances: 3, primaryUpdateStrategy: "supervised", primaryUpdateMethod: "switchover" } }),
    );

    expect(plan[2].text).toContain('stops at "Waiting for user action" (primaryUpdateStrategy: supervised)');
    expect(plan[2].text).toContain("when you request a switchover");
  });

  it("says the outage of a single instance, whatever the method", () => {
    const single = cluster({
      spec: { instances: 1, primaryUpdateMethod: "switchover" },
      status: { ...cluster().status, instanceNames: ["pg-1"] },
    });

    expect(restartPlan(single)).toEqual([
      {
        instance: "pg-1",
        kind: "primary",
        text: "pg-1 (the only instance): its pod is deleted and recreated on its volumes. The database is down until it is back",
      },
    ]);
  });

  it("marks the fenced instances as skipped, the primary included", () => {
    expect(kinds(cluster({ fenced: ["pg-3"] }))).toEqual(["pg-2:standby", "pg-3:skipped", "pg-1:primary"]);
    expect(restartPlan(cluster({ fenced: ["pg-3"] }))[1].text).toBe("pg-3: skipped while it is fenced");
    expect(kinds(cluster({ fenced: ["pg-1"] }))).toEqual(["pg-2:standby", "pg-3:standby", "pg-1:skipped"]);
    expect(kinds(cluster({ fenced: ["*"] }))).toEqual(["pg-2:skipped", "pg-3:skipped", "pg-1:skipped"]);
  });

  it("lists the standbys only while the cluster reports no primary", () => {
    expect(kinds(cluster({ status: { instanceNames: ["pg-1", "pg-2"] } }))).toEqual(["pg-1:standby", "pg-2:standby"]);
  });
});

describe("the bodies", () => {
  it("writes the restart annotation to the second, in UTC", () => {
    expect(restartAnnotationPatch(NOW)).toEqual({
      metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: "2026-09-21T20:45:12Z" } },
    });
  });

  it("writes the reload annotation with six fractional digits, in UTC", () => {
    expect(reloadAnnotationPatch(NOW)).toEqual({
      metadata: { annotations: { [RELOADED_AT_ANNOTATION]: "2026-09-21T20:45:12.345000Z" } },
    });
  });
});

describe("the dialogs of the cluster", () => {
  it("asks for the name before a restart and warns while a rollout is running", () => {
    const facts = restartClusterFacts(cluster());

    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.typedName).toBe("pg");
    expect(facts.writes).toEqual([
      {
        verb: "patch",
        text: "patch Cluster db/pg: annotation kubectl.kubernetes.io/restartedAt = now (RFC 3339, to the second)",
      },
    ]);
    expect(facts.warnings).toEqual([]);

    const running = restartClusterFacts(cluster({ status: { ...cluster().status, phase: UPGRADING_PHASE } }));

    expect(running.warnings).toEqual([
      'A rollout is already running ("Upgrading cluster"): the new value restarts again the instances that were already done.',
    ]);
  });

  it("confirms a reload with one click and says that nothing reports its completion", () => {
    const facts = reloadFacts(cluster());

    expect(facts.typedName).toBeUndefined();
    expect(facts.writes[0].text).toBe(
      "patch Cluster db/pg: annotation cnpg.io/reloadedAt = now (RFC 3339, six fractional digits)",
    );
    expect(facts.notes[1]).toBe(
      "Nothing reports the completion of a reload: there is no phase, condition or event to wait for.",
    );
    expect(facts.notes[2]).toContain("cnpg.io/reload");
  });
});

describe("the restart of one instance", () => {
  it("knows the primary from a standby", () => {
    expect(instanceRestartKind(cluster(), "pg-1")).toBe("primary");
    expect(instanceRestartKind(cluster(), "pg-2")).toBe("standby");
  });

  it("restarts a standby whose pod is an instance of this cluster, and no other pod", () => {
    expect(canRestartInstance(cluster(), "pg-2", PODS).enabled).toBe(true);
    expect(canRestartInstance(cluster(), "pg-2", [pod("pg-1")]).reason).toBe("Its pod does not exist");
    expect(
      canRestartInstance(cluster(), "pg-2", [pod("pg-2", { labels: { "cnpg.io/cluster": "other" } })]).reason,
    ).toBe("A pod of this name exists, but it is not an instance of this cluster");
    expect(isInstancePodOf(cluster(), pod("pg-2"))).toBe(true);
    expect(isInstancePodOf(cluster(), pod("pg-2", { labels: { "cnpg.io/cluster": "pg" } }))).toBe(false);
    expect(isInstancePodOf(cluster(), undefined)).toBe(false);
    // While the pods are loading the guard does not refuse: the delete checks the labels again.
    expect(canRestartInstance(cluster(), "pg-2", undefined).enabled).toBe(true);
  });

  it("restarts the primary in place only on a healthy cluster whose primary is not moving", () => {
    expect(canRestartInstance(cluster(), "pg-1", PODS).enabled).toBe(true);
    expect(
      canRestartInstance(cluster({ status: { ...cluster().status, phase: UPGRADING_PHASE } }), "pg-1", PODS).reason,
    ).toBe('The primary is restarted in place only on a healthy cluster: "Upgrading cluster"');
    expect(
      canRestartInstance(cluster({ status: { ...cluster().status, targetPrimary: "pg-2" } }), "pg-1", PODS).reason,
    ).toBe("A switchover or a failover is in flight, to pg-2");
  });

  it("refuses a fenced instance and a hibernated cluster", () => {
    expect(canRestartInstance(cluster({ fenced: ["pg-2"] }), "pg-2", PODS)).toEqual({
      enabled: false,
      reason: FENCED_INSTANCE_REASON,
    });
    expect(canRestartInstance(cluster({ fenced: ["*"] }), "pg-1", PODS).reason).toBe(FENCED_INSTANCE_REASON);
    expect(canRestartInstance(cluster({ hibernated: true }), "pg-2", PODS).reason).toBe(HIBERNATED_RESTART_REASON);
  });

  it("deletes the pod of a standby with one click, and says what the operator does", () => {
    const facts = restartStandbyFacts(cluster(), "pg-2", PODS);

    expect(facts.writes).toEqual([{ verb: "delete", text: "delete Pod db/pg-2" }]);
    expect(facts.typedName).toBeUndefined();
    expect(facts.notes[0]).toBe(
      "pg-2 is a standby: the operator recreates its pod on the same volumes, and it catches up from the primary pg-1.",
    );
    expect(facts.warnings).toEqual([]);
  });

  it("warns when required synchronous replication needs this standby", () => {
    const synchronous = (dataDurability?: "required" | "preferred", number = 1) =>
      cluster({ spec: { instances: 3, postgresql: { synchronous: { number, dataDurability } } } });

    expect(restartStandbyFacts(synchronous("required"), "pg-2", PODS).warnings).toEqual([]);
    expect(restartStandbyFacts(synchronous("required", 2), "pg-2", PODS).warnings).toEqual([
      "Synchronous replication is required with 2 standbys: without pg-2 the cluster has 1, and writes wait until it is back.",
    ]);
    expect(restartStandbyFacts(synchronous(undefined, 2), "pg-2", PODS).warnings).toHaveLength(1);
    expect(restartStandbyFacts(synchronous("preferred", 2), "pg-2", PODS).warnings).toEqual([]);
    expect(
      restartStandbyFacts(synchronous("required"), "pg-2", [pod("pg-1"), pod("pg-2"), pod("pg-3", { ready: false })])
        .warnings,
    ).toHaveLength(1);
  });

  it("asks for the name before the primary is restarted in place, and spells the status write", () => {
    const facts = restartPrimaryFacts(cluster(), "pg-1");

    expect(facts.typedName).toBe("pg");
    expect(facts.writes).toEqual([
      {
        verb: "patch",
        text: `patch Cluster db/pg (status): phase "${HEALTHY_PHASE}" -> "Primary instance is being restarted in-place", phaseReason "Requested by the user"`,
      },
    ]);
    expect(facts.notes[0]).toContain("The pod is not deleted and no switchover happens");
  });
});
