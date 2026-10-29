/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the drawer of a cluster and the cluster list add with SPEC-0034: the
// volumes of the cluster as one table, the jobs that bootstrapped or joined
// its instances, what a replica cluster replicates and how it would be
// promoted, and the counts above the list. Pure: the callers hand in the
// cluster and plain shapes of the host's PVCs and Jobs.

import { Cluster } from "../api/cnpg/cluster-v1";
import { classifyCluster } from "./cluster-health";

import type { ExternalCluster } from "../api/cnpg/cluster-v1";

export const CLUSTER_LABEL = "cnpg.io/cluster";
export const INSTANCE_LABEL = "cnpg.io/instanceName";
export const PVC_ROLE_LABEL = "cnpg.io/pvcRole";
export const TABLESPACE_LABEL = "cnpg.io/tablespaceName";
export const JOB_ROLE_LABEL = "cnpg.io/jobRole";

interface Labelled {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string | undefined> };
}

/** A PersistentVolumeClaim as far as the storage table reads it. */
export interface PvcShape extends Labelled {
  spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } };
  status?: { phase?: string; capacity?: { storage?: string } };
}

/** A Job as far as the jobs section reads it. */
export interface JobShape extends Labelled {
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

function ownedBy(object: Labelled, cluster: Cluster): boolean {
  return (
    object.metadata?.namespace === cluster.getNs() && object.metadata?.labels?.[CLUSTER_LABEL] === cluster.getName()
  );
}

// Storage ---------------------------------------------------------------------

export type VolumeRole = "data" | "WAL" | "tablespace" | "unknown";
export type VolumeState = "healthy" | "resizing" | "initializing" | "dangling" | "unusable" | "unknown";

export interface StorageRow {
  name: string;
  instance?: string;
  role: VolumeRole;
  /** The tablespace a tablespace volume holds. */
  tablespace?: string;
  state: VolumeState;
  requested?: string;
  capacity?: string;
  storageClass?: string;
  /** The claim is in the host's store, so it can be linked. */
  known: boolean;
}

const ROLE_ORDER: Record<VolumeRole, number> = { data: 0, WAL: 1, tablespace: 2, unknown: 3 };

function volumeRole(label: string | undefined): VolumeRole {
  if (label === "PG_DATA") return "data";
  if (label === "PG_WAL") return "WAL";
  if (label === "PG_TABLESPACE") return "tablespace";
  return "unknown";
}

/** The state of a claim from the lists the operator keeps in the cluster's status. */
function volumeState(cluster: Cluster, name: string): VolumeState {
  const status = cluster.status;
  if (status?.unusablePVC?.includes(name)) return "unusable";
  if (status?.danglingPVC?.includes(name)) return "dangling";
  if (status?.resizingPVC?.includes(name)) return "resizing";
  if (status?.initializingPVC?.includes(name)) return "initializing";
  if (status?.healthyPVC?.includes(name)) return "healthy";
  return "unknown";
}

/**
 * Every volume of the cluster: the claims labelled with it, and the ones its
 * status lists that the store does not hold (yet), so a dangling claim is
 * never lost. By instance, data first, then WAL, then the tablespaces.
 */
export function storageRows(cluster: Cluster, claims: readonly PvcShape[]): StorageRow[] {
  const rows = new Map<string, StorageRow>();
  for (const claim of claims) {
    const name = claim.metadata?.name;
    if (!name || !ownedBy(claim, cluster)) continue;
    const labels = claim.metadata?.labels ?? {};
    rows.set(name, {
      name,
      instance: labels[INSTANCE_LABEL],
      role: volumeRole(labels[PVC_ROLE_LABEL]),
      tablespace: labels[TABLESPACE_LABEL],
      state: volumeState(cluster, name),
      requested: claim.spec?.resources?.requests?.storage,
      capacity: claim.status?.capacity?.storage,
      storageClass: claim.spec?.storageClassName,
      known: true,
    });
  }
  const status = cluster.status;
  const listed = [
    ...(status?.healthyPVC ?? []),
    ...(status?.resizingPVC ?? []),
    ...(status?.initializingPVC ?? []),
    ...(status?.danglingPVC ?? []),
    ...(status?.unusablePVC ?? []),
  ];
  for (const name of listed) {
    if (rows.has(name)) continue;
    // The operator names the claims after the instance: `<instance>`, `<instance>-wal`, `<instance>-tbs-<name>`.
    const wal = name.endsWith("-wal");
    const tablespace = /-tbs-(.+)$/.exec(name)?.[1];
    rows.set(name, {
      name,
      instance: name.replace(/-wal$/, "").replace(/-tbs-.+$/, ""),
      role: wal ? "WAL" : tablespace ? "tablespace" : "data",
      tablespace,
      state: volumeState(cluster, name),
      known: false,
    });
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.instance ?? "").localeCompare(b.instance ?? "", undefined, { numeric: true }) ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (a.tablespace ?? "").localeCompare(b.tablespace ?? "") ||
      a.name.localeCompare(b.name),
  );
}

export function volumeRoleWords(row: StorageRow): string {
  if (row.role === "tablespace") return row.tablespace ? `tablespace ${row.tablespace}` : "tablespace";
  return row.role;
}

// Jobs ------------------------------------------------------------------------

/** What each job role of the operator does, in a few words (`cnpg.io/jobRole`). */
export const JOB_ROLE_WORDS: Record<string, string> = {
  initdb: "initdb: creates the first instance with an empty database",
  join: "join: clones the primary into a new instance",
  "full-recovery": "full recovery: restores the first instance from a backup",
  pgbasebackup: "pg_basebackup: clones the first instance from another cluster",
  "snapshot-recovery": "snapshot recovery: restores the first instance from volume snapshots",
  "major-upgrade": "major upgrade: runs pg_upgrade on the data of the primary",
  import: "import: loads the databases of another cluster",
};

export type JobState = "running" | "succeeded" | "failed" | "pending";

export interface JobRow {
  name: string;
  role?: string;
  roleWords: string;
  instance?: string;
  state: JobState;
  message?: string;
  startedAt?: Date;
  /** From the start to the completion, or to now while it runs. */
  durationMs?: number;
}

function jobState(job: JobShape): { state: JobState; message?: string } {
  const conditions = job.status?.conditions ?? [];
  const failed = conditions.find((condition) => condition.type === "Failed" && condition.status === "True");
  if (failed || ((job.status?.failed ?? 0) > 0 && !(job.status?.active ?? 0))) {
    return { state: "failed", message: failed?.message };
  }
  if (conditions.some((condition) => condition.type === "Complete" && condition.status === "True")) {
    return { state: "succeeded" };
  }
  if ((job.status?.succeeded ?? 0) > 0) return { state: "succeeded" };
  if ((job.status?.active ?? 0) > 0) return { state: "running" };
  return { state: "pending" };
}

function parseTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time;
}

/**
 * The jobs of the cluster, the newest first. The operator removes a finished
 * bootstrap or join job, so the section lives only while one exists.
 */
export function jobRows(cluster: Cluster, jobs: readonly JobShape[], now: Date = new Date()): JobRow[] {
  return jobs
    .filter((job) => job.metadata?.name && ownedBy(job, cluster))
    .map((job) => {
      const labels = job.metadata?.labels ?? {};
      const role = labels[JOB_ROLE_LABEL];
      const startedAt = parseTime(job.status?.startTime);
      const end = parseTime(job.status?.completionTime) ?? now;
      const { state, message } = jobState(job);
      return {
        name: job.metadata?.name ?? "",
        role,
        roleWords: (role && JOB_ROLE_WORDS[role]) ?? role ?? "a job of the operator",
        instance: labels[INSTANCE_LABEL],
        state,
        message,
        startedAt,
        durationMs: startedAt ? Math.max(0, end.getTime() - startedAt.getTime()) : undefined,
      };
    })
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
}

// Replica cluster -------------------------------------------------------------

export interface ReplicaClusterFacts {
  /** The external cluster it replicates, as `spec.replica.source` names it. */
  source?: string;
  /** How the source is reached: an object store, a connection, or both. */
  sourceWords?: string;
  /** In a distributed topology, the cluster that is the primary of the group (`spec.replica.primary`). */
  groupPrimary?: string;
  /** This cluster's own name in the group (`spec.replica.self`). */
  self?: string;
  /** Under a distributed topology the replica role follows from `primary` and `self`. */
  distributed: boolean;
  /** The instance that replicates from the source and feeds the others: the designated primary. */
  designatedPrimary?: string;
  minApplyDelay?: string;
  promotionToken?: string;
  demotionToken?: string;
}

function externalClusterWords(external: ExternalCluster | undefined): string | undefined {
  if (!external) return undefined;
  const parts: string[] = [];
  const plugin = external.plugin as { name?: string; parameters?: Record<string, string> } | undefined;
  if (plugin?.parameters?.barmanObjectName) {
    parts.push(`object store ${plugin.parameters.barmanObjectName} (${plugin.name ?? "plugin"})`);
  } else if (plugin?.name) {
    parts.push(`plugin ${plugin.name}`);
  }
  if (external.barmanObjectStore) parts.push("an in-tree barmanObjectStore (deprecated)");
  const host = external.connectionParameters?.host;
  if (host) parts.push(`streaming from ${host}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Undefined unless the cluster is a replica cluster, or in a distributed topology. */
export function replicaClusterFacts(cluster: Cluster): ReplicaClusterFacts | undefined {
  const replica = cluster.spec?.replica;
  const distributed = Boolean(replica?.primary && replica?.self);
  const isReplica = distributed ? replica?.primary !== replica?.self : Boolean(replica?.enabled);
  if (!replica || !isReplica) return undefined;
  const source = replica.source;
  const external = (cluster.spec?.externalClusters ?? []).find((entry) => entry.name === source);
  return {
    source,
    sourceWords: externalClusterWords(external),
    groupPrimary: replica.primary,
    self: replica.self,
    distributed,
    designatedPrimary: Cluster.getPrimary(cluster),
    minApplyDelay: replica.minApplyDelay,
    promotionToken: replica.promotionToken || undefined,
    demotionToken: (cluster.status as { demotionToken?: string } | undefined)?.demotionToken || undefined,
  };
}

// Counts ----------------------------------------------------------------------

/** The filters of the counts above the cluster list. */
export type ClusterCountFilter = "healthy" | "hibernated" | "attention";

export interface ClusterCounts {
  clusters: number;
  healthy: number;
  hibernated: number;
  /** Any state of the health model but healthy and hibernated (SPEC-0001). */
  attention: number;
  instancesReady: number;
  instances: number;
}

export function countFilterMatches(cluster: Cluster, filter: ClusterCountFilter): boolean {
  const state = classifyCluster(cluster).state;
  if (filter === "healthy") return state === "Healthy";
  if (filter === "hibernated") return state === "Hibernated";
  return state !== "Healthy" && state !== "Hibernated";
}

export function clusterCounts(clusters: readonly Cluster[]): ClusterCounts {
  const counts: ClusterCounts = {
    clusters: clusters.length,
    healthy: 0,
    hibernated: 0,
    attention: 0,
    instancesReady: 0,
    instances: 0,
  };
  for (const cluster of clusters) {
    if (countFilterMatches(cluster, "healthy")) counts.healthy += 1;
    else if (countFilterMatches(cluster, "hibernated")) counts.hibernated += 1;
    else counts.attention += 1;
    counts.instancesReady += Cluster.getReadyInstances(cluster);
    counts.instances += Cluster.getInstances(cluster);
  }
  return counts;
}
