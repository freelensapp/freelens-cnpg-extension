/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure classifiers of the `Backup` and `ScheduledBackup` kinds (SPEC-0005
// "Classifiers"). No JSX and no colors: the functions map the objects to a
// closed set of states, to the host's status classes and theme tokens
// (DESIGN.md section 2) and to the sentence the Status column shows, so the
// lists, the drawers and the history strip never disagree.

import { Backup } from "../api/cnpg/backup-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { parseGoTime } from "./go-time";
import { lsnDistance } from "./lsn";

import type { HostStatusClass } from "./cluster-health";

export type BackupState = "Completed" | "Running" | "Pending" | "Failed" | "Unknown";

export interface BackupHealth {
  state: BackupState;
  /** Short scannable word for the Condition column. */
  label: BackupState;
  className: HostStatusClass;
  /** Semantic theme token for custom elements (DESIGN.md section 2 table). */
  token: string;
  /** The sentence the Status column and the tooltip show. */
  reason: string;
}

const BACKUP_PRESENTATION: Record<BackupState, { className: HostStatusClass; token: string }> = {
  Completed: { className: "success", token: "--colorSuccess" },
  Running: { className: "info", token: "--colorInfo" },
  Pending: { className: "info", token: "--colorWarning" },
  Failed: { className: "error", token: "--colorError" },
  Unknown: { className: "info", token: "--colorVague" },
};

function backupHealth(state: BackupState, reason: string): BackupHealth {
  return { state, label: state, reason, ...BACKUP_PRESENTATION[state] };
}

/** "2s", "1m 5s", "2h 3m", "1d 4h": two units at most, never a fraction. */
export function humanizeDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** "in 5h 3m" for a future time, "5m ago" for a past one. */
export function humanizeRelative(target: Date, now: Date): string {
  const delta = target.getTime() - now.getTime();
  return delta >= 0 ? `in ${humanizeDuration(delta)}` : `${humanizeDuration(-delta)} ago`;
}

function difference(from: Date | undefined, to: Date | undefined): number | undefined {
  if (!from || !to) return undefined;
  const delta = to.getTime() - from.getTime();
  return delta >= 0 ? delta : undefined;
}

/**
 * How long the backup took, in milliseconds: the backup's own start and stop
 * when both are there, else the reconciliation pair, else undefined.
 */
export function backupDuration(backup: Backup): number | undefined {
  const status = backup.status;
  return (
    difference(parseGoTime(status?.startedAt), parseGoTime(status?.stoppedAt)) ??
    difference(parseGoTime(status?.reconciliationStartedAt), parseGoTime(status?.reconciliationTerminatedAt))
  );
}

/** When the backup started: its own start, else the reconciliation start, else its creation. */
export function backupStart(backup: Backup): Date | undefined {
  return (
    parseGoTime(backup.status?.startedAt) ??
    parseGoTime(backup.status?.reconciliationStartedAt) ??
    parseGoTime(backup.metadata?.creationTimestamp)
  );
}

/** The timeline of the backup: from the plugin metadata, else from the WAL file name. */
export function backupTimeline(backup: Backup): number | undefined {
  const declared = backup.status?.pluginMetadata?.timeline;
  if (declared && /^\d+$/.test(declared)) return Number.parseInt(declared, 10);
  const wal = backup.status?.beginWal;
  if (wal && /^[0-9A-Fa-f]{24}$/.test(wal)) return Number.parseInt(wal.slice(0, 8), 16);
  return undefined;
}

/** WAL written while the backup ran, in bytes. */
export function walDuringBackup(backup: Backup): bigint | undefined {
  const distance = lsnDistance(backup.status?.beginLSN, backup.status?.endLSN);
  return distance !== undefined && distance >= 0n ? distance : undefined;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.trim().split("\n")[0]?.trim();
  return line || undefined;
}

function failureSentence(backup: Backup, fallback: string): string {
  return firstLine(backup.status?.error) ?? firstLine(backup.status?.commandError) ?? fallback;
}

/** The closed-set state of a backup, with the sentence that explains it. */
export function classifyBackup(backup: Backup, now: Date = new Date()): BackupHealth {
  const phase = Backup.getPhase(backup)?.trim();
  if (!phase) {
    return backupHealth("Pending", "No status reported yet");
  }

  switch (phase) {
    case "completed": {
      const duration = backupDuration(backup);
      return backupHealth(
        "Completed",
        duration === undefined ? "Completed" : `Completed in ${humanizeDuration(duration)}`,
      );
    }
    case "pending":
      return backupHealth("Pending", "Waiting to start");
    case "started":
    case "running": {
      const running = difference(backupStart(backup), now);
      return backupHealth("Running", running === undefined ? "Running" : `Running for ${humanizeDuration(running)}`);
    }
    case "finalizing":
      return backupHealth("Running", "Finalizing the volume snapshots");
    case "failed":
      return backupHealth("Failed", failureSentence(backup, "Failed"));
    case "walArchivingFailing":
      return backupHealth("Failed", "Not started: WAL archiving is not working on the instance");
    case "invalid backup definition":
      return backupHealth("Failed", failureSentence(backup, "Invalid backup definition"));
    default:
      return backupHealth("Unknown", phase);
  }
}

export type ScheduleState = "Active" | "Suspended" | "Overdue" | "Failed" | "Pending";

export interface ScheduleHealth {
  state: ScheduleState;
  label: ScheduleState;
  className: HostStatusClass;
  token: string;
  reason: string;
}

const SCHEDULE_PRESENTATION: Record<ScheduleState, { className: HostStatusClass; token: string }> = {
  Active: { className: "success", token: "--colorOk" },
  Suspended: { className: "warning", token: "--colorWarning" },
  Overdue: { className: "warning", token: "--colorWarning" },
  Failed: { className: "error", token: "--colorError" },
  Pending: { className: "info", token: "--colorInfo" },
};

function scheduleHealth(state: ScheduleState, reason: string): ScheduleHealth {
  return { state, label: state, reason, ...SCHEDULE_PRESENTATION[state] };
}

/** The operator checks the schedules periodically: a next run this late is overdue. */
export const SCHEDULE_OVERDUE_TOLERANCE_MS = 5 * 60 * 1000;

/** The closed-set state of a scheduled backup, with the sentence that explains it. */
export function classifySchedule(schedule: ScheduledBackup, now: Date = new Date()): ScheduleHealth {
  const error = firstLine(schedule.status?.error);
  if (error) {
    return scheduleHealth("Failed", error);
  }
  if (ScheduledBackup.isSuspended(schedule)) {
    return scheduleHealth("Suspended", "Suspended: no backup will be taken");
  }

  const next = parseGoTime(schedule.status?.nextScheduleTime);
  if (next && now.getTime() - next.getTime() > SCHEDULE_OVERDUE_TOLERANCE_MS) {
    return scheduleHealth("Overdue", `The next run was due ${humanizeDuration(now.getTime() - next.getTime())} ago`);
  }
  if (!parseGoTime(schedule.status?.lastCheckTime)) {
    return scheduleHealth("Pending", "Not checked by the operator yet");
  }
  return scheduleHealth("Active", next ? `Next run ${humanizeRelative(next, now)}` : "Waiting for the first run");
}
