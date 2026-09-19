/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Backup } from "../api/cnpg/backup-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import {
  backupDuration,
  backupStart,
  backupTimeline,
  classifyBackup,
  classifySchedule,
  humanizeDuration,
  humanizeRelative,
  SCHEDULE_OVERDUE_TOLERANCE_MS,
  walDuringBackup,
} from "./backup-health";

import type { BackupStatus } from "../api/cnpg/backup-v1";
import type { ScheduledBackupSpec, ScheduledBackupStatus } from "../api/cnpg/scheduled-backup-v1";

const NOW = new Date("2026-09-19T12:00:00Z");

function makeBackup(status: BackupStatus | undefined, labels: Record<string, string> = {}): Backup {
  return new Backup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name: "backup", namespace: "db", labels, creationTimestamp: "2026-09-19T11:00:00Z" },
    spec: { cluster: { name: "pg" }, method: "plugin" },
    status,
  } as never);
}

function makeSchedule(
  status: ScheduledBackupStatus | undefined,
  spec: Partial<ScheduledBackupSpec> = {},
): ScheduledBackup {
  return new ScheduledBackup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ScheduledBackup",
    metadata: { name: "nightly", namespace: "db", creationTimestamp: "2026-09-18T10:00:00Z" },
    spec: { cluster: { name: "pg" }, schedule: "0 0 3 * * *", method: "plugin", ...spec },
    status,
  } as never);
}

// The completed backup observed on the E2E cluster (operator 1.30.0, plugin 0.15.0).
const COMPLETED: BackupStatus = {
  phase: "completed",
  method: "plugin",
  backupId: "20260918T161445",
  beginLSN: "0/5000028",
  endLSN: "0/60696A0",
  beginWal: "000000010000000000000005",
  endWal: "000000010000000000000006",
  startedAt: "2026-09-18T16:14:46Z",
  stoppedAt: "2026-09-18T16:14:48Z",
  reconciliationStartedAt: "2026-09-18T16:14:44Z",
  reconciliationTerminatedAt: "2026-09-18T16:14:51Z",
  pluginMetadata: { timeline: "1", version: "0.15.0" },
};

describe("humanizeDuration and humanizeRelative", () => {
  it("shows two units at most and never a fraction", () => {
    expect(humanizeDuration(0)).toBe("0s");
    expect(humanizeDuration(1999)).toBe("1s");
    expect(humanizeDuration(65_000)).toBe("1m 5s");
    expect(humanizeDuration(60_000)).toBe("1m");
    expect(humanizeDuration(2 * 3600_000 + 3 * 60_000 + 4000)).toBe("2h 3m");
    expect(humanizeDuration(28 * 3600_000)).toBe("1d 4h");
    expect(humanizeDuration(48 * 3600_000)).toBe("2d");
    expect(humanizeDuration(-5)).toBe("0s");
  });

  it("phrases future and past times", () => {
    expect(humanizeRelative(new Date("2026-09-19T17:03:00Z"), NOW)).toBe("in 5h 3m");
    expect(humanizeRelative(new Date("2026-09-19T11:55:00Z"), NOW)).toBe("5m ago");
    expect(humanizeRelative(NOW, NOW)).toBe("just now");
    expect(humanizeRelative(new Date(NOW.getTime() - 999), NOW)).toBe("just now");
    expect(humanizeRelative(new Date(NOW.getTime() - 1000), NOW)).toBe("1s ago");
  });
});

describe("classifyBackup", () => {
  it("is Completed with the duration of the backup itself", () => {
    expect(classifyBackup(makeBackup(COMPLETED), NOW)).toMatchObject({
      state: "Completed",
      label: "Completed",
      className: "success",
      token: "--colorSuccess",
      reason: "Completed in 2s",
    });
  });

  it("is Completed without a duration when no time pair parses", () => {
    expect(classifyBackup(makeBackup({ phase: "completed" }), NOW).reason).toBe("Completed");
  });

  it("is Pending without a status, without a phase and while pending", () => {
    expect(classifyBackup(makeBackup(undefined), NOW)).toMatchObject({
      state: "Pending",
      className: "info",
      reason: "No status reported yet",
    });
    expect(classifyBackup(makeBackup({ phase: "" }), NOW).state).toBe("Pending");
    expect(classifyBackup(makeBackup({ phase: "pending" }), NOW).reason).toBe("Waiting to start");
  });

  it("is Running for started, running and finalizing", () => {
    const running = makeBackup({ phase: "running", startedAt: "2026-09-19T11:58:30Z" });
    expect(classifyBackup(running, NOW)).toMatchObject({
      state: "Running",
      className: "info",
      token: "--colorInfo",
      reason: "Running for 1m 30s",
    });
    // No start reported yet: the creation time of the object stands in.
    expect(classifyBackup(makeBackup({ phase: "started" }), NOW).reason).toBe("Running for 1h");
    expect(classifyBackup(makeBackup({ phase: "finalizing" }), NOW)).toMatchObject({
      state: "Running",
      reason: "Finalizing the volume snapshots",
    });
  });

  it("is Failed with the error first, then the first line of the command error", () => {
    const upstream = makeBackup({
      phase: "failed",
      error: "rpc error: code = Unknown desc = exit status 1",
      commandError: "barman-cloud-backup: something else",
    });
    expect(classifyBackup(upstream, NOW)).toMatchObject({
      state: "Failed",
      className: "error",
      token: "--colorError",
      reason: "rpc error: code = Unknown desc = exit status 1",
    });
    const command = makeBackup({ phase: "failed", commandError: "\nfirst line\nsecond line" });
    expect(classifyBackup(command, NOW).reason).toBe("first line");
    expect(classifyBackup(makeBackup({ phase: "failed" }), NOW).reason).toBe("Failed");
  });

  it("reads walArchivingFailing as a backup that did not start", () => {
    expect(classifyBackup(makeBackup({ phase: "walArchivingFailing" }), NOW)).toMatchObject({
      state: "Failed",
      reason: "Not started: WAL archiving is not working on the instance",
    });
  });

  it("is Failed for an invalid definition and Unknown for a phase it does not know", () => {
    expect(classifyBackup(makeBackup({ phase: "invalid backup definition" }), NOW)).toMatchObject({
      state: "Failed",
      reason: "Invalid backup definition",
    });
    expect(classifyBackup(makeBackup({ phase: "teleporting" }), NOW)).toMatchObject({
      state: "Unknown",
      className: "info",
      token: "--colorVague",
      reason: "teleporting",
    });
  });
});

describe("backup figures", () => {
  it("falls back to the reconciliation pair for the duration", () => {
    expect(backupDuration(makeBackup(COMPLETED))).toBe(2000);
    const reconciled = makeBackup({
      phase: "failed",
      reconciliationStartedAt: "2026-09-18T16:14:45Z",
      reconciliationTerminatedAt: "2026-09-18T16:14:46Z",
    });
    expect(backupDuration(reconciled)).toBe(1000);
    expect(backupDuration(makeBackup({ phase: "running", startedAt: "2026-09-19T11:00:00Z" }))).toBeUndefined();
    const inverted = makeBackup({ startedAt: "2026-09-19T11:00:00Z", stoppedAt: "2026-09-19T10:00:00Z" });
    expect(backupDuration(inverted)).toBeUndefined();
  });

  it("starts at the backup start, then the reconciliation start, then the creation", () => {
    expect(backupStart(makeBackup(COMPLETED))?.toISOString()).toBe("2026-09-18T16:14:46.000Z");
    const reconciled = makeBackup({ reconciliationStartedAt: "2026-09-18T16:14:45Z" });
    expect(backupStart(reconciled)?.toISOString()).toBe("2026-09-18T16:14:45.000Z");
    expect(backupStart(makeBackup(undefined))?.toISOString()).toBe("2026-09-19T11:00:00.000Z");
  });

  it("reads the timeline from the plugin metadata, else from the WAL file name", () => {
    expect(backupTimeline(makeBackup(COMPLETED))).toBe(1);
    expect(backupTimeline(makeBackup({ beginWal: "0000000A0000000000000005" }))).toBe(10);
    expect(backupTimeline(makeBackup({ pluginMetadata: { timeline: "x" }, beginWal: "short" }))).toBeUndefined();
    expect(backupTimeline(makeBackup(undefined))).toBeUndefined();
  });

  it("measures the WAL written during the backup", () => {
    expect(walDuringBackup(makeBackup(COMPLETED))).toBe(BigInt(0x60696a0 - 0x5000028));
    expect(walDuringBackup(makeBackup({ beginLSN: "0/2", endLSN: "0/1" }))).toBeUndefined();
    expect(walDuringBackup(makeBackup({ beginLSN: "0/2" }))).toBeUndefined();
  });

  it("finds the parent schedule and the instance pod", () => {
    const child = makeBackup(
      { instanceID: { podName: "pg-2" } },
      { "cnpg.io/scheduled-backup": "nightly", "cnpg.io/cluster": "pg" },
    );
    expect(Backup.getParentSchedule(child)).toBe("nightly");
    expect(Backup.getInstancePod(child)).toBe("pg-2");
    expect(Backup.getParentSchedule(makeBackup(undefined))).toBeUndefined();
    expect(Backup.getInstancePod(makeBackup(undefined))).toBeUndefined();
  });
});

describe("classifySchedule", () => {
  const checked = { lastCheckTime: "2026-09-19T11:59:00Z" };

  it("is Active with the next run, or waiting for the first one", () => {
    const next = makeSchedule({ ...checked, nextScheduleTime: "2026-09-20T03:00:00Z" });
    expect(classifySchedule(next, NOW)).toMatchObject({
      state: "Active",
      className: "success",
      token: "--colorOk",
      reason: "Next run in 15h",
    });
    // As observed on the E2E cluster: checked, but no run and no next run reported yet.
    expect(classifySchedule(makeSchedule(checked), NOW).reason).toBe("Waiting for the first run");
  });

  it("is Pending until the operator has checked it", () => {
    expect(classifySchedule(makeSchedule(undefined), NOW)).toMatchObject({
      state: "Pending",
      className: "info",
      reason: "Not checked by the operator yet",
    });
  });

  it("is Suspended as a warning, even with a stale next run", () => {
    const suspended = makeSchedule({ ...checked, nextScheduleTime: "2026-09-10T03:00:00Z" }, { suspend: true });
    expect(classifySchedule(suspended, NOW)).toMatchObject({
      state: "Suspended",
      className: "warning",
      reason: "Suspended: no backup will be taken",
    });
  });

  it("is Overdue only past the tolerance", () => {
    const at = (offset: number) =>
      makeSchedule({ ...checked, nextScheduleTime: new Date(NOW.getTime() - offset).toISOString() });
    expect(classifySchedule(at(SCHEDULE_OVERDUE_TOLERANCE_MS), NOW).state).toBe("Active");
    expect(classifySchedule(at(SCHEDULE_OVERDUE_TOLERANCE_MS + 60_000), NOW)).toMatchObject({
      state: "Overdue",
      className: "warning",
      reason: "The next run was due 6m ago",
    });
  });

  it("is Failed when the operator reports an error, before anything else", () => {
    const failed = makeSchedule({ ...checked, error: "cannot parse the schedule\ndetails" }, { suspend: true });
    expect(classifySchedule(failed, NOW)).toMatchObject({
      state: "Failed",
      className: "error",
      reason: "cannot parse the schedule",
    });
  });

  it("reads the method with the deprecated CRD default", () => {
    expect(ScheduledBackup.getMethod(makeSchedule(undefined))).toBe("plugin");
    expect(ScheduledBackup.getMethod(makeSchedule(undefined, { method: undefined }))).toBe("barmanObjectStore");
  });
});
