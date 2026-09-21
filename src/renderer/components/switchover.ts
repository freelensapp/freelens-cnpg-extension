/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything a switchover decides (SPEC-0022), as pure functions over
// structurally declared inputs: whether the cluster can be switched over at
// all, which standbys can be promoted and why the others cannot, how far
// behind each one is, which one is proposed, and what the dialog says.
//
// The upstream tooling checks almost nothing before this write, and the
// admission webhooks do not see the status subresource: every guard here is
// the only guard there is.

import { lsnDistance } from "./lsn";
import { disabledGuard, enabledGuard, isReplicaCluster, REPLICA_CLUSTER_REASON, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export const HEALTHY_PHASE = "Cluster in healthy state";
export const WAITING_FOR_USER_PHASE = "Waiting for user action";

/** One WAL segment at the default size: beyond this a candidate has real replaying to do. */
export const LAG_WARNING_BYTES = 16n * 1024n * 1024n;

export const HIBERNATED_SWITCHOVER_REASON = "The cluster is hibernated: there is no primary to move";
export const NO_STANDBY_REASON = "There is no standby to promote";
export const NO_ELIGIBLE_REASON = "No standby can be promoted right now: open the cluster to see why";

export interface SwitchoverClusterFacts {
  name: string;
  namespace: string;
  resourceVersion?: string;
  hibernated: boolean;
  /** The instances named in `cnpg.io/fencedInstances`; `*` fences every one. */
  fenced: readonly string[];
  spec?: {
    instances?: number;
    switchoverDelay?: number;
    replica?: { enabled?: boolean; primary?: string; self?: string };
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

/** A pod of the namespace, as far as eligibility needs it. */
export interface InstancePodFacts {
  name: string;
  labels?: Record<string, string | undefined>;
  ready: boolean;
  nodeName?: string;
}

/** One row of `pg_stat_replication` as the primary reports it through its status endpoint. */
export interface ReplicationRowFacts {
  applicationName?: string;
  state?: string;
  syncState?: string;
  replayLsn?: string;
}

/** What the primary said, or undefined when its status endpoint could not be read. */
export interface PrimaryReplicationFacts {
  currentLsn?: string;
  rows: readonly ReplicationRowFacts[];
}

export interface SwitchoverCandidate {
  name: string;
  eligible: boolean;
  /** Why it cannot be promoted. Always set when `eligible` is false. */
  reason?: string;
  nodeName?: string;
  /** `streaming`, `catchup`, ... as the primary reports it; undefined when it reports no row. */
  state?: string;
  /** `sync`, `quorum`, `potential`, `async`. */
  syncState?: string;
  /** Bytes of WAL still to replay. Never negative: a standby ahead of the last report is at zero. */
  lagBytes?: bigint;
}

function isFenced(cluster: SwitchoverClusterFacts, instance: string): boolean {
  return cluster.fenced.includes("*") || cluster.fenced.includes(instance);
}

function isSynchronous(candidate: SwitchoverCandidate): boolean {
  return candidate.syncState === "sync" || candidate.syncState === "quorum";
}

/**
 * One row per instance other than the primary, eligible or not: an instance
 * that cannot be promoted stays on screen with its reason, because "why is my
 * standby not here" is the question the dialog would otherwise raise.
 */
export function switchoverCandidates(
  cluster: SwitchoverClusterFacts,
  pods: readonly InstancePodFacts[],
  replication: PrimaryReplicationFacts | undefined,
): SwitchoverCandidate[] {
  const primary = cluster.status?.currentPrimary;
  const healthy = cluster.status?.instancesStatus?.healthy ?? [];

  return (cluster.status?.instanceNames ?? [])
    .filter((name) => name !== primary)
    .map((name) => {
      const pod = pods.find((candidate) => candidate.name === name);
      const row = replication?.rows.find((candidate) => candidate.applicationName === name);
      const distance = row ? lsnDistance(row.replayLsn, replication?.currentLsn) : undefined;
      const belongs =
        pod?.labels?.["cnpg.io/cluster"] === cluster.name && pod?.labels?.["cnpg.io/podRole"] === "instance";

      let reason: string | undefined;
      if (!pod) reason = "Its pod does not exist";
      else if (!belongs) reason = "A pod of this name exists, but it is not an instance of this cluster";
      else if (isFenced(cluster, name)) reason = "It is fenced";
      else if (!healthy.includes(name)) reason = "The operator does not report it as healthy";
      else if (!pod.ready) reason = "Its pod is not ready";

      return {
        name,
        eligible: reason === undefined,
        reason,
        nodeName: pod?.nodeName,
        state: row?.state,
        syncState: row?.syncState,
        lagBytes: distance === undefined ? undefined : distance < 0n ? 0n : distance,
      };
    });
}

/**
 * The proposed target: among the eligible, a synchronous one first, then the
 * least replay lag, an unknown lag last, the name as the tie break.
 */
export function preselectedCandidate(candidates: readonly SwitchoverCandidate[]): string | undefined {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const ranked = [...eligible].sort((a, b) => {
    const sync = Number(isSynchronous(b)) - Number(isSynchronous(a));
    if (sync !== 0) return sync;
    if (a.lagBytes === undefined || b.lagBytes === undefined) {
      if (a.lagBytes !== b.lagBytes) return a.lagBytes === undefined ? 1 : -1;
    } else if (a.lagBytes !== b.lagBytes) {
      return a.lagBytes < b.lagBytes ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return ranked[0]?.name;
}

/**
 * The guard of the action. `candidates` is undefined while the pods are not
 * loaded yet: a read that has not finished never refuses a write, and the
 * dialog checks the chosen row again.
 */
export function canSwitchover(
  cluster: SwitchoverClusterFacts,
  candidates: readonly SwitchoverCandidate[] | undefined,
): ActionGuard {
  if (isReplicaCluster(cluster)) return disabledGuard(REPLICA_CLUSTER_REASON);
  if (cluster.hibernated) return disabledGuard(HIBERNATED_SWITCHOVER_REASON);
  if ((cluster.spec?.instances ?? 0) < 2) return disabledGuard(NO_STANDBY_REASON);

  const current = cluster.status?.currentPrimary;
  const target = cluster.status?.targetPrimary;
  if (!current) return disabledGuard("The cluster reports no primary yet");
  if (target && target !== current) {
    return disabledGuard(`A switchover or a failover is already in flight, to ${target}`);
  }

  const phase = cluster.status?.phase;
  if (phase !== HEALTHY_PHASE && phase !== WAITING_FOR_USER_PHASE) {
    return disabledGuard(`The cluster is not in a state to be switched over: "${phase ?? "no phase reported"}"`);
  }
  if (candidates && !candidates.some((candidate) => candidate.eligible)) return disabledGuard(NO_ELIGIBLE_REASON);
  return enabledGuard;
}

/** Why the chosen row cannot be confirmed, or undefined. */
export function switchoverBlockReason(
  candidates: readonly SwitchoverCandidate[],
  target: string | undefined,
): string | undefined {
  if (!target) return "Choose the standby to promote";
  const chosen = candidates.find((candidate) => candidate.name === target);
  if (!chosen) return `${target} is not an instance of the cluster anymore`;
  return chosen.eligible ? undefined : `${target} cannot be promoted: ${chosen.reason}`;
}

export function formatBytes(bytes: bigint): string {
  if (bytes < 1024n) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes) / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** The lag cell of a candidate. An unreadable endpoint says so: the lag informs the choice, it does not gate it. */
export function lagWords(candidate: SwitchoverCandidate, replication: PrimaryReplicationFacts | undefined): string {
  if (!replication) return "not readable";
  if (candidate.lagBytes === undefined) return "not reported";
  return candidate.lagBytes === 0n ? "none" : formatBytes(candidate.lagBytes);
}

function delayWords(cluster: SwitchoverClusterFacts): string {
  const delay = cluster.spec?.switchoverDelay;
  return delay === undefined
    ? "a fast shutdown, with the operator's default time limit"
    : `a fast shutdown, then an immediate one after ${delay} s (.spec.switchoverDelay)`;
}

export function switchoverNotes(cluster: SwitchoverClusterFacts, target: string | undefined): string[] {
  const current = cluster.status?.currentPrimary ?? "the primary";
  const notes = [
    `In order: the primary ${current} is shut down first (${delayWords(cluster)}) and comes back as a standby, then ${
      target ?? "the chosen standby"
    } is promoted. Clients of the read-write service are disconnected and reconnect to the new primary.`,
  ];
  if (cluster.status?.phase === WAITING_FOR_USER_PHASE) {
    notes.push(
      "The cluster is waiting for user action: this switchover is what its supervised rolling update waits for.",
    );
  }
  return notes;
}

export function switchoverWarnings(
  cluster: SwitchoverClusterFacts,
  candidates: readonly SwitchoverCandidate[],
  target: string | undefined,
): string[] {
  const warnings: string[] = [];
  const chosen = candidates.find((candidate) => candidate.name === target);

  if (chosen?.lagBytes !== undefined && chosen.lagBytes > LAG_WARNING_BYTES) {
    warnings.push(
      `${chosen.name} is ${formatBytes(chosen.lagBytes)} behind: it has that much to replay before it can be promoted, and writes wait for it.`,
    );
  }

  const synchronous = cluster.spec?.postgresql?.synchronous;
  const required = synchronous && (synchronous.dataDurability ?? "required") !== "preferred";
  if (required && chosen) {
    // While the old primary comes back, the standbys are the eligible ones minus the one that is promoted.
    const remaining = candidates.filter((candidate) => candidate.eligible && candidate.name !== chosen.name).length;
    const needed = synchronous.number ?? 1;
    if (remaining < needed) {
      warnings.push(
        `Synchronous replication is required with ${needed} ${
          needed === 1 ? "standby" : "standbys"
        }: while the old primary comes back the cluster has ${remaining}, and writes wait for a standby during that time.`,
      );
    }
  }
  return warnings;
}

/** The one write, spelled as the four fields it sets. */
export function switchoverWriteText(cluster: SwitchoverClusterFacts, target: string | undefined): string {
  const current = cluster.status?.currentPrimary ?? "(none)";
  const to = target ?? "<standby>";
  return `patch Cluster ${cluster.namespace}/${cluster.name} (status): targetPrimary ${current} -> ${to}, targetPrimaryTimestamp now, phase "${
    cluster.status?.phase ?? ""
  }" -> "Switchover in progress", phaseReason "Switching over to ${to}"`;
}

export function switchoverDialogFacts(
  cluster: SwitchoverClusterFacts,
  candidates: readonly SwitchoverCandidate[],
  target: string | undefined,
): ActionDialogFacts {
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [{ verb: "patch", text: switchoverWriteText(cluster, target) }],
    notes: switchoverNotes(cluster, target),
    warnings: switchoverWarnings(cluster, candidates, target),
    typedName: cluster.name,
  };
}
