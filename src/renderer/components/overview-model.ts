/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure aggregation behind the Overview page (SPEC-0004 "Data"): the summary
// strip counters and the ordered cluster tiles, derived only from the objects
// the stores already hold. No JSX, no colors, no network.

import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import {
  type ArchivingFacts,
  archivingState,
  type BackupFacts,
  backupFacts,
  type CertificateFact,
  type ClusterHealth,
  type ClusterHealthState,
  certificateFacts,
  classifyCluster,
  type InstanceFact,
  instanceFacts,
} from "./cluster-health";
import { parseGoTime } from "./go-time";

import type { Backup } from "../api/cnpg/backup-v1";
import type { Cluster } from "../api/cnpg/cluster-v1";

/** A successful backup older than this counts as overdue (SPEC-0004 strip). */
export const BACKUP_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** Tile order by urgency; ties break by namespace and name (SPEC-0004). */
export const STATE_URGENCY: readonly ClusterHealthState[] = [
  "Failed",
  "Degraded",
  "Progressing",
  "Unknown",
  "Healthy",
  "Hibernated",
];

export type CertificateHorizonState = "ok" | "expiring" | "expired" | "unknown";

export interface CertificateHorizon {
  state: CertificateHorizonState;
  /** The earliest expiry among the known certificates, when any parsed. */
  earliest?: Date;
  /** Whole days until `earliest` (negative when expired), when any parsed. */
  daysLeft?: number;
}

export interface ClusterTile {
  id: string;
  name: string;
  namespace: string;
  health: ClusterHealth;
  instances: InstanceFact[];
  declaredInstances: number;
  readyInstances: number;
  primary?: string;
  /** A switchover is in flight when the target differs from the current primary. */
  targetPrimary?: string;
  archiving: ArchivingFacts;
  backups: BackupFacts;
  backupOverdue: boolean;
  certificates: CertificateFact[];
  certificateHorizon: CertificateHorizon;
  nextScheduledBackup?: Date;
  /** Name of the schedule behind `nextScheduledBackup`, so the tile can lead to its drawer. */
  nextScheduleName?: string;
  scheduledBackupSuspended: boolean;
  postgresMajor?: number;
}

export interface OverviewSummary {
  clusters: number;
  byState: Record<ClusterHealthState, number>;
  instancesReady: number;
  instancesTotal: number;
  archivingFailing: number;
  backupsOverdue: number;
  certificatesExpiring: number;
  tiles: ClusterTile[];
}

function emptyByState(): Record<ClusterHealthState, number> {
  return { Healthy: 0, Progressing: 0, Degraded: 0, Failed: 0, Hibernated: 0, Unknown: 0 };
}

/** H4 folded into one horizon per cluster: the worst state and the earliest expiry. */
export function certificateHorizon(certificates: readonly CertificateFact[], now: Date): CertificateHorizon {
  const known = certificates.filter((fact) => fact.expiresAt);
  if (known.length === 0) return { state: "unknown" };
  const earliest = known.reduce((best, fact) => {
    const expiresAt = fact.expiresAt as Date;
    return expiresAt.getTime() < best.getTime() ? expiresAt : best;
  }, known[0].expiresAt as Date);
  const daysLeft = Math.floor((earliest.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const state: CertificateHorizonState = known.some((fact) => fact.state === "expired")
    ? "expired"
    : known.some((fact) => fact.state === "expiring")
      ? "expiring"
      : "ok";
  return { state, earliest, daysLeft };
}

/**
 * Whether the cluster is missing a recent successful backup: never backed up,
 * or the last success is older than `BACKUP_OVERDUE_MS`. Hibernated clusters
 * are never overdue (nothing runs), and a cluster without any backup
 * configuration is judged like any other: the operator is expected to
 * schedule backups.
 */
export function isBackupOverdue(health: ClusterHealth, facts: BackupFacts, now: Date): boolean {
  if (health.state === "Hibernated") return false;
  if (!facts.lastSuccessful) return true;
  return now.getTime() - facts.lastSuccessful.getTime() > BACKUP_OVERDUE_MS;
}

function nextScheduledBackup(cluster: Cluster, schedules: readonly ScheduledBackup[]): ScheduledBackup | undefined {
  const own = schedules.filter(
    (schedule) =>
      ScheduledBackup.getClusterName(schedule) === cluster.metadata?.name &&
      schedule.metadata?.namespace === cluster.metadata?.namespace,
  );
  if (own.length === 0) return undefined;
  // The active schedule with the nearest next run wins; a suspended schedule is
  // reported only when no active one exists.
  const active = own.filter((schedule) => !ScheduledBackup.isSuspended(schedule));
  const candidates = active.length > 0 ? active : own;
  return candidates.reduce<ScheduledBackup | undefined>((best, schedule) => {
    const next = parseGoTime(schedule.status?.nextScheduleTime);
    const bestNext = best ? parseGoTime(best.status?.nextScheduleTime) : undefined;
    if (!next) return best;
    if (!bestNext || next.getTime() < bestNext.getTime()) return schedule;
    return best;
  }, undefined);
}

export function buildTile(
  cluster: Cluster,
  backups: readonly Backup[],
  schedules: readonly ScheduledBackup[],
  now: Date,
): ClusterTile {
  const health = classifyCluster(cluster);
  const facts = backupFacts(cluster, backups);
  const certificates = certificateFacts(cluster, now);
  const schedule = nextScheduledBackup(cluster, schedules);
  const status = cluster.status;
  return {
    id: `${cluster.metadata?.namespace ?? ""}/${cluster.metadata?.name ?? ""}`,
    name: cluster.metadata?.name ?? "",
    namespace: cluster.metadata?.namespace ?? "",
    health,
    instances: instanceFacts(cluster),
    declaredInstances: status?.instances ?? cluster.spec?.instances ?? 0,
    readyInstances: status?.readyInstances ?? 0,
    primary: status?.currentPrimary || undefined,
    targetPrimary:
      status?.targetPrimary && status.targetPrimary !== status.currentPrimary ? status.targetPrimary : undefined,
    archiving: archivingState(cluster),
    backups: facts,
    backupOverdue: isBackupOverdue(health, facts, now),
    certificates,
    certificateHorizon: certificateHorizon(certificates, now),
    nextScheduledBackup: schedule ? parseGoTime(schedule.status?.nextScheduleTime) : undefined,
    nextScheduleName: schedule?.metadata?.name,
    scheduledBackupSuspended: schedule ? ScheduledBackup.isSuspended(schedule) : false,
    postgresMajor: status?.pgDataImageInfo?.majorVersion,
  };
}

export function compareTiles(a: ClusterTile, b: ClusterTile): number {
  const urgency = STATE_URGENCY.indexOf(a.health.state) - STATE_URGENCY.indexOf(b.health.state);
  if (urgency !== 0) return urgency;
  const namespace = a.namespace.localeCompare(b.namespace);
  if (namespace !== 0) return namespace;
  return a.name.localeCompare(b.name);
}

/** The whole Overview in one pass over the stores' contents (SPEC-0004 "Data"). */
export function summarize(
  clusters: readonly Cluster[],
  backups: readonly Backup[],
  schedules: readonly ScheduledBackup[],
  now: Date = new Date(),
): OverviewSummary {
  const tiles = clusters.map((cluster) => buildTile(cluster, backups, schedules, now)).sort(compareTiles);
  const byState = emptyByState();
  let instancesReady = 0;
  let instancesTotal = 0;
  let archivingFailing = 0;
  let backupsOverdue = 0;
  let certificatesExpiring = 0;

  for (const tile of tiles) {
    byState[tile.health.state] += 1;
    instancesReady += tile.readyInstances;
    instancesTotal += tile.declaredInstances;
    if (tile.archiving.state === "Failing") archivingFailing += 1;
    if (tile.backupOverdue) backupsOverdue += 1;
    if (tile.certificateHorizon.state === "expiring" || tile.certificateHorizon.state === "expired") {
      certificatesExpiring += 1;
    }
  }

  return {
    clusters: tiles.length,
    byState,
    instancesReady,
    instancesTotal,
    archivingFailing,
    backupsOverdue,
    certificatesExpiring,
    tiles,
  };
}
