/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { canDestroyInstance, destroyFacts, destroyPlan, instanceClaims } from "./destroy-instance";

import type { DestroyClaim, OwnerReference } from "./destroy-instance";

const OWNER: OwnerReference = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  name: "e2e-actions",
  uid: "u1",
  controller: true,
};
const CLUSTER = {
  name: "e2e-actions",
  namespace: "cnpg-e2e-actions",
  status: {
    currentPrimary: "e2e-actions-1",
    targetPrimary: "e2e-actions-1",
    instanceNames: ["e2e-actions-1", "e2e-actions-2"],
  },
};

function claim(
  name: string,
  role: string,
  instance = "e2e-actions-2",
  extra: Partial<DestroyClaim> = {},
): DestroyClaim {
  return {
    name,
    labels: { "cnpg.io/instanceName": instance, "cnpg.io/pvcRole": role, "cnpg.io/cluster": "e2e-actions" },
    annotations: { "cnpg.io/pvcStatus": "ready" },
    ownerReferences: [OWNER],
    size: "1Gi",
    ...extra,
  };
}

const CLAIMS = [
  claim("e2e-actions-2", "PG_DATA"),
  claim("e2e-actions-2-wal", "PG_WAL"),
  claim("e2e-actions-1", "PG_DATA", "e2e-actions-1"),
  claim("e2e-actions-2-other", "SOMETHING_ELSE"),
];
const POD = { name: "e2e-actions-2", ownerReferences: [OWNER] };

describe("destroy an instance (SPEC-0037)", () => {
  it("offers it on a replica only, never during a switchover or a backup on that instance", () => {
    expect(canDestroyInstance(CLUSTER, "e2e-actions-2").enabled).toBe(true);
    expect(canDestroyInstance(CLUSTER, "e2e-actions-1").reason).toBe(
      "e2e-actions-1 is the primary: destroying the primary is not offered, switch over first",
    );
    expect(canDestroyInstance(CLUSTER, "e2e-actions-9").reason).toBe("e2e-actions-9 is not an instance of e2e-actions");
    const switching = { ...CLUSTER, status: { ...CLUSTER.status, targetPrimary: "e2e-actions-2" } };
    expect(canDestroyInstance(switching, "e2e-actions-2").reason).toBe("e2e-actions-2 is about to become the primary");
    const elsewhere = {
      ...CLUSTER,
      status: {
        ...CLUSTER.status,
        instanceNames: ["e2e-actions-1", "e2e-actions-2", "e2e-actions-3"],
        targetPrimary: "e2e-actions-3",
      },
    };
    expect(canDestroyInstance(elsewhere, "e2e-actions-2").reason).toBe("A switchover or a failover is in flight");
    expect(canDestroyInstance(CLUSTER, "e2e-actions-2", [{ name: "b1", instance: "e2e-actions-2" }]).reason).toBe(
      "The backup b1 is running on e2e-actions-2",
    );
    expect(canDestroyInstance(CLUSTER, "e2e-actions-2", [{ name: "b1", instance: "e2e-actions-1" }]).enabled).toBe(
      true,
    );
  });

  it("finds the volumes of the instance by its label and a known role", () => {
    expect(instanceClaims(CLAIMS, "e2e-actions-2").map((item) => item.name)).toEqual([
      "e2e-actions-2",
      "e2e-actions-2-wal",
    ]);
  });

  it("deletes the volumes, then the pod, then the jobs, and asks for the instance name", () => {
    const plan = destroyPlan("e2e-actions", "e2e-actions-2", CLAIMS, POD, ["e2e-actions-2-join"]);
    const facts = destroyFacts(CLUSTER, "e2e-actions-2", plan);
    expect(facts.writes).toEqual([
      { verb: "delete", text: "delete PersistentVolumeClaim cnpg-e2e-actions/e2e-actions-2 (PG_DATA, 1Gi)" },
      { verb: "delete", text: "delete PersistentVolumeClaim cnpg-e2e-actions/e2e-actions-2-wal (PG_WAL, 1Gi)" },
      { verb: "delete", text: "delete Pod cnpg-e2e-actions/e2e-actions-2" },
      { verb: "delete", text: "delete Job cnpg-e2e-actions/e2e-actions-2-join" },
    ]);
    expect(facts.typedName).toBe("e2e-actions-2");
    expect(facts.warnings[0]).toContain("The data on these volumes is lost");
    expect(facts.notes[1]).toContain(
      "under the first free name (e2e-actions-2 itself when it is free), as a full copy of the primary e2e-actions-1",
    );
  });

  it("never touches a volume of the instance the cluster does not own, unless detached from it", () => {
    const foreign = claim("e2e-actions-2-tbs-x", "PG_TABLESPACE", "e2e-actions-2", { ownerReferences: [] });
    expect(
      destroyPlan("e2e-actions", "e2e-actions-2", [...CLAIMS, foreign], POD, []).claims.map((item) => item.name),
    ).toEqual(["e2e-actions-2", "e2e-actions-2-wal"]);
  });

  it("deletes a volume detached from this instance earlier, and refuses a pod the cluster does not own", () => {
    const detached = claim("e2e-actions-2", "PG_DATA", "e2e-actions-2", {
      ownerReferences: [],
      annotations: { "cnpg.io/pvcStatus": "detached" },
    });
    expect(destroyPlan("e2e-actions", "e2e-actions-2", [detached], undefined, []).claims).toEqual([
      { name: "e2e-actions-2", size: "1Gi", role: "PG_DATA" },
    ]);
    const stray = destroyPlan("e2e-actions", "e2e-actions-2", [], { name: "e2e-actions-2", ownerReferences: [] }, []);
    expect(stray.podRefusal).toBe("The pod e2e-actions-2 is not owned by e2e-actions");
    const gone = destroyFacts(CLUSTER, "e2e-actions-2", destroyPlan("e2e-actions", "e2e-actions-2", [], undefined, []));
    expect(gone.notes).toContain("The pod e2e-actions-2 is gone already: only its volumes and jobs are left.");
    expect(gone.warnings).toContain("No volume of e2e-actions-2 was found to delete.");
  });
});
