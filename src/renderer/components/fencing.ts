/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything the fencing actions decide (SPEC-0024), as pure functions over
// structurally declared inputs: what the annotation means, the next value for
// each of the four actions, the guards and the facts of the dialogs.
//
// The whole fenced set lives in one string, and no webhook validates it: a
// value that does not parse is accepted and silently means that nobody is
// fenced. So the extension parses strictly, serializes itself, and never
// writes a set it computed from a stale read (W6).

import { disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export const FENCED_INSTANCES_ANNOTATION = "cnpg.io/fencedInstances";
export const ALL_INSTANCES = "*";

export const UNPARSEABLE_FENCING = "The annotation does not parse: the operator treats every instance as not fenced";
export const ALL_FENCED_LIFT_REASON = "The whole cluster is fenced: lift all fences instead";
export const COLD_SNAPSHOT_LIFT_REASON = "The operator fenced it for a cold snapshot backup and lifts it itself";
export const HIBERNATED_FENCE_REASON = "The cluster is hibernated: there is no PostgreSQL to stop";

/** What the annotation says. `all` is `["*"]`, with or without other entries next to it. */
export type FencedSet =
  | { kind: "none" }
  | { kind: "names"; names: string[] }
  | { kind: "all" }
  | { kind: "unparseable"; raw: string };

export function parseFenced(annotation: string | undefined | null): FencedSet {
  if (annotation === undefined || annotation === null || annotation.trim() === "") return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(annotation);
  } catch {
    return { kind: "unparseable", raw: annotation };
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return { kind: "unparseable", raw: annotation };
  }
  const names = [...new Set(parsed as string[])].sort();
  if (names.includes(ALL_INSTANCES)) return { kind: "all" };
  return names.length === 0 ? { kind: "none" } : { kind: "names", names };
}

export function isFencedIn(set: FencedSet, instance: string): boolean {
  return set.kind === "all" || (set.kind === "names" && set.names.includes(instance));
}

/** The value of the annotation: compact, sorted JSON, or `null`, which removes the key in a merge patch. */
export function serializeFenced(set: FencedSet): string | null {
  if (set.kind === "all") return JSON.stringify([ALL_INSTANCES]);
  if (set.kind === "names" && set.names.length > 0) return JSON.stringify([...set.names].sort());
  return null;
}

export type FencedTransition =
  | { kind: "next"; set: FencedSet }
  | { kind: "unchanged" }
  | { kind: "refused"; reason: string };

/** Fences one instance, or every one with `*`. The star replaces the named entries. */
export function fenceOn(set: FencedSet, instance: string): FencedTransition {
  if (instance === ALL_INSTANCES)
    return set.kind === "all" ? { kind: "unchanged" } : { kind: "next", set: { kind: "all" } };
  if (set.kind === "all") return { kind: "unchanged" };
  const names = set.kind === "names" ? set.names : [];
  if (names.includes(instance)) return { kind: "unchanged" };
  return { kind: "next", set: { kind: "names", names: [...names, instance].sort() } };
}

/** Lifts the fence of one instance, or every fence with `*`, which also removes a value that does not parse. */
export function fenceOff(set: FencedSet, instance: string): FencedTransition {
  if (instance === ALL_INSTANCES)
    return set.kind === "none" ? { kind: "unchanged" } : { kind: "next", set: { kind: "none" } };
  if (set.kind === "all") return { kind: "refused", reason: ALL_FENCED_LIFT_REASON };
  if (set.kind !== "names" || !set.names.includes(instance)) return { kind: "unchanged" };
  const names = set.names.filter((name) => name !== instance);
  return { kind: "next", set: names.length === 0 ? { kind: "none" } : { kind: "names", names } };
}

export interface FencingClusterFacts {
  name: string;
  namespace: string;
  resourceVersion?: string;
  hibernated: boolean;
  /** The raw value of `cnpg.io/fencedInstances`. */
  fencedAnnotation?: string;
  spec?: { postgresql?: { synchronous?: { number?: number; dataDurability?: "required" | "preferred" } } };
  status?: { currentPrimary?: string; instanceNames?: readonly string[] };
}

/** A backup of the cluster, as far as the cold snapshot guard needs it. */
export interface FencingBackupFacts {
  name: string;
  method?: string;
  online?: boolean;
  phase?: string;
}

const DONE_PHASES: readonly string[] = ["completed", "failed"];

/** The cold volume snapshot backup that is running, during which the operator owns the fence. */
export function coldSnapshotRunning(backups: readonly FencingBackupFacts[]): FencingBackupFacts | undefined {
  return backups.find(
    (backup) =>
      backup.method === "volumeSnapshot" &&
      backup.online === false &&
      backup.phase !== undefined &&
      backup.phase !== "" &&
      !DONE_PHASES.includes(backup.phase),
  );
}

export function canFenceInstance(cluster: FencingClusterFacts, instance: string): ActionGuard {
  if (cluster.hibernated) return disabledGuard(HIBERNATED_FENCE_REASON);
  if (!(cluster.status?.instanceNames ?? []).includes(instance)) {
    return disabledGuard(`${instance} is not an instance of the cluster`);
  }
  if (isFencedIn(parseFenced(cluster.fencedAnnotation), instance)) return disabledGuard("It is fenced already");
  return enabledGuard;
}

export function canFenceAll(cluster: FencingClusterFacts): ActionGuard {
  if (cluster.hibernated) return disabledGuard(HIBERNATED_FENCE_REASON);
  if (parseFenced(cluster.fencedAnnotation).kind === "all") return disabledGuard("Every instance is fenced already");
  return enabledGuard;
}

export function canLiftInstance(
  cluster: FencingClusterFacts,
  instance: string,
  backups: readonly FencingBackupFacts[],
): ActionGuard {
  const set = parseFenced(cluster.fencedAnnotation);
  if (set.kind === "all") return disabledGuard(ALL_FENCED_LIFT_REASON);
  if (!isFencedIn(set, instance)) return disabledGuard("It is not fenced");
  if (coldSnapshotRunning(backups)) return disabledGuard(COLD_SNAPSHOT_LIFT_REASON);
  return enabledGuard;
}

export function canLiftAll(cluster: FencingClusterFacts, backups: readonly FencingBackupFacts[]): ActionGuard {
  if (parseFenced(cluster.fencedAnnotation).kind === "none") return disabledGuard("No instance is fenced");
  if (coldSnapshotRunning(backups)) return disabledGuard(COLD_SNAPSHOT_LIFT_REASON);
  return enabledGuard;
}

/** The merge patch of the annotation. It carries the resource version: the new value was computed from the old one (W6). */
export function fencingPatch(
  cluster: FencingClusterFacts,
  next: FencedSet,
): { metadata: { resourceVersion?: string; annotations: Record<string, string | null> } } {
  return {
    metadata: {
      ...(cluster.resourceVersion ? { resourceVersion: cluster.resourceVersion } : {}),
      annotations: { [FENCED_INSTANCES_ANNOTATION]: serializeFenced(next) },
    },
  };
}

function valueWords(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "(unset)" : value;
}

function writeText(cluster: FencingClusterFacts, next: FencedSet): string {
  return `patch Cluster ${cluster.namespace}/${cluster.name}: annotation ${FENCED_INSTANCES_ANNOTATION} ${valueWords(
    cluster.fencedAnnotation,
  )} -> ${valueWords(serializeFenced(next))}`;
}

export type FencingAction = { kind: "fence" | "lift"; instance: string };

/** The next set for an action, or why there is none. */
export function fencingTransition(cluster: FencingClusterFacts, action: FencingAction): FencedTransition {
  const set = parseFenced(cluster.fencedAnnotation);
  return action.kind === "fence" ? fenceOn(set, action.instance) : fenceOff(set, action.instance);
}

/**
 * The facts of the four dialogs. A write that would change nothing is not
 * listed (W4): the caller does not open a dialog without a write.
 */
export function fencingDialogFacts(cluster: FencingClusterFacts, action: FencingAction): ActionDialogFacts {
  const transition = fencingTransition(cluster, action);
  const writes =
    transition.kind === "next" ? [{ verb: "patch" as const, text: writeText(cluster, transition.set) }] : [];
  const all = action.instance === ALL_INSTANCES;
  const subject = subjectOf("Cluster", cluster.namespace, cluster.name);

  if (action.kind === "lift") {
    return {
      subject,
      writes,
      notes: [
        all
          ? "The instance managers start PostgreSQL again on every fenced instance, and the pods turn ready."
          : `The instance manager of ${action.instance} starts PostgreSQL again, and the pod turns ready.`,
        ...(parseFenced(cluster.fencedAnnotation).kind === "unparseable"
          ? ["The value does not parse, so nobody is fenced today: this removes it."]
          : []),
      ],
      warnings: [],
    };
  }

  const primary = cluster.status?.currentPrimary;
  const warnings: string[] = [];
  if (all || action.instance === primary) {
    warnings.push("Writes stop and no failover happens while the primary is fenced: that is what fencing is for.");
  } else {
    const synchronous = cluster.spec?.postgresql?.synchronous;
    if (synchronous && (synchronous.dataDurability ?? "required") !== "preferred") {
      const set = parseFenced(cluster.fencedAnnotation);
      const standbys = (cluster.status?.instanceNames ?? []).filter(
        (name) => name !== primary && name !== action.instance && !isFencedIn(set, name),
      ).length;
      const needed = synchronous.number ?? 1;
      if (standbys < needed) {
        warnings.push(
          `Synchronous replication is required with ${needed} ${
            needed === 1 ? "standby" : "standbys"
          }: without ${action.instance} the cluster has ${standbys}, and writes wait until the fence is lifted.`,
        );
      }
    }
  }

  return {
    subject,
    writes,
    notes: [
      all
        ? "On every instance the pod stays and PostgreSQL is shut down: the pods turn not ready. Rollouts skip fenced instances."
        : `The pod of ${action.instance} stays and PostgreSQL is shut down in it: the pod turns not ready. Rollouts skip a fenced instance.`,
    ],
    warnings,
    typedName: cluster.name,
  };
}
