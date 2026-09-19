/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure health model of a CloudNativePG cluster (SPEC-0001 H1 to H5, SPEC-0003
// "Health model"). No JSX and no colors: the functions map the object to a
// closed set of states and to the host's status classes and theme tokens
// (DESIGN.md section 2), so the list, the drawer and the overview never
// disagree.

import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { parseGoTime } from "./go-time";
import { storeOfCluster } from "./object-stores";

import type { ObjectStore, ServerRecoveryWindow } from "../api/barmancloud/object-store-v1";
import type { KubeCondition } from "../api/types";

export type ClusterHealthState = "Healthy" | "Progressing" | "Degraded" | "Failed" | "Hibernated" | "Unknown";

/** The host's global status classes (core `app.scss`). */
export type HostStatusClass = "success" | "warning" | "error" | "info";

export interface ClusterHealth {
  state: ClusterHealthState;
  /** Short scannable word for the Condition column. */
  label: ClusterHealthState;
  className: HostStatusClass;
  /** Semantic theme token for custom elements (DESIGN.md section 2 table). */
  token: string;
  /** The sentence the Status column and the tooltip show. */
  reason: string;
}

export const HEALTHY_PHASE = "Cluster in healthy state";

/** Phases of a cluster that is converging on its own (SPEC-0001 H1). */
export const PROGRESSING_PHASES: readonly string[] = [
  "Setting up primary",
  "Creating a new replica",
  "Switchover in progress",
  "Failing over",
  "Upgrading cluster",
  "Upgrading Postgres major version",
  "Cluster upgrade delayed",
  "Primary instance is being restarted in-place",
  "Primary instance is being restarted without a switchover",
  "Online upgrade in progress",
  "Applying configuration",
  "Promoting to primary cluster",
  "Waiting for the instances to become active",
];

/** Phases the operator cannot recover from on its own (SPEC-0001 H1). */
export const FAILED_PHASES: readonly string[] = [
  "Cluster cannot proceed to reconciliation due to an unknown plugin being required",
  "Cluster cannot proceed to reconciliation due to an error while interacting with plugins",
  "Cluster has incomplete or invalid image catalog",
  "Cluster is unrecoverable and needs manual intervention",
  "Cluster cannot execute instance online upgrade due to missing architecture binary",
  "Unable to create required cluster objects",
  "Invalid cluster definition",
];

/**
 * Phases that wait for a human (a supervised switchover, for example): the
 * cluster is up but somebody has to act, hence Degraded rather than
 * Progressing or Failed. Not listed by H1; recorded in SPEC-0003 notes.
 */
export const ATTENTION_PHASES: readonly string[] = ["Waiting for user action"];

export const KNOWN_PHASES: readonly string[] = [
  HEALTHY_PHASE,
  ...PROGRESSING_PHASES,
  ...FAILED_PHASES,
  ...ATTENTION_PHASES,
];

const STATE_PRESENTATION: Record<ClusterHealthState, { className: HostStatusClass; token: string }> = {
  Healthy: { className: "success", token: "--colorOk" },
  Progressing: { className: "info", token: "--colorWarning" },
  Degraded: { className: "warning", token: "--colorWarning" },
  Failed: { className: "error", token: "--colorError" },
  Hibernated: { className: "info", token: "--colorTerminated" },
  Unknown: { className: "info", token: "--colorVague" },
};

function health(state: ClusterHealthState, reason: string): ClusterHealth {
  return { state, label: state, reason, ...STATE_PRESENTATION[state] };
}

function conditionSentence(condition: KubeCondition | undefined, fallback: string): string {
  return condition?.message?.trim() || condition?.reason?.trim() || fallback;
}

function phaseSentence(phase: string, phaseReason: string | undefined): string {
  const reason = phaseReason?.trim();
  return reason ? `${phase}: ${reason}` : phase;
}

/** H1: the closed-set state of a cluster, with the sentence that explains it. */
export function classifyCluster(cluster: Cluster): ClusterHealth {
  if (Cluster.getHibernation(cluster)) {
    return health("Hibernated", "Hibernation is on");
  }

  const status = cluster.status;
  const phase = status?.phase?.trim();
  if (!status || !phase) {
    return health("Unknown", "No status reported yet");
  }

  if (FAILED_PHASES.includes(phase)) {
    return health("Failed", phaseSentence(phase, status.phaseReason));
  }
  if (PROGRESSING_PHASES.includes(phase)) {
    return health("Progressing", phaseSentence(phase, status.phaseReason));
  }
  if (!KNOWN_PHASES.includes(phase)) {
    return health("Unknown", `Unknown phase "${phase}"`);
  }

  const ready = Cluster.getCondition(cluster, "Ready");
  if (ready?.status === "False") {
    return health("Failed", conditionSentence(ready, phaseSentence(phase, status.phaseReason)));
  }

  const reasons: string[] = [];
  if (ATTENTION_PHASES.includes(phase)) {
    reasons.push(phaseSentence(phase, status.phaseReason));
  }
  const fenced = Cluster.getFencedInstances(cluster);
  if (fenced.length > 0) {
    reasons.push(`Fenced instances: ${fenced.join(", ")}`);
  }
  const instances = Cluster.getInstances(cluster);
  const readyInstances = Cluster.getReadyInstances(cluster);
  if (readyInstances < instances) {
    reasons.push(`${readyInstances} of ${instances} instances ready`);
  }
  const archiving = Cluster.getCondition(cluster, "ContinuousArchiving");
  if (archiving?.status === "False") {
    reasons.push(conditionSentence(archiving, "WAL archiving is failing"));
  }
  const lastBackup = Cluster.getCondition(cluster, "LastBackupSucceeded");
  if (lastBackup?.status === "False") {
    reasons.push(conditionSentence(lastBackup, "The last backup failed"));
  }
  if (reasons.length > 0) {
    return health("Degraded", reasons.join("; "));
  }

  return health("Healthy", phase);
}

export type ArchivingState = "Archiving" | "Failing" | "Unknown";

export interface ArchivingFacts {
  state: ArchivingState;
  message?: string;
  reason?: string;
}

/** H2: the WAL archiving state from the `ContinuousArchiving` condition. */
export function archivingState(cluster: Cluster): ArchivingFacts {
  const condition = Cluster.getCondition(cluster, "ContinuousArchiving");
  const message = condition?.message?.trim() || undefined;
  const reason = condition?.reason?.trim() || undefined;
  if (condition?.status === "True") return { state: "Archiving", message, reason };
  if (condition?.status === "False") return { state: "Failing", message, reason };
  return { state: "Unknown", message, reason };
}

export type BackupFactsSource = "backups" | "object store" | "status" | "none";

export interface BackupFacts {
  lastSuccessful?: Date;
  lastFailed?: Date;
  /**
   * How far back the cluster can be recovered: what the Barman Cloud plugin
   * reports for the cluster's server when its object store says so, else the
   * earliest completed backup, an approximation of the retention window (H3).
   */
  firstRecoverabilityPoint?: Date;
  /** Where `firstRecoverabilityPoint` comes from. */
  recoverabilitySource?: BackupFactsSource;
  source: BackupFactsSource;
  /** How many `Backup` objects of the cluster were considered. */
  count: number;
}

function backupTime(backup: Backup): Date | undefined {
  return (
    parseGoTime(backup.status?.stoppedAt) ??
    parseGoTime(backup.status?.startedAt) ??
    parseGoTime(backup.metadata?.creationTimestamp)
  );
}

function latest(dates: Array<Date | undefined>): Date | undefined {
  return dates.reduce<Date | undefined>((best, date) => {
    if (!date) return best;
    return !best || date.getTime() > best.getTime() ? date : best;
  }, undefined);
}

function earliest(dates: Array<Date | undefined>): Date | undefined {
  return dates.reduce<Date | undefined>((best, date) => {
    if (!date) return best;
    return !best || date.getTime() < best.getTime() ? date : best;
  }, undefined);
}

/** The `Backup` objects that belong to the cluster (same namespace, `spec.cluster.name`). */
export function backupsOfCluster(cluster: Cluster, backups: readonly Backup[]): Backup[] {
  const name = cluster.metadata?.name;
  const namespace = cluster.metadata?.namespace;
  return backups.filter((backup) => Backup.getClusterName(backup) === name && backup.metadata?.namespace === namespace);
}

/** What the plugin reports for the server the cluster writes under, in the store it names (SPEC-0009). */
function storeWindowOf(cluster: Cluster, stores: readonly ObjectStore[]): ServerRecoveryWindow | undefined {
  const target = storeOfCluster(cluster);
  if (!target) return undefined;
  const store = stores.find(
    (candidate) =>
      candidate.metadata?.name === target.storeName && candidate.metadata?.namespace === cluster.metadata?.namespace,
  );
  return store?.status?.serverRecoveryWindow?.[target.serverName];
}

/**
 * H3: backup facts derived from the `Backup` objects; then from the recovery
 * window the Barman Cloud plugin reports in the cluster's object store (the
 * backups are in the bucket even when their objects were deleted); then from
 * the deprecated status fields. The first recoverability point prefers the
 * plugin's own figure over the earliest `Backup` object, which only
 * approximates it.
 */
export function backupFacts(
  cluster: Cluster,
  backups: readonly Backup[],
  stores: readonly ObjectStore[] = [],
): BackupFacts {
  const own = backupsOfCluster(cluster, backups);
  const window = storeWindowOf(cluster, stores);
  const windowPoint = parseGoTime(window?.firstRecoverabilityPoint);

  if (own.length > 0) {
    const completed = own.filter((backup) => Backup.getPhase(backup) === "completed");
    const failed = own.filter((backup) => Backup.getPhase(backup) === "failed");
    const completedTimes = completed.map((backup) => parseGoTime(backup.status?.stoppedAt) ?? backupTime(backup));
    const approximated = earliest(completedTimes);
    return {
      lastSuccessful: latest(completedTimes),
      lastFailed: latest(failed.map(backupTime)),
      firstRecoverabilityPoint: windowPoint ?? approximated,
      recoverabilitySource: windowPoint ? "object store" : approximated ? "backups" : undefined,
      source: "backups",
      count: own.length,
    };
  }

  const windowSuccess = parseGoTime(window?.lastSuccessfulBackupTime);
  const windowFailure = parseGoTime(window?.lastFailedBackupTime);
  if (windowSuccess || windowFailure || windowPoint) {
    return {
      lastSuccessful: windowSuccess,
      lastFailed: windowFailure,
      firstRecoverabilityPoint: windowPoint,
      recoverabilitySource: windowPoint ? "object store" : undefined,
      source: "object store",
      count: 0,
    };
  }

  const status = cluster.status;
  const lastSuccessful = parseGoTime(status?.lastSuccessfulBackup);
  const lastFailed = parseGoTime(status?.lastFailedBackup);
  const firstRecoverabilityPoint = parseGoTime(status?.firstRecoverabilityPoint);
  const any = lastSuccessful || lastFailed || firstRecoverabilityPoint;
  return {
    lastSuccessful,
    lastFailed,
    firstRecoverabilityPoint,
    recoverabilitySource: firstRecoverabilityPoint ? "status" : undefined,
    source: any ? "status" : "none",
    count: 0,
  };
}

export type CertificateRole = "server CA" | "server TLS" | "client CA" | "replication TLS";
export type CertificateState = "ok" | "expiring" | "expired" | "unknown";

export interface CertificateFact {
  role: CertificateRole;
  secretName?: string;
  expiresAt?: Date;
  state: CertificateState;
}

/** Certificates closer than this to their expiry are "expiring" (H4). */
export const CERTIFICATE_EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const CERTIFICATE_ROLES: ReadonlyArray<{ role: CertificateRole; field: keyof CertificateFields }> = [
  { role: "server CA", field: "serverCASecret" },
  { role: "server TLS", field: "serverTLSSecret" },
  { role: "client CA", field: "clientCASecret" },
  { role: "replication TLS", field: "replicationTLSSecret" },
];

interface CertificateFields {
  serverCASecret?: string;
  serverTLSSecret?: string;
  clientCASecret?: string;
  replicationTLSSecret?: string;
}

/** H4: one entry per known certificate role, classified against `now`. */
export function certificateFacts(cluster: Cluster, now: Date = new Date()): CertificateFact[] {
  const certificates = cluster.status?.certificates;
  return CERTIFICATE_ROLES.map(({ role, field }) => {
    const secretName = certificates?.[field] || undefined;
    const raw = secretName ? certificates?.expirations?.[secretName] : undefined;
    const expiresAt = parseGoTime(raw);
    if (!expiresAt) return { role, secretName, state: "unknown" };
    const remaining = expiresAt.getTime() - now.getTime();
    const state: CertificateState =
      remaining <= 0 ? "expired" : remaining < CERTIFICATE_EXPIRING_WINDOW_MS ? "expiring" : "ok";
    return { role, secretName, expiresAt, state };
  });
}

export type InstanceRole = "primary" | "replica" | "unknown";
export type InstanceHealth = "healthy" | "replicating" | "failed" | "unknown";

export interface InstanceFact {
  name: string;
  role: InstanceRole;
  health: InstanceHealth;
  fenced: boolean;
  /** Node placement is not exported in `status.topology` on 1.30.0; filled from the pods by the drawer. */
  node?: string;
  ip?: string;
  timeline?: number;
}

/** H5: per instance roles, health and fencing from the status and the annotations. */
export function instanceFacts(cluster: Cluster): InstanceFact[] {
  const status = cluster.status;
  const reported = status?.instancesReportedState ?? {};
  const groups = status?.instancesStatus ?? {};
  const names = status?.instanceNames?.length ? status.instanceNames : Object.keys(reported);
  const fenced = new Set(Cluster.getFencedInstances(cluster));
  const primary = Cluster.getPrimary(cluster);

  return names.map((name) => {
    const state = reported[name];
    const inGroup = (group: keyof typeof groups) => groups[group]?.includes(name) ?? false;
    let healthState: InstanceHealth = "unknown";
    if (inGroup("healthy")) healthState = "healthy";
    else if (inGroup("replicating")) healthState = "replicating";
    else if (inGroup("failed")) healthState = "failed";

    // Every named instance that is not the primary is a replica (or about to
    // become one) as soon as a primary is known; without a primary, only an
    // instance the operator reports on can be called a replica.
    let role: InstanceRole = "unknown";
    if (name === primary || state?.isPrimary === true) role = "primary";
    else if (primary !== undefined || state !== undefined || healthState !== "unknown") role = "replica";

    const topologyNode = status?.topology?.instances?.[name]?.node;
    return {
      name,
      role,
      health: healthState,
      fenced: fenced.has(name),
      node: typeof topologyNode === "string" ? topologyNode : undefined,
      ip: state?.ip || undefined,
      timeline: state?.timeLineID,
    };
  });
}
