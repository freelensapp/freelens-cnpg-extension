/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The memory and the arithmetic of the Trends section (SPEC-0028): what is
// kept from every round of the poller, the rates and ratios over the
// counters of PostgreSQL with their resets handled, the window of a range,
// and the datasets of the nine cards with their theme tokens. Pure: the
// section renders what these functions decide.

import { selectSamples } from "../../api/instance/prometheus-text";

import type { MetricSample } from "../../api/instance/prometheus-text";
import type { InstanceReading } from "./live-model";

/** An hour at the five second status interval. */
export const STATUS_CAPACITY = 720;
/** An hour at the thirty second exporter cache. */
export const METRICS_CAPACITY = 120;

export type TrendRange = "5m" | "15m" | "1h" | "all";

export const TREND_RANGES: ReadonlyArray<{ value: TrendRange; label: string; seconds: number }> = [
  { value: "5m", label: "5 min", seconds: 5 * 60 },
  { value: "15m", label: "15 min", seconds: 15 * 60 },
  { value: "1h", label: "1 h", seconds: 60 * 60 },
  { value: "all", label: "since opened", seconds: Number.POSITIVE_INFINITY },
];

export const SESSION_STATES = ["active", "idle", "idle in transaction", "other"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface MetricsSnapshot {
  /** The time of the exporter's cache when it says it, else the time of the read. */
  time: number;
  /** The exporter's cache generation, so a cached reading read twice makes one point. */
  generation?: number;
  xactCommit?: number;
  xactRollback?: number;
  blksHit?: number;
  blksRead?: number;
  archived?: number;
  archiveFailed?: number;
  walSizeBytes?: number;
  walFiles?: number;
  checkpointsTimed?: number;
  checkpointsRequested?: number;
  deadlocks?: number;
  tempBytes?: number;
  databaseSizes: Record<string, number>;
  /** The backends of every instance that answered, by state. */
  sessions: Record<SessionState, number>;
}

export interface LagSnapshot {
  time: number;
  /** Replay lag in milliseconds per standby, as the primary reports it. */
  lag: Record<string, number>;
}

export interface TrendMemory {
  startedAt: number;
  metrics: MetricsSnapshot[];
  lags: LagSnapshot[];
}

export function createTrendMemory(startedAt: number): TrendMemory {
  return { startedAt, metrics: [], lags: [] };
}

const TEMPLATES = new Set(["template0", "template1"]);

function sum(samples: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number | undefined {
  const matching = selectSamples(samples, name, labels).filter(
    (sample) => !TEMPLATES.has(sample.labels.datname ?? "") && Number.isFinite(sample.value),
  );
  if (matching.length === 0) return undefined;
  return matching.reduce((total, sample) => total + sample.value, 0);
}

function one(samples: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number | undefined {
  const sample = selectSamples(samples, name, labels).find((candidate) => Number.isFinite(candidate.value));
  return sample?.value;
}

function sessionState(state: string): SessionState {
  if (state === "active" || state === "idle") return state;
  if (state === "idle in transaction") return state;
  return "other";
}

/** The backends of one instance by state, the exporter's own and the WAL senders included as PostgreSQL counts them. */
export function sessionsByState(samples: readonly MetricSample[]): Record<SessionState, number> {
  const result: Record<SessionState, number> = { active: 0, idle: 0, "idle in transaction": 0, other: 0 };
  for (const sample of selectSamples(samples, "cnpg_backends_total")) {
    if (!Number.isFinite(sample.value)) continue;
    result[sessionState(sample.labels.state ?? "")] += sample.value;
  }
  return result;
}

/** The snapshot of one metrics round: the primary's counters and gauges, the sessions of every instance. */
export function metricsSnapshot(
  time: number,
  primaryPod: string | undefined,
  readings: ReadonlyMap<string, InstanceReading>,
): MetricsSnapshot | undefined {
  const primary = primaryPod ? readings.get(primaryPod)?.metrics : undefined;
  if (!primary || !primary.ok) return undefined;
  const samples = primary.value;
  const generation = one(samples, "cnpg_last_update_timestamp");
  const sessions: Record<SessionState, number> = { active: 0, idle: 0, "idle in transaction": 0, other: 0 };
  for (const reading of readings.values()) {
    if (!reading.metrics?.ok) continue;
    const own = sessionsByState(reading.metrics.value);
    for (const state of SESSION_STATES) sessions[state] += own[state];
  }
  const databaseSizes: Record<string, number> = {};
  for (const sample of selectSamples(samples, "cnpg_pg_database_size_bytes")) {
    const name = sample.labels.datname ?? "";
    if (name === "" || TEMPLATES.has(name) || !Number.isFinite(sample.value)) continue;
    databaseSizes[name] = sample.value;
  }
  return {
    time: generation !== undefined && generation > 0 ? generation * 1000 : time,
    generation,
    xactCommit: sum(samples, "cnpg_pg_stat_database_xact_commit"),
    xactRollback: sum(samples, "cnpg_pg_stat_database_xact_rollback"),
    blksHit: sum(samples, "cnpg_pg_stat_database_blks_hit"),
    blksRead: sum(samples, "cnpg_pg_stat_database_blks_read"),
    archived: one(samples, "cnpg_pg_stat_archiver_archived_count"),
    archiveFailed: one(samples, "cnpg_pg_stat_archiver_failed_count"),
    walSizeBytes: one(samples, "cnpg_collector_pg_wal", { value: "size" }),
    walFiles: one(samples, "cnpg_collector_pg_wal", { value: "count" }),
    checkpointsTimed:
      one(samples, "cnpg_pg_stat_checkpointer_checkpoints_timed") ??
      one(samples, "cnpg_pg_stat_bgwriter_checkpoints_timed"),
    checkpointsRequested:
      one(samples, "cnpg_pg_stat_checkpointer_checkpoints_req") ??
      one(samples, "cnpg_pg_stat_bgwriter_checkpoints_req"),
    deadlocks: sum(samples, "cnpg_pg_stat_database_deadlocks"),
    tempBytes: sum(samples, "cnpg_pg_stat_database_temp_bytes"),
    databaseSizes,
    sessions,
  };
}

/** Appends the snapshot of the round, unless it is the cached reading already kept. True when a point was added. */
export function ingestMetrics(
  memory: TrendMemory,
  time: number,
  primaryPod: string | undefined,
  readings: ReadonlyMap<string, InstanceReading>,
): boolean {
  const snapshot = metricsSnapshot(time, primaryPod, readings);
  if (!snapshot) return false;
  const last = memory.metrics[memory.metrics.length - 1];
  if (last) {
    if (snapshot.generation !== undefined && snapshot.generation === last.generation) return false;
    if (snapshot.time <= last.time) return false;
  }
  memory.metrics = [...memory.metrics, snapshot].slice(-METRICS_CAPACITY);
  return true;
}

/** Appends the replay lag of every standby the primary reports. */
export function ingestLag(
  memory: TrendMemory,
  time: number,
  edges: ReadonlyArray<{ standby: string; replayLagMs?: number }>,
): void {
  const lag: Record<string, number> = {};
  for (const edge of edges)
    if (edge.replayLagMs !== undefined && Number.isFinite(edge.replayLagMs)) lag[edge.standby] = edge.replayLagMs;
  const last = memory.lags[memory.lags.length - 1];
  if (last && time <= last.time) return;
  memory.lags = [...memory.lags, { time, lag }].slice(-STATUS_CAPACITY);
}

export interface Point {
  x: number;
  y: number;
}

type CounterKey =
  | "xactCommit"
  | "xactRollback"
  | "blksHit"
  | "blksRead"
  | "archived"
  | "archiveFailed"
  | "checkpointsTimed"
  | "checkpointsRequested"
  | "deadlocks"
  | "tempBytes";

/** The difference of a counter between consecutive snapshots, at the time of the later one; a counter that went down gives no point. */
export function deltas(snapshots: readonly MetricsSnapshot[], key: CounterKey): Point[] {
  const points: Point[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const before = snapshots[index - 1][key];
    const after = snapshots[index][key];
    if (before === undefined || after === undefined || after < before) continue;
    points.push({ x: snapshots[index].time, y: after - before });
  }
  return points;
}

/** The rate per second of a counter between consecutive snapshots. */
export function rates(snapshots: readonly MetricsSnapshot[], key: CounterKey): Point[] {
  const points: Point[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const before = snapshots[index - 1];
    const after = snapshots[index];
    const seconds = (after.time - before.time) / 1000;
    if (before[key] === undefined || after[key] === undefined || seconds <= 0) continue;
    const delta = (after[key] as number) - (before[key] as number);
    if (delta < 0) continue;
    points.push({ x: after.time, y: delta / seconds });
  }
  return points;
}

/** The cache hit ratio of each interval, in percent; an interval that read no block gives no point. */
export function cacheHitRatio(snapshots: readonly MetricsSnapshot[]): Point[] {
  const points: Point[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const before = snapshots[index - 1];
    const after = snapshots[index];
    if (
      before.blksHit === undefined ||
      after.blksHit === undefined ||
      before.blksRead === undefined ||
      after.blksRead === undefined
    )
      continue;
    const hit = after.blksHit - before.blksHit;
    const read = after.blksRead - before.blksRead;
    if (hit < 0 || read < 0 || hit + read === 0) continue;
    points.push({ x: after.time, y: (100 * hit) / (hit + read) });
  }
  return points;
}

/** A gauge of the snapshots as points. */
export function gauge(
  snapshots: readonly MetricsSnapshot[],
  read: (snapshot: MetricsSnapshot) => number | undefined,
): Point[] {
  const points: Point[] = [];
  for (const snapshot of snapshots) {
    const value = read(snapshot);
    if (value !== undefined && Number.isFinite(value)) points.push({ x: snapshot.time, y: value });
  }
  return points;
}

/** The points inside the range, and the axis the range spans. */
export function window(
  points: readonly Point[],
  range: TrendRange,
  now: number,
  startedAt: number,
): { points: Point[]; minTime: number; maxTime: number } {
  const seconds = TREND_RANGES.find((candidate) => candidate.value === range)?.seconds ?? Number.POSITIVE_INFINITY;
  const from = Number.isFinite(seconds) ? now - seconds * 1000 : startedAt;
  return {
    points: points.filter((point) => point.x >= from),
    minTime: Math.floor(from / 1000),
    maxTime: Math.ceil(now / 1000),
  };
}

export type TrendKey =
  | "sessions"
  | "lag"
  | "transactions"
  | "cacheHit"
  | "walArchiving"
  | "walSize"
  | "databaseSizes"
  | "checkpoints"
  | "contention";

export interface TrendSeries {
  id: string;
  label: string;
  /** The theme token of the series (`--colorOk`), resolved by the component. */
  token: string;
  points: Point[];
  /** Drawn against the second axis (the temporary bytes next to the deadlocks). */
  secondAxis?: boolean;
}

export interface TrendCard {
  key: TrendKey;
  title: string;
  kind: "bars" | "lines";
  unit: string;
  series: TrendSeries[];
  /** The last value of the card, formatted, or undefined while there is none. */
  last?: string;
  /** How a value is written in the tooltips and the axis. */
  format: (value: number) => string;
  /** The metric the card needs when it has nothing, for the non-happy state. */
  needs: string;
}

/** The tokens of the series that are one per object, in a fixed order. */
export const SERIES_TOKENS: readonly string[] = [
  "--colorInfo",
  "--colorOk",
  "--colorWarning",
  "--colorSuccess",
  "--colorTerminated",
  "--colorVague",
];

const SESSION_TOKENS: Record<SessionState, string> = {
  active: "--colorInfo",
  idle: "--colorVague",
  "idle in transaction": "--colorWarning",
  other: "--colorTerminated",
};

export function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatSeconds(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)} s` : `${Math.round(milliseconds)} ms`;
}

export function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function lastOf(
  series: readonly TrendSeries[],
  format: (value: number) => string,
  combine: (values: number[]) => number = (values) => values.reduce((a, b) => a + b, 0),
): string | undefined {
  const lasts = series
    .map((entry) => entry.points[entry.points.length - 1]?.y)
    .filter((value): value is number => value !== undefined);
  if (lasts.length === 0) return undefined;
  return format(combine(lasts));
}

/** The nine cards of the section, over the memory as it is now. */
export function trendCards(memory: TrendMemory): TrendCard[] {
  const { metrics, lags } = memory;
  const standbys = [...new Set(lags.flatMap((snapshot) => Object.keys(snapshot.lag)))].sort();
  const databases = [...new Set(metrics.flatMap((snapshot) => Object.keys(snapshot.databaseSizes)))].sort();
  const cards: TrendCard[] = [];

  const sessions: TrendSeries[] = SESSION_STATES.map((state) => ({
    id: `sessions:${state}`,
    label: state,
    token: SESSION_TOKENS[state],
    points: gauge(metrics, (snapshot) => snapshot.sessions[state]),
  }));
  cards.push({
    key: "sessions",
    title: "Sessions",
    kind: "bars",
    unit: "backends",
    series: sessions,
    last: lastOf(sessions, formatCount),
    format: formatCount,
    needs: "cnpg_backends_total",
  });

  const lag: TrendSeries[] = standbys.map((standby, index) => ({
    id: `lag:${standby}`,
    label: standby,
    token: SERIES_TOKENS[index % SERIES_TOKENS.length],
    points: lags.flatMap((snapshot) =>
      snapshot.lag[standby] !== undefined ? [{ x: snapshot.time, y: snapshot.lag[standby] }] : [],
    ),
  }));
  cards.push({
    key: "lag",
    title: "Replay lag",
    kind: "lines",
    unit: "seconds",
    series: lag,
    last: lastOf(lag, formatSeconds, (values) => Math.max(...values)),
    format: formatSeconds,
    needs: "the replication status of the primary",
  });

  const transactions: TrendSeries[] = [
    { id: "commits", label: "committed / s", token: "--colorOk", points: rates(metrics, "xactCommit") },
    { id: "rollbacks", label: "rolled back / s", token: "--colorError", points: rates(metrics, "xactRollback") },
  ];
  cards.push({
    key: "transactions",
    title: "Transactions",
    kind: "bars",
    unit: "per second",
    series: transactions,
    last: lastOf(transactions, formatCount),
    format: formatCount,
    needs: "cnpg_pg_stat_database_xact_commit",
  });

  const cacheHit: TrendSeries[] = [
    { id: "cacheHit", label: "cache hit ratio", token: "--colorOk", points: cacheHitRatio(metrics) },
  ];
  cards.push({
    key: "cacheHit",
    title: "Cache hit ratio",
    kind: "lines",
    unit: "percent",
    series: cacheHit,
    last: lastOf(cacheHit, formatPercent),
    format: formatPercent,
    needs: "cnpg_pg_stat_database_blks_hit",
  });

  const archiving: TrendSeries[] = [
    { id: "archived", label: "archived", token: "--colorOk", points: deltas(metrics, "archived") },
    { id: "archiveFailed", label: "failed", token: "--colorError", points: deltas(metrics, "archiveFailed") },
  ];
  cards.push({
    key: "walArchiving",
    title: "WAL archiving",
    kind: "bars",
    unit: "files per interval",
    series: archiving,
    last: lastOf(archiving, formatCount),
    format: formatCount,
    needs: "cnpg_pg_stat_archiver_archived_count",
  });

  const walSize: TrendSeries[] = [
    {
      id: "walSize",
      label: "pg_wal",
      token: "--colorInfo",
      points: gauge(metrics, (snapshot) => snapshot.walSizeBytes),
    },
  ];
  cards.push({
    key: "walSize",
    title: "WAL on disk",
    kind: "lines",
    unit: "bytes",
    series: walSize,
    last: lastOf(walSize, formatBytes),
    format: formatBytes,
    needs: "cnpg_collector_pg_wal",
  });

  const sizes: TrendSeries[] = databases.map((database, index) => ({
    id: `size:${database}`,
    label: database,
    token: SERIES_TOKENS[index % SERIES_TOKENS.length],
    points: gauge(metrics, (snapshot) => snapshot.databaseSizes[database]),
  }));
  cards.push({
    key: "databaseSizes",
    title: "Database sizes",
    kind: "lines",
    unit: "bytes",
    series: sizes,
    last: lastOf(sizes, formatBytes),
    format: formatBytes,
    needs: "cnpg_pg_database_size_bytes",
  });

  const checkpoints: TrendSeries[] = [
    { id: "checkpointsTimed", label: "timed", token: "--colorOk", points: deltas(metrics, "checkpointsTimed") },
    {
      id: "checkpointsRequested",
      label: "requested",
      token: "--colorWarning",
      points: deltas(metrics, "checkpointsRequested"),
    },
  ];
  cards.push({
    key: "checkpoints",
    title: "Checkpoints",
    kind: "bars",
    unit: "per interval",
    series: checkpoints,
    last: lastOf(checkpoints, formatCount),
    format: formatCount,
    needs: "cnpg_pg_stat_checkpointer_checkpoints_timed",
  });

  const contention: TrendSeries[] = [
    { id: "deadlocks", label: "deadlocks", token: "--colorError", points: deltas(metrics, "deadlocks") },
    {
      id: "tempBytes",
      label: "temporary bytes",
      token: "--colorWarning",
      points: deltas(metrics, "tempBytes"),
      secondAxis: true,
    },
  ];
  cards.push({
    key: "contention",
    title: "Contention",
    kind: "bars",
    unit: "per interval",
    series: contention,
    last: lastOf(contention.slice(0, 1), formatCount),
    format: formatCount,
    needs: "cnpg_pg_stat_database_deadlocks",
  });

  return cards;
}
