/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Destroy instance" (SPEC-0037), the writes of `kubectl cnpg destroy` of
// v1.30.1 (`internal/cmd/plugin/destroy/destroy.go`) in its order: the
// volumes of the instance, its pod, its jobs. Offered on a replica only.
// `--keep-pvc` is not offered: on 1.30 the operator recreates the instance
// under the same name (the first free serial), and a kept volume of that name
// leaves the new instance stuck (reproduced with the plugin itself). The
// guard, the plan and the facts of the dialog. Pure.

import { disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard, ActionWrite } from "./write-actions";

export const INSTANCE_NAME_LABEL = "cnpg.io/instanceName";
export const PVC_ROLE_LABEL = "cnpg.io/pvcRole";
export const PVC_STATUS_ANNOTATION = "cnpg.io/pvcStatus";
export const PVC_DETACHED = "detached";
/** The volumes `GetInstancePVCs` gathers. */
export const INSTANCE_PVC_ROLES: readonly string[] = ["PG_DATA", "PG_WAL", "PG_TABLESPACE"];

export interface OwnerReference {
  apiVersion?: string;
  kind?: string;
  name?: string;
  uid?: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface DestroyClusterFacts {
  name: string;
  namespace: string;
  status?: { currentPrimary?: string; targetPrimary?: string; instanceNames?: readonly string[] };
}

export interface DestroyClaim {
  name: string;
  labels: Readonly<Record<string, string | undefined>>;
  annotations: Readonly<Record<string, string | undefined>>;
  ownerReferences: readonly OwnerReference[];
  size?: string;
}

export interface DestroyPod {
  name: string;
  ownerReferences: readonly OwnerReference[];
}

export interface RunningBackup {
  name: string;
  /** The pod it runs on, once the operator says. */
  instance?: string;
}

/** Owned by the cluster: an owner reference of kind Cluster of the CloudNativePG group, with its name. */
export function ownedByCluster(owners: readonly OwnerReference[], cluster: string): boolean {
  return owners.some(
    (owner) =>
      owner.kind === "Cluster" && owner.name === cluster && (owner.apiVersion ?? "").startsWith("postgresql.cnpg.io/"),
  );
}

/** The volumes of an instance, as `GetInstancePVCs` finds them: the instance label and a role it knows. */
export function instanceClaims(claims: readonly DestroyClaim[], instance: string): DestroyClaim[] {
  return claims
    .filter(
      (claim) =>
        claim.labels[INSTANCE_NAME_LABEL] === instance &&
        INSTANCE_PVC_ROLES.includes(claim.labels[PVC_ROLE_LABEL] ?? ""),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function canDestroyInstance(
  cluster: DestroyClusterFacts,
  instance: string,
  backups: readonly RunningBackup[] = [],
): ActionGuard {
  const status = cluster.status ?? {};
  if (!(status.instanceNames ?? []).includes(instance)) {
    return disabledGuard(`${instance} is not an instance of ${cluster.name}`);
  }
  if (instance === status.currentPrimary) {
    return disabledGuard(`${instance} is the primary: destroying the primary is not offered, switch over first`);
  }
  if (instance === status.targetPrimary) {
    return disabledGuard(`${instance} is about to become the primary`);
  }
  if (status.currentPrimary && status.targetPrimary && status.currentPrimary !== status.targetPrimary) {
    return disabledGuard("A switchover or a failover is in flight");
  }
  const backup = backups.find((candidate) => candidate.instance === instance);
  if (backup) return disabledGuard(`The backup ${backup.name} is running on ${instance}`);
  return enabledGuard;
}

export interface DestroyPlan {
  claims: Array<{ name: string; size?: string; role?: string }>;
  /** Undefined when the pod is gone already. */
  pod?: string;
  /** Why the pod cannot be deleted: it is not the cluster's. */
  podRefusal?: string;
  jobs: string[];
}

/**
 * What the destroy writes, as the plugin does: the volumes of the instance the cluster owns, and one detached
 * from this very instance earlier (by `kubectl cnpg destroy --keep-pvc`).
 */
export function destroyPlan(
  cluster: string,
  instance: string,
  claims: readonly DestroyClaim[],
  pod: DestroyPod | undefined,
  jobs: readonly string[],
): DestroyPlan {
  const planned = instanceClaims(claims, instance)
    .filter(
      (claim) =>
        ownedByCluster(claim.ownerReferences, cluster) || claim.annotations[PVC_STATUS_ANNOTATION] === PVC_DETACHED,
    )
    .map((claim) => ({ name: claim.name, size: claim.size, role: claim.labels[PVC_ROLE_LABEL] }));
  return {
    claims: planned,
    pod: pod?.name,
    podRefusal:
      pod && !ownedByCluster(pod.ownerReferences, cluster)
        ? `The pod ${pod.name} is not owned by ${cluster}`
        : undefined,
    jobs: [...jobs].sort(),
  };
}

function claimWords(claim: DestroyPlan["claims"][number]): string {
  const details = [claim.role, claim.size].filter(Boolean).join(", ");
  return details ? `${claim.name} (${details})` : claim.name;
}

export function destroyWrites(cluster: DestroyClusterFacts, plan: DestroyPlan): ActionWrite[] {
  const ns = cluster.namespace;
  return [
    ...plan.claims.map((claim) => ({
      verb: "delete" as const,
      text: `delete PersistentVolumeClaim ${ns}/${claimWords(claim)}`,
    })),
    ...(plan.pod ? [{ verb: "delete" as const, text: `delete Pod ${ns}/${plan.pod}` }] : []),
    ...plan.jobs.map((job) => ({ verb: "delete" as const, text: `delete Job ${ns}/${job}` })),
  ];
}

export function destroyFacts(cluster: DestroyClusterFacts, instance: string, plan: DestroyPlan): ActionDialogFacts {
  const primary = cluster.status?.currentPrimary;
  const notes = [
    "In this order, as kubectl cnpg destroy: the volumes, then the pod, then the jobs of the instance.",
    `The operator then creates the instance again, under the first free name (${instance} itself when it is free), as a full copy of the primary${primary ? ` ${primary}` : ""}: it takes as long as copying the whole database.`,
  ];
  if (!plan.pod) notes.push(`The pod ${instance} is gone already: only its volumes and jobs are left.`);
  const warnings = [
    "The data on these volumes is lost. It is a copy of the primary's, unless this instance had something the primary has not.",
  ];
  if (plan.claims.length === 0) warnings.push(`No volume of ${instance} was found to delete.`);
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: destroyWrites(cluster, plan),
    notes,
    warnings,
    typedName: instance,
  };
}
