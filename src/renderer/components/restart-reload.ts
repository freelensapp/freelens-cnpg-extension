/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything the restart and the reload actions decide (SPEC-0023), as pure
// functions over structurally declared inputs: the guards, the sequence a
// restart of the whole cluster will follow on this cluster, the bodies of the
// two annotation patches and the facts of the four dialogs.
//
// The value of the dialog of a cluster restart is the plan: four fields of
// the spec decide what happens to the primary, and nothing upstream says it
// before the click.

import { HEALTHY_PHASE } from "./switchover";
import { disabledGuard, enabledGuard, rfc3339Micro, rfc3339Seconds, subjectOf } from "./write-actions";

import type { InstancePodFacts } from "./switchover";
import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export const RESTARTED_AT_ANNOTATION = "kubectl.kubernetes.io/restartedAt";
export const RELOADED_AT_ANNOTATION = "cnpg.io/reloadedAt";

export const UPGRADING_PHASE = "Upgrading cluster";

export const HIBERNATED_RESTART_REASON = "The cluster is hibernated: there is no instance to restart";
export const HIBERNATED_RELOAD_REASON = "The cluster is hibernated: there is no instance to reload";
export const FENCED_INSTANCE_REASON = "PostgreSQL is stopped on purpose on this instance: lift the fence instead";

export interface RestartClusterFacts {
  name: string;
  namespace: string;
  resourceVersion?: string;
  hibernated: boolean;
  /** The instances named in `cnpg.io/fencedInstances`; `*` fences every one. */
  fenced: readonly string[];
  spec?: {
    instances?: number;
    primaryUpdateStrategy?: "unsupervised" | "supervised";
    primaryUpdateMethod?: "switchover" | "restart";
    postgresql?: { synchronous?: { number?: number; dataDurability?: "required" | "preferred" } };
  };
  status?: {
    phase?: string;
    currentPrimary?: string;
    targetPrimary?: string;
    instanceNames?: readonly string[];
    instancesStatus?: { healthy?: readonly string[] };
  };
}

function isFenced(cluster: RestartClusterFacts, instance: string): boolean {
  return cluster.fenced.includes("*") || cluster.fenced.includes(instance);
}

function inFlight(cluster: RestartClusterFacts): string | undefined {
  const current = cluster.status?.currentPrimary;
  const target = cluster.status?.targetPrimary;
  return current && target && current !== target ? target : undefined;
}

export function canRestartCluster(cluster: RestartClusterFacts): ActionGuard {
  if (cluster.hibernated) return disabledGuard(HIBERNATED_RESTART_REASON);
  const target = inFlight(cluster);
  if (target) return disabledGuard(`A switchover or a failover is in flight, to ${target}`);
  return enabledGuard;
}

export function canReload(cluster: RestartClusterFacts): ActionGuard {
  return cluster.hibernated ? disabledGuard(HIBERNATED_RELOAD_REASON) : enabledGuard;
}

/** One step of the rollout, in the order the operator takes them. */
export interface RestartStep {
  /** The instance the step is about, when it is about one. */
  instance?: string;
  kind: "standby" | "skipped" | "primary";
  text: string;
}

/**
 * The sequence a restart of the whole cluster follows on this cluster: every
 * standby in turn, the fenced ones skipped, then the primary by the cluster's
 * own `primaryUpdateStrategy` and `primaryUpdateMethod`.
 */
export function restartPlan(cluster: RestartClusterFacts): RestartStep[] {
  const primary = cluster.status?.currentPrimary;
  const names = cluster.status?.instanceNames ?? [];
  const steps: RestartStep[] = [];

  for (const name of names.filter((candidate) => candidate !== primary)) {
    steps.push(
      isFenced(cluster, name)
        ? { instance: name, kind: "skipped", text: `${name}: skipped while it is fenced` }
        : {
            instance: name,
            kind: "standby",
            text: `${name} (standby): its pod is deleted and recreated on its volumes`,
          },
    );
  }

  if (!primary) return steps;

  const standbys = names.filter((candidate) => candidate !== primary).length;
  const strategy = cluster.spec?.primaryUpdateStrategy ?? "unsupervised";
  const method = cluster.spec?.primaryUpdateMethod ?? "restart";

  if (isFenced(cluster, primary)) {
    steps.push({ instance: primary, kind: "skipped", text: `${primary} (primary): skipped while it is fenced` });
  } else if (standbys === 0) {
    steps.push({
      instance: primary,
      kind: "primary",
      text: `${primary} (the only instance): its pod is deleted and recreated on its volumes. The database is down until it is back`,
    });
  } else if (strategy === "supervised") {
    steps.push({
      instance: primary,
      kind: "primary",
      text: `${primary} (primary): the rollout stops at "Waiting for user action" (primaryUpdateStrategy: supervised). It goes on when you request a switchover to a standby`,
    });
  } else if (method === "switchover") {
    steps.push({
      instance: primary,
      kind: "primary",
      text: `${primary} (primary): the operator switches over to a standby of its choice, then ${primary} is recreated as a standby (primaryUpdateMethod: switchover). Clients of the read-write service reconnect to the new primary`,
    });
  } else {
    steps.push({
      instance: primary,
      kind: "primary",
      text: `${primary} (primary): its pod is deleted and recreated without a switchover (primaryUpdateMethod: restart). Writes are down until it is back`,
    });
  }
  return steps;
}

export function restartAnnotationPatch(now: Date): { metadata: { annotations: Record<string, string> } } {
  return { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: rfc3339Seconds(now) } } };
}

export function reloadAnnotationPatch(now: Date): { metadata: { annotations: Record<string, string> } } {
  return { metadata: { annotations: { [RELOADED_AT_ANNOTATION]: rfc3339Micro(now) } } };
}

export function restartClusterFacts(cluster: RestartClusterFacts): ActionDialogFacts {
  const phase = cluster.status?.phase;
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: annotation ${RESTARTED_AT_ANNOTATION} = now (RFC 3339, to the second)`,
      },
    ],
    notes: [
      "The operator restarts every instance whose own copy of the annotation differs, one at a time, in the order above.",
    ],
    warnings:
      phase === UPGRADING_PHASE
        ? [
            `A rollout is already running ("${phase}"): the new value restarts again the instances that were already done.`,
          ]
        : [],
    typedName: cluster.name,
  };
}

export function reloadFacts(cluster: RestartClusterFacts): ActionDialogFacts {
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: annotation ${RELOADED_AT_ANNOTATION} = now (RFC 3339, six fractional digits)`,
      },
    ],
    notes: [
      "Nothing reads the value: changing the object makes the operator and the instance managers reconcile now (configuration, secrets, certificates), and PostgreSQL reloads if its configuration changed.",
      "Nothing reports the completion of a reload: there is no phase, condition or event to wait for.",
      "ConfigMaps and Secrets labelled cnpg.io/reload are reloaded already without this.",
    ],
    warnings: [],
  };
}

export type InstanceRestartKind = "standby" | "primary";

export function instanceRestartKind(cluster: RestartClusterFacts, instance: string): InstanceRestartKind {
  return cluster.status?.currentPrimary === instance ? "primary" : "standby";
}

function belongs(cluster: RestartClusterFacts, pod: InstancePodFacts | undefined): boolean {
  return pod?.labels?.["cnpg.io/cluster"] === cluster.name && pod?.labels?.["cnpg.io/podRole"] === "instance";
}

/**
 * The guard of "Restart" on the row of an instance. `pods` is undefined while
 * the pods are not loaded: a read that has not finished never refuses a
 * write, and the delete itself checks the labels again.
 */
export function canRestartInstance(
  cluster: RestartClusterFacts,
  instance: string,
  pods: readonly InstancePodFacts[] | undefined,
): ActionGuard {
  if (cluster.hibernated) return disabledGuard(HIBERNATED_RESTART_REASON);
  if (isFenced(cluster, instance)) return disabledGuard(FENCED_INSTANCE_REASON);

  if (instanceRestartKind(cluster, instance) === "primary") {
    const target = inFlight(cluster);
    if (target) return disabledGuard(`A switchover or a failover is in flight, to ${target}`);
    const phase = cluster.status?.phase;
    if (phase !== HEALTHY_PHASE) {
      return disabledGuard(
        `The primary is restarted in place only on a healthy cluster: "${phase ?? "no phase reported"}"`,
      );
    }
    return enabledGuard;
  }

  if (pods) {
    const pod = pods.find((candidate) => candidate.name === instance);
    if (!pod) return disabledGuard("Its pod does not exist");
    if (!belongs(cluster, pod)) {
      return disabledGuard("A pod of this name exists, but it is not an instance of this cluster");
    }
  }
  return enabledGuard;
}

/** True when the pod may be deleted: the labels say it is an instance of this cluster. A name alone is never trusted. */
export function isInstancePodOf(cluster: RestartClusterFacts, pod: InstancePodFacts | undefined): boolean {
  return belongs(cluster, pod);
}

export function restartStandbyFacts(
  cluster: RestartClusterFacts,
  instance: string,
  pods: readonly InstancePodFacts[],
): ActionDialogFacts {
  const warnings: string[] = [];
  const synchronous = cluster.spec?.postgresql?.synchronous;
  if (synchronous && (synchronous.dataDurability ?? "required") !== "preferred") {
    const primary = cluster.status?.currentPrimary;
    const healthy = cluster.status?.instancesStatus?.healthy ?? [];
    // The standbys that can acknowledge a write while this one is away.
    const others = pods.filter(
      (pod) =>
        pod.name !== instance &&
        pod.name !== primary &&
        pod.ready &&
        belongs(cluster, pod) &&
        healthy.includes(pod.name) &&
        !isFenced(cluster, pod.name),
    ).length;
    const needed = synchronous.number ?? 1;
    if (others < needed) {
      warnings.push(
        `Synchronous replication is required with ${needed} ${
          needed === 1 ? "standby" : "standbys"
        }: without ${instance} the cluster has ${others}, and writes wait until it is back.`,
      );
    }
  }
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [{ verb: "delete", text: `delete Pod ${cluster.namespace}/${instance}` }],
    notes: [
      `${instance} is a standby: the operator recreates its pod on the same volumes, and it catches up from the primary${
        cluster.status?.currentPrimary ? ` ${cluster.status.currentPrimary}` : ""
      }.`,
      "Read-only connections to this instance drop.",
    ],
    warnings,
  };
}

export function restartPrimaryFacts(cluster: RestartClusterFacts, instance: string): ActionDialogFacts {
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name} (status): phase "${
          cluster.status?.phase ?? ""
        }" -> "Primary instance is being restarted in-place", phaseReason "Requested by the user"`,
      },
    ],
    notes: [
      `${instance} is the primary: its instance manager restarts PostgreSQL inside the same pod and writes the healthy phase back itself. The pod is not deleted and no switchover happens.`,
      "Every connection to the primary drops, and writes are down until PostgreSQL is back.",
    ],
    warnings: [],
    typedName: cluster.name,
  };
}
