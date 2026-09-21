/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything the hibernation actions decide (SPEC-0024), as pure functions
// over structurally declared inputs: the state of a hibernation from the
// annotation and the condition, the two guards, what is attached to the
// cluster and what happens to it while the cluster sleeps, the bodies and the
// facts of the two dialogs.
//
// The phase stays the healthy one from the first deleted pod to the last, so
// the state is never read from it.

import { HEALTHY_PHASE } from "./switchover";
import { disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export const HIBERNATION_ANNOTATION = "cnpg.io/hibernation";
export const HIBERNATION_CONDITION = "cnpg.io/hibernation";

export interface HibernationClusterFacts {
  name: string;
  namespace: string;
  /** The raw value of `cnpg.io/hibernation`. */
  annotation?: string;
  /** The `cnpg.io/hibernation` condition, when the operator has written it. */
  condition?: { status?: string; reason?: string; message?: string };
  spec?: { instances?: number };
  status?: {
    phase?: string;
    currentPrimary?: string;
    readyInstances?: number;
    instanceNames?: readonly string[];
  };
}

export type HibernationState =
  | { kind: "off" }
  | { kind: "requested" }
  | { kind: "waiting" }
  | { kind: "in progress"; waitingFor?: string }
  | { kind: "hibernated" }
  | { kind: "resuming"; ready: number; declared: number };

function isOn(cluster: HibernationClusterFacts): boolean {
  return cluster.annotation?.trim().toLowerCase() === "on";
}

const WAITING_FOR_POD = /^Waiting for (\S+) to be deleted$/;

export function hibernationState(cluster: HibernationClusterFacts): HibernationState {
  const condition = cluster.condition;

  if (isOn(cluster)) {
    if (!condition) return { kind: "requested" };
    if (condition.status === "True" || condition.reason === "Hibernated") return { kind: "hibernated" };
    if (condition.reason === "WaitingForHealthy") return { kind: "waiting" };
    if (condition.reason === "DeletingPods" || condition.reason === "WaitingPodsDeletion") {
      return { kind: "in progress", waitingFor: WAITING_FOR_POD.exec(condition.message ?? "")?.[1] };
    }
    return { kind: "requested" };
  }

  // Waking up: the operator removes the condition at once and recreates the pods afterwards.
  const declared = cluster.spec?.instances ?? 0;
  const ready = cluster.status?.readyInstances ?? 0;
  if (cluster.annotation?.trim().toLowerCase() === "off" && !condition && ready < declared) {
    return { kind: "resuming", ready, declared };
  }
  return { kind: "off" };
}

/** The words of the "Hibernation" row of the drawer. */
export function hibernationWords(state: HibernationState): string {
  switch (state.kind) {
    case "requested":
      return "Requested: the operator has not answered yet";
    case "waiting":
      return "Waiting: the operator starts once the cluster is healthy";
    case "in progress":
      return state.waitingFor
        ? `In progress: waiting for ${state.waitingFor} to be deleted`
        : "In progress: the operator is deleting the pods, the primary first";
    case "hibernated":
      return "Hibernated: no pod runs, every volume is kept";
    case "resuming":
      return `Resuming: ${state.ready} of ${state.declared} instances ready`;
    default:
      return "Off";
  }
}

export function canHibernate(cluster: HibernationClusterFacts): ActionGuard {
  return isOn(cluster) ? disabledGuard("The hibernation is requested already") : enabledGuard;
}

export function canResumeCluster(cluster: HibernationClusterFacts): ActionGuard {
  return isOn(cluster) ? enabledGuard : disabledGuard("The cluster is not hibernated");
}

/** What is attached to the cluster, from the stores the extension already loads. */
export interface HibernationRelated {
  /** The volumes of the instances, with their sizes as the claims declare them. */
  volumes: ReadonlyArray<{ name: string; size?: string }>;
  poolers: readonly string[];
  /** The schedules of the cluster with `suspend` as they declare it. */
  schedules: ReadonlyArray<{ name: string; suspended: boolean }>;
  /** The declarative objects of the cluster, per kind. */
  declared: { databases: number; roles: number; publications: number; subscriptions: number };
  /** `namespace/name` of the subscriptions of other clusters of this Kubernetes that read from this one. */
  subscribersElsewhere: readonly string[];
}

export const NOTHING_RELATED: HibernationRelated = {
  volumes: [],
  poolers: [],
  schedules: [],
  declared: { databases: 0, roles: 0, publications: 0, subscriptions: 0 },
  subscribersElsewhere: [],
};

/** One heading of the dialog with its lines. A list with no line is not there at all. */
export interface ConsequenceList {
  id: "pods" | "volumes" | "poolers" | "schedules" | "declared" | "subscriptions";
  heading: string;
  lines: string[];
  /** The schedules by name: each one is a door to its own Suspend (SPEC-0021). */
  scheduleNames?: string[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function hibernationConsequences(
  cluster: HibernationClusterFacts,
  related: HibernationRelated,
): ConsequenceList[] {
  const primary = cluster.status?.currentPrimary;
  const names = cluster.status?.instanceNames ?? [];
  const ordered = [...names.filter((name) => name === primary), ...names.filter((name) => name !== primary)];
  const active = related.schedules.filter((schedule) => !schedule.suspended);
  const declared = [
    related.declared.databases ? plural(related.declared.databases, "Database", "Databases") : "",
    related.declared.roles ? plural(related.declared.roles, "DatabaseRole", "DatabaseRoles") : "",
    related.declared.publications ? plural(related.declared.publications, "Publication", "Publications") : "",
    related.declared.subscriptions ? plural(related.declared.subscriptions, "Subscription", "Subscriptions") : "",
  ].filter(Boolean);

  const lists: ConsequenceList[] = [
    {
      id: "pods",
      heading: "Pods that are deleted, in this order",
      lines: ordered.map((name) => (name === primary ? `${name} (primary, first: no switchover happens)` : name)),
    },
    {
      id: "volumes",
      heading: "Volumes that are kept",
      lines: related.volumes.map((volume) => (volume.size ? `${volume.name} (${volume.size})` : volume.name)),
    },
    {
      id: "poolers",
      heading: "Poolers that lose their backend",
      lines: [...related.poolers],
    },
    {
      id: "schedules",
      heading: "Schedules that are not suspended: each run will produce a failed backup",
      lines: active.map((schedule) => schedule.name),
      scheduleNames: active.map((schedule) => schedule.name),
    },
    {
      id: "declared",
      heading: "Declared objects that stop being reconciled: only the primary reconciles them",
      lines: declared,
    },
    {
      id: "subscriptions",
      heading: "Subscriptions of other clusters that read from this one: they stall",
      lines: [...related.subscribersElsewhere],
    },
  ];
  return lists.filter((list) => list.lines.length > 0);
}

export function hibernationPatch(value: "on" | "off"): { metadata: { annotations: Record<string, string> } } {
  return { metadata: { annotations: { [HIBERNATION_ANNOTATION]: value } } };
}

function valueWords(value: string | undefined): string {
  return value === undefined || value === "" ? "(unset)" : value;
}

export function hibernateFacts(cluster: HibernationClusterFacts): ActionDialogFacts {
  const phase = cluster.status?.phase;
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: annotation ${HIBERNATION_ANNOTATION} ${valueWords(
          cluster.annotation,
        )} -> on`,
      },
    ],
    notes: [
      "The operator deletes every pod, the primary first, and keeps every volume. The database is down until the cluster is resumed.",
    ],
    warnings:
      phase === HEALTHY_PHASE
        ? []
        : [
            `The operator starts a hibernation only on a healthy cluster, and this one says "${
              phase ?? "no phase reported"
            }": the request is accepted and waits.`,
          ],
    typedName: cluster.name,
  };
}

export function resumeClusterFacts(cluster: HibernationClusterFacts, related: HibernationRelated): ActionDialogFacts {
  const declared = cluster.spec?.instances ?? 0;
  const volumes = related.volumes.map((volume) => volume.name);
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: annotation ${HIBERNATION_ANNOTATION} ${valueWords(
          cluster.annotation,
        )} -> off`,
      },
    ],
    notes: [
      `The operator recreates ${plural(declared, "instance", "instances")} on the volumes that were kept${
        volumes.length > 0 ? ` (${volumes.join(", ")})` : ""
      }, and the cluster comes back with its data.`,
    ],
    warnings: [],
  };
}
