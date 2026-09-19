/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the live database view (SPEC-0006 "Contracts and parsers"):
// from what each instance answered on its status and metrics endpoints to the
// replication topology, the sessions, the databases, WAL and archiving, the
// replication slots and the instance manager facts. No JSX, no colors, no
// clock of its own: the page is a thin shell over `buildLiveView`.

import { parseStatusTime, statusPodName } from "../../api/instance/postgresql-status";
import { selectSamples, singleValue } from "../../api/instance/prometheus-text";
import { lsnDistance } from "../lsn";
import { parsePgInterval } from "../pg-interval";

import type { ProxyFailure } from "../../api/instance/pod-proxy";
import type { BasebackupInfo, PostgresqlStatus } from "../../api/instance/postgresql-status";
import type { MetricSample } from "../../api/instance/prometheus-text";

/** A standby this far behind is worth a warning: by time or by bytes of WAL. */
export const LAG_WARNING_MS = 10_000;
export const LAG_WARNING_BYTES = 64n * 1024n * 1024n;
/** A transaction open for longer than this holds back vacuum and deserves a look. */
export const LONG_TRANSACTION_SECONDS = 5 * 60;
/** More WAL files than this waiting for the archiver means the archive is falling behind. */
export const READY_WAL_WARNING = 10;
/** Transaction ID age: autovacuum should keep it far below; the wraparound limit is about 2.1 billion. */
export const XID_AGE_WARNING = 1_000_000_000;
export const XID_AGE_ERROR = 1_500_000_000;
/** How many databases and users the sessions tile lists. */
export const TOP_SESSIONS = 10;

/** Sessions the platform itself keeps open: replication and the metrics exporter. */
const SYSTEM_USERS: readonly string[] = ["streaming_replica", "cnpg_metrics_exporter"];

export type Level = "ok" | "warning" | "error";

export type Reading<T> = { ok: true; value: T } | { ok: false; failure: ProxyFailure };

export interface InstanceReading {
  /** Absent until the first answer (or failure) arrives. */
  status?: Reading<PostgresqlStatus>;
  metrics?: Reading<MetricSample[]>;
}

export interface InstanceSeed {
  name: string;
  fenced: boolean;
  node?: string;
}

export interface LiveInput {
  /** The instances the cluster declares, from the health model. */
  instances: readonly InstanceSeed[];
  /** `Cluster.status.currentPrimary`. */
  declaredPrimary?: string;
  readings: ReadonlyMap<string, InstanceReading>;
}

export type LiveRole = "primary" | "standby" | "unknown";

export interface LiveInstance {
  name: string;
  role: LiveRole;
  node?: string;
  timeline?: number;
  /** Current LSN on the primary, replay LSN on a standby. */
  lsn?: string;
  receivedLsn?: string;
  fenced: boolean;
  /** The instance manager answered, PostgreSQL did not: the reason it gave. */
  postgresDown?: string;
  /** The status endpoint could not be read at all. */
  statusFailure?: ProxyFailure;
  /** Still waiting for the first answer. */
  pending: boolean;
  /** Short facts shown as badges: "pending restart", "replay paused"... */
  flags: string[];
  managerVersion?: string;
  arch?: string;
}

export interface LiveEdge {
  standby: string;
  streaming: boolean;
  state: string;
  syncState?: string;
  syncPriority?: number;
  writeLagMs?: number;
  flushLagMs?: number;
  replayLagMs?: number;
  /** WAL the standby still has to replay, in bytes. */
  replayBytes?: bigint;
  level: Level;
}

export interface SessionsView {
  total: number;
  user: number;
  system: number;
  primary: number;
  standbys: number;
  byState: Array<{ state: string; count: number }>;
  waiting: number;
  longestTransactionSeconds?: number;
  longestTransactionLevel: Level;
  maxConnections?: number;
  topDatabases: Array<{ name: string; count: number }>;
  topUsers: Array<{ name: string; count: number }>;
}

export interface DatabaseView {
  name: string;
  sizeBytes?: number;
  /** Share of the largest database, 0 to 1, for the proportional bar. */
  share: number;
  xidAge?: number;
  level: Level;
}

export type LiveArchivingState = "Archiving" | "Failing" | "Unknown";

export interface WalView {
  state: LiveArchivingState;
  currentWal?: string;
  lastArchivedWal?: string;
  lastArchivedAt?: Date;
  lastFailedWal?: string;
  lastFailedAt?: Date;
  readyFiles?: number;
  readyLevel: Level;
  archivedCount?: number;
  failedCount?: number;
  walSizeBytes?: number;
  walFiles?: number;
  volumeSizeBytes?: number;
  volumeMaxBytes?: number;
}

export interface SlotView {
  name: string;
  type?: string;
  active: boolean;
  restartLsn?: string;
  retainedBytes?: number;
  walStatus?: string;
  /** An inactive slot that holds WAL back is how a disk fills. */
  level: Level;
}

export interface ManagerView {
  instances: Array<{ name: string; version?: string; arch?: string; upgrading: boolean }>;
  /** True when the instances do not all run the same instance manager. */
  skew: boolean;
}

export interface LiveView {
  instances: LiveInstance[];
  /** The instance that says it is the primary. */
  primary?: string;
  /** Set when the instances and `Cluster.status` disagree about who the primary is. */
  primaryDisagreement?: string;
  edges: LiveEdge[];
  /** Observed synchronous standbys below the configured minimum. */
  syncWarning?: string;
  sessions?: SessionsView;
  databases: DatabaseView[];
  wal?: WalView;
  slots: SlotView[];
  basebackups: BasebackupInfo[];
  manager: ManagerView;
  /** True when every instance failed with a missing permission: one panel, not one per tile. */
  forbidden: boolean;
  /** True when no instance has answered anything yet. */
  pending: boolean;
}

function flagsOf(status: PostgresqlStatus, fenced: boolean): string[] {
  const flags: string[] = [];
  if (fenced) flags.push("fenced");
  if (status.pendingRestart) flags.push("pending restart");
  if (status.replayPaused) flags.push("replay paused");
  if (status.isPgRewindRunning) flags.push("pg_rewind running");
  if (status.isInstanceManagerUpgrading) flags.push("manager upgrading");
  if (!status.isPrimary && status.isWalReceiverActive === false && !status.mightBeUnavailable) {
    flags.push("WAL receiver down");
  }
  return flags;
}

function firstLine(text: string | undefined): string | undefined {
  return text?.trim().split("\n")[0]?.trim() || undefined;
}

function buildInstance(seed: InstanceSeed, reading: InstanceReading | undefined): LiveInstance {
  const base: LiveInstance = {
    name: seed.name,
    role: "unknown",
    node: seed.node,
    fenced: seed.fenced,
    pending: !reading?.status,
    flags: seed.fenced ? ["fenced"] : [],
  };
  const status = reading?.status;
  if (!status) return base;
  if (!status.ok) return { ...base, statusFailure: status.failure };

  const value = status.value;
  // When PostgreSQL is down the manager cannot tell the role: it answers
  // `isPrimary: true` with an empty system ID (observed on a fenced instance).
  const down = value.mightBeUnavailable
    ? (firstLine(value.mightBeUnavailableMaskedError) ?? "PostgreSQL does not answer on this instance")
    : undefined;
  return {
    ...base,
    role: down ? "unknown" : value.isPrimary ? "primary" : "standby",
    node: value.node || seed.node,
    timeline: value.timeLineID,
    lsn: value.isPrimary ? value.currentLsn : value.replayLsn,
    receivedLsn: value.receivedLsn,
    postgresDown: down,
    flags: flagsOf(value, seed.fenced),
    managerVersion: value.instanceManagerVersion,
    arch: value.instanceArch,
  };
}

function lagLevel(streaming: boolean, replayLagMs: number | undefined, replayBytes: bigint | undefined): Level {
  if (!streaming) return "error";
  if (replayLagMs !== undefined && replayLagMs > LAG_WARNING_MS) return "warning";
  if (replayBytes !== undefined && replayBytes > LAG_WARNING_BYTES) return "warning";
  return "ok";
}

function buildEdges(primary: PostgresqlStatus | undefined, instances: readonly LiveInstance[]): LiveEdge[] {
  const standbys = instances.filter((instance) => instance.role === "standby");
  const listed = new Map((primary?.replicationInfo ?? []).map((info) => [info.applicationName ?? "", info] as const));
  const edges: LiveEdge[] = [];

  for (const standby of standbys) {
    const info = listed.get(standby.name);
    if (!info) {
      // The standby answers but the primary does not list it: drawn detached.
      edges.push({ standby: standby.name, streaming: false, state: "not streaming", level: "error" });
      continue;
    }
    const streaming = info.state === "streaming";
    const replayLagMs = parsePgInterval(info.replayLag);
    const distance = lsnDistance(info.replayLsn, primary?.currentLsn);
    const replayBytes = distance !== undefined && distance >= 0n ? distance : undefined;
    const priority = Number(info.syncPriority);
    edges.push({
      standby: standby.name,
      streaming,
      state: info.state ?? "unknown",
      syncState: info.syncState,
      syncPriority: Number.isFinite(priority) ? priority : undefined,
      writeLagMs: parsePgInterval(info.writeLag),
      flushLagMs: parsePgInterval(info.flushLag),
      replayLagMs,
      replayBytes,
      level: lagLevel(streaming, replayLagMs, replayBytes),
    });
  }

  // A standby the primary streams to but that did not answer still has an edge.
  for (const [name, info] of listed) {
    if (!name || edges.some((edge) => edge.standby === name)) continue;
    if (!instances.some((instance) => instance.name === name)) continue;
    const streaming = info.state === "streaming";
    const replayLagMs = parsePgInterval(info.replayLag);
    edges.push({
      standby: name,
      streaming,
      state: info.state ?? "unknown",
      syncState: info.syncState,
      replayLagMs,
      level: lagLevel(streaming, replayLagMs, undefined),
    });
  }

  // The worst first: what needs the eye leads.
  const rank: Record<Level, number> = { error: 0, warning: 1, ok: 2 };
  return edges.sort(
    (a, b) =>
      rank[a.level] - rank[b.level] ||
      (b.replayLagMs ?? 0) - (a.replayLagMs ?? 0) ||
      a.standby.localeCompare(b.standby),
  );
}

function tally(samples: readonly MetricSample[], label: string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.labels[label] || "(none)";
    counts.set(key, (counts.get(key) ?? 0) + sample.value);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildSessions(
  metricsByInstance: ReadonlyMap<string, MetricSample[]>,
  primary: string | undefined,
): SessionsView | undefined {
  if (metricsByInstance.size === 0) return undefined;

  const backends: MetricSample[] = [];
  let primaryTotal = 0;
  let standbyTotal = 0;
  let waiting = 0;
  let longest: number | undefined;
  for (const [name, samples] of metricsByInstance) {
    const own = selectSamples(samples, "cnpg_backends_total").filter((sample) => Number.isFinite(sample.value));
    backends.push(...own);
    const sum = own.reduce((total, sample) => total + sample.value, 0);
    if (name === primary) primaryTotal += sum;
    else standbyTotal += sum;
    waiting += singleValue(samples, "cnpg_backends_waiting_total") ?? 0;
    for (const sample of selectSamples(samples, "cnpg_backends_max_tx_duration_seconds")) {
      // The platform's own sessions (replication) are long lived by design.
      if (SYSTEM_USERS.includes(sample.labels.usename ?? "") || !Number.isFinite(sample.value)) continue;
      longest = Math.max(longest ?? 0, sample.value);
    }
  }

  const system = backends.filter((sample) => SYSTEM_USERS.includes(sample.labels.usename ?? ""));
  const user = backends.filter((sample) => !SYSTEM_USERS.includes(sample.labels.usename ?? ""));
  const sum = (samples: readonly MetricSample[]) => samples.reduce((total, sample) => total + sample.value, 0);
  const primarySamples = primary ? metricsByInstance.get(primary) : undefined;

  return {
    total: sum(backends),
    user: sum(user),
    system: sum(system),
    primary: primaryTotal,
    standbys: standbyTotal,
    byState: tally(backends, "state").map(({ name, count }) => ({ state: name, count })),
    waiting,
    longestTransactionSeconds: longest,
    longestTransactionLevel: longest !== undefined && longest > LONG_TRANSACTION_SECONDS ? "warning" : "ok",
    maxConnections: primarySamples
      ? singleValue(primarySamples, "cnpg_pg_settings_setting", { name: "max_connections" })
      : undefined,
    topDatabases: tally(user, "datname").slice(0, TOP_SESSIONS),
    topUsers: tally(user, "usename").slice(0, TOP_SESSIONS),
  };
}

function xidLevel(age: number | undefined): Level {
  if (age === undefined) return "ok";
  if (age > XID_AGE_ERROR) return "error";
  return age > XID_AGE_WARNING ? "warning" : "ok";
}

/** From the primary only: every instance holds its own copy of the same databases. */
function buildDatabases(samples: readonly MetricSample[] | undefined): DatabaseView[] {
  if (!samples) return [];
  const sizes = selectSamples(samples, "cnpg_pg_database_size_bytes");
  const largest = Math.max(0, ...sizes.map((sample) => (Number.isFinite(sample.value) ? sample.value : 0)));
  return sizes
    .map((sample) => {
      const name = sample.labels.datname ?? "";
      const xidAge = singleValue(samples, "cnpg_pg_database_xid_age", { datname: name });
      const sizeBytes = Number.isFinite(sample.value) ? sample.value : undefined;
      return {
        name,
        sizeBytes,
        share: largest > 0 && sizeBytes !== undefined ? sizeBytes / largest : 0,
        xidAge,
        level: xidLevel(xidAge),
      };
    })
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.name.localeCompare(b.name));
}

function buildWal(
  status: PostgresqlStatus | undefined,
  samples: readonly MetricSample[] | undefined,
): WalView | undefined {
  if (!status && !samples) return undefined;
  const lastArchivedAt = parseStatusTime(status?.lastArchivedWALTime);
  const lastFailedAt = parseStatusTime(status?.lastFailedWALTime);
  // H2 refined: a failure newer than the last success is a failing archive,
  // whatever the condition on the Cluster still says.
  let state: LiveArchivingState = "Unknown";
  if (lastFailedAt && (!lastArchivedAt || lastFailedAt.getTime() > lastArchivedAt.getTime())) state = "Failing";
  else if (lastArchivedAt) state = "Archiving";

  const readyFiles =
    status?.readyWalFiles ??
    (samples ? singleValue(samples, "cnpg_collector_pg_wal_archive_status", { value: "ready" }) : undefined);
  const wal = (value: string) => (samples ? singleValue(samples, "cnpg_collector_pg_wal", { value }) : undefined);
  return {
    state,
    currentWal: status?.currentWAL || undefined,
    lastArchivedWal: status?.lastArchivedWAL || undefined,
    lastArchivedAt,
    lastFailedWal: status?.lastFailedWAL || undefined,
    lastFailedAt,
    readyFiles,
    readyLevel: readyFiles !== undefined && readyFiles > READY_WAL_WARNING ? "warning" : "ok",
    archivedCount: samples ? singleValue(samples, "cnpg_pg_stat_archiver_archived_count") : undefined,
    failedCount: samples ? singleValue(samples, "cnpg_pg_stat_archiver_failed_count") : undefined,
    walSizeBytes: wal("size"),
    walFiles: wal("count"),
    volumeSizeBytes: wal("volume_size"),
    volumeMaxBytes: wal("volume_max"),
  };
}

function buildSlots(status: PostgresqlStatus | undefined, samples: readonly MetricSample[] | undefined): SlotView[] {
  return (status?.replicationSlotsInfo ?? [])
    .map((slot) => {
      const name = slot.slotName ?? "";
      const retainedBytes = samples
        ? singleValue(samples, "cnpg_pg_replication_slots_pg_wal_lsn_diff", { slot_name: name })
        : undefined;
      const active = slot.active ?? false;
      const level: Level = !active && (retainedBytes ?? 0) > 0 ? "warning" : "ok";
      return {
        name,
        type: slot.slotType,
        active,
        restartLsn: slot.restartLsn,
        retainedBytes,
        walStatus: slot.walStatus,
        level,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildLiveView({ instances: seeds, declaredPrimary, readings }: LiveInput): LiveView {
  const instances = seeds.map((seed) => buildInstance(seed, readings.get(seed.name)));

  const statuses = new Map<string, PostgresqlStatus>();
  const metricsByInstance = new Map<string, MetricSample[]>();
  for (const seed of seeds) {
    const reading = readings.get(seed.name);
    if (reading?.status?.ok) statuses.set(statusPodName(reading.status.value) ?? seed.name, reading.status.value);
    if (reading?.metrics?.ok) metricsByInstance.set(seed.name, reading.metrics.value);
  }

  const primaries = instances.filter((instance) => instance.role === "primary").map((instance) => instance.name);
  const primary = primaries.includes(declaredPrimary ?? "") ? declaredPrimary : primaries[0];
  let primaryDisagreement: string | undefined;
  if (primaries.length > 1) {
    primaryDisagreement = `More than one instance says it is the primary: ${primaries.join(", ")}`;
  } else if (primary && declaredPrimary && primary !== declaredPrimary) {
    primaryDisagreement = `${primary} says it is the primary while the cluster status names ${declaredPrimary}`;
  }

  const primaryStatus = primary ? statuses.get(primary) : undefined;
  const primaryMetrics = primary ? metricsByInstance.get(primary) : undefined;

  let syncWarning: string | undefined;
  if (primaryMetrics) {
    const observed = singleValue(primaryMetrics, "cnpg_collector_sync_replicas", { value: "observed" });
    const minimum = singleValue(primaryMetrics, "cnpg_collector_sync_replicas", { value: "min" });
    if (observed !== undefined && minimum !== undefined && observed < minimum) {
      syncWarning = `${observed} synchronous standbys observed, ${minimum} required`;
    }
  }

  const managerInstances = instances.map((instance) => ({
    name: instance.name,
    version: instance.managerVersion,
    arch: instance.arch,
    upgrading: instance.flags.includes("manager upgrading"),
  }));
  const versions = new Set(managerInstances.map((entry) => entry.version).filter(Boolean));

  const failures = seeds.map((seed) => readings.get(seed.name)?.status).filter((status) => status && !status.ok);
  const forbidden =
    seeds.length > 0 &&
    failures.length === seeds.length &&
    failures.every((status) => status && !status.ok && status.failure.kind === "forbidden");

  return {
    instances,
    primary,
    primaryDisagreement,
    edges: buildEdges(primaryStatus, instances),
    syncWarning,
    sessions: buildSessions(metricsByInstance, primary),
    databases: buildDatabases(primaryMetrics),
    wal: primary ? buildWal(primaryStatus, primaryMetrics) : undefined,
    slots: buildSlots(primaryStatus, primaryMetrics),
    basebackups: primaryStatus?.pgStatBasebackupsInfo ?? [],
    manager: { instances: managerInstances, skew: versions.size > 1 },
    forbidden,
    pending: seeds.length > 0 && seeds.every((seed) => !readings.get(seed.name)?.status),
  };
}
