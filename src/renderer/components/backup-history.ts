/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the backup history strip (SPEC-0005 "Backup history strip"):
// where each backup falls on a time window that ends now, which marks merge,
// how far back the cluster can be recovered, when the next scheduled run is
// and how long the cluster went without a successful backup. The component is
// a thin shell over `buildHistory`.

import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { backupStart, classifyBackup } from "./backup-health";
import { parseGoTime } from "./go-time";

import type { Backup } from "../api/cnpg/backup-v1";
import type { Cluster } from "../api/cnpg/cluster-v1";
import type { BackupState } from "./backup-health";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SHORT_WINDOW_DAYS = 7;
export const LONG_WINDOW_DAYS = 30;

/** How many marks the strip can tell apart: closer backups merge into one mark. */
export const DEFAULT_RESOLUTION = 56;

/** A merged mark takes the state that most needs the eye. */
const STATE_PRIORITY: readonly BackupState[] = ["Failed", "Running", "Pending", "Unknown", "Completed"];

export interface HistoryMark {
  /** Time of the latest backup in the mark. */
  time: Date;
  /** Position on the strip: 0 is the start of the window, 1 is now. */
  position: number;
  state: BackupState;
  /** Names of the backups in the mark, latest first. */
  names: string[];
  /**
   * True for the backups requested by hand with the settings of a schedule
   * (SPEC-0021): on the axis of that schedule, never merged with its runs and
   * never counted in its figures, because the schedule did not run them.
   */
  manual: boolean;
}

export interface BackupHistory {
  windowDays: number;
  windowStart: Date;
  marks: HistoryMark[];
  /** Start of the recoverability band, clamped to the window; absent while archiving fails. */
  recoverableFrom?: { time: Date; position: number };
  lastSuccessful?: Date;
  /** Longest stretch without a successful backup in the window, the one up to now included. */
  longestGapMs?: number;
  nextRun?: Date;
  /** Whether a schedule that is not suspended exists at all. */
  hasActiveSchedule: boolean;
  /** How many backups requested by hand are on the axis (SPEC-0021): the legend of the hollow marks. */
  manualCount: number;
}

export interface HistoryOptions {
  /** True when WAL archiving is failing: without WAL there is no recoverability window. */
  archivingFailing?: boolean;
  resolution?: number;
  /** The backups requested by hand with the settings of the schedule the strip is about (SPEC-0021). */
  manual?: readonly Backup[];
}

/** The `ScheduledBackup` objects that belong to the cluster (same namespace, `spec.cluster.name`). */
export function schedulesOfCluster(cluster: Cluster, schedules: readonly ScheduledBackup[]): ScheduledBackup[] {
  const name = cluster.metadata?.name;
  const namespace = cluster.metadata?.namespace;
  return schedules.filter(
    (schedule) => ScheduledBackup.getClusterName(schedule) === name && schedule.metadata?.namespace === namespace,
  );
}

interface TimedBackup {
  name: string;
  time: Date;
  state: BackupState;
}

function timed(backups: readonly Backup[], now: Date): TimedBackup[] {
  const result: TimedBackup[] = [];
  for (const backup of backups) {
    // A finished backup counts from when it stopped: that is the moment it protects.
    const time = parseGoTime(backup.status?.stoppedAt) ?? backupStart(backup);
    if (!time) continue;
    result.push({ name: backup.metadata?.name ?? "", time, state: classifyBackup(backup, now).state });
  }
  return result.sort((a, b) => a.time.getTime() - b.time.getTime());
}

function worst(states: readonly BackupState[]): BackupState {
  return STATE_PRIORITY.find((state) => states.includes(state)) ?? "Unknown";
}

/**
 * The history of the given backups (already narrowed to one cluster or one
 * schedule) over a window that ends at `now`: seven days, or thirty when the
 * last seven hold fewer than two backups.
 */
export function buildHistory(
  backups: readonly Backup[],
  schedules: readonly ScheduledBackup[],
  now: Date,
  { archivingFailing = false, resolution = DEFAULT_RESOLUTION, manual = [] }: HistoryOptions = {},
): BackupHistory {
  const all = timed(backups, now).filter((backup) => backup.time.getTime() <= now.getTime());
  const shortStart = now.getTime() - SHORT_WINDOW_DAYS * DAY_MS;
  const windowDays =
    all.filter((backup) => backup.time.getTime() >= shortStart).length < 2 ? LONG_WINDOW_DAYS : SHORT_WINDOW_DAYS;
  const windowMs = windowDays * DAY_MS;
  const windowStart = new Date(now.getTime() - windowMs);
  const position = (time: Date) => Math.min(1, Math.max(0, (time.getTime() - windowStart.getTime()) / windowMs));

  const marksOf = (backups: readonly TimedBackup[], byHand: boolean): HistoryMark[] => {
    const slots = new Map<number, TimedBackup[]>();
    for (const backup of backups) {
      if (backup.time.getTime() < windowStart.getTime()) continue;
      const slot = Math.min(resolution - 1, Math.floor(position(backup.time) * resolution));
      slots.set(slot, [...(slots.get(slot) ?? []), backup]);
    }
    return [...slots.keys()]
      .sort((a, b) => a - b)
      .map((slot) => {
        const members = [...(slots.get(slot) ?? [])].reverse();
        return {
          time: members[0].time,
          position: position(members[0].time),
          state: worst(members.map((member) => member.state)),
          names: members.map((member) => member.name),
          manual: byHand,
        };
      });
  };
  // The window, the band and the figures below are the schedule's own: a backup
  // requested by hand is on the axis and nowhere else.
  const byHand = timed(manual, now).filter((backup) => backup.time.getTime() <= now.getTime());
  const marks = [...marksOf(all, false), ...marksOf(byHand, true)].sort((a, b) => a.position - b.position);

  const completed = all.filter((backup) => backup.state === "Completed");
  const lastSuccessful = completed.at(-1)?.time;
  const firstSuccessful = completed[0]?.time;
  const recoverableFrom =
    firstSuccessful && !archivingFailing
      ? {
          time: firstSuccessful,
          position: position(firstSuccessful),
        }
      : undefined;

  const completedInWindow = completed.filter((backup) => backup.time.getTime() >= windowStart.getTime());
  let longestGapMs: number | undefined;
  if (completedInWindow.length > 0) {
    const times = [...completedInWindow.map((backup) => backup.time.getTime()), now.getTime()];
    longestGapMs = 0;
    for (let i = 1; i < times.length; i += 1) {
      longestGapMs = Math.max(longestGapMs, times[i] - times[i - 1]);
    }
  }

  const active = schedules.filter((schedule) => !ScheduledBackup.isSuspended(schedule));
  const nextRuns = active
    .map((schedule) => parseGoTime(schedule.status?.nextScheduleTime))
    .filter((time): time is Date => time !== undefined)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    windowDays,
    windowStart,
    marks,
    recoverableFrom,
    lastSuccessful,
    longestGapMs,
    nextRun: nextRuns[0],
    hasActiveSchedule: active.length > 0,
    manualCount: marks.filter((mark) => mark.manual).reduce((count, mark) => count + mark.names.length, 0),
  };
}
