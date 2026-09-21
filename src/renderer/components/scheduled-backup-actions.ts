/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything the three actions of a `ScheduledBackup` decide (SPEC-0021), as
// pure functions over structurally declared inputs: which of "Suspend" and
// "Resume" is offered, what a resume will make the operator do, whether a
// backup can be requested with the settings of the schedule, and the body of
// that backup.
//
// "Run now" does not run the schedule: upstream has no such thing. It creates
// an ordinary backup that copies what the controller copies, under a name the
// controller never produces and without the labels the controller owns, so it
// can never delay, replace or be mistaken for a run of the schedule.

import { parseGoTime } from "./go-time";
import { compactTimestamp, disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

/** The annotation that ties a backup requested by hand to the schedule whose settings it copied. */
export const REQUESTED_FROM_SCHEDULE_ANNOTATION = "cnpg-extension.freelens.app/scheduled-backup";

/** The schedule a backup was requested from by hand, or undefined for every other backup. */
export function requestedFromSchedule(backup: {
  metadata?: { annotations?: Record<string, string | undefined> };
}): string | undefined {
  return backup.metadata?.annotations?.[REQUESTED_FROM_SCHEDULE_ANNOTATION] || undefined;
}

export const HIBERNATED_RUN_NOW_REASON = "The operator fails a backup requested on a hibernated cluster";
export const NO_CLUSTER_RUN_NOW_REASON = "The cluster of the schedule is not in this namespace";

type BackupMethodKind = "plugin" | "volumeSnapshot" | "barmanObjectStore";
type BackupTarget = "primary" | "prefer-standby";
type OnlineConfiguration = { immediateCheckpoint?: boolean; waitForArchive?: boolean };
type PluginConfiguration = { name: string; parameters?: Record<string, string> };

export interface ScheduleFacts {
  name: string;
  namespace: string;
  spec?: {
    cluster?: { name?: string };
    suspend?: boolean;
    backupOwnerReference?: "none" | "self" | "cluster";
    method?: BackupMethodKind;
    target?: BackupTarget;
    online?: boolean;
    onlineConfiguration?: OnlineConfiguration;
    pluginConfiguration?: PluginConfiguration;
  };
  status?: { nextScheduleTime?: string };
}

/** The cluster of the schedule, as far as "Run now" needs it. Undefined when it is not in the namespace. */
export interface ScheduleClusterFacts {
  name: string;
  hibernated: boolean;
}

export function isSuspended(schedule: ScheduleFacts): boolean {
  return schedule.spec?.suspend === true;
}

/** Which of the two entries the menu renders: exactly one, by `.spec.suspend`. */
export function suspendEntry(schedule: ScheduleFacts): "suspend" | "resume" {
  return isSuspended(schedule) ? "resume" : "suspend";
}

/** Only a denial of `patch` (W3) disables the two entries: the component adds it. */
export function canSuspend(schedule: ScheduleFacts): ActionGuard {
  return isSuspended(schedule) ? disabledGuard("The schedule is suspended already") : enabledGuard;
}

export function canResume(schedule: ScheduleFacts): ActionGuard {
  return isSuspended(schedule) ? enabledGuard : disabledGuard("The schedule is not suspended");
}

/**
 * `clustersKnown` is false while the clusters of the namespace are not loaded
 * yet: a read that has not finished never refuses a write, and the guard runs
 * again on the click.
 */
export function canRunNow(
  _schedule: ScheduleFacts,
  cluster: ScheduleClusterFacts | undefined,
  clustersKnown = true,
): ActionGuard {
  if (!cluster) return clustersKnown ? disabledGuard(NO_CLUSTER_RUN_NOW_REASON) : enabledGuard;
  if (cluster.hibernated) return disabledGuard(HIBERNATED_RUN_NOW_REASON);
  return enabledGuard;
}

function clusterWords(schedule: ScheduleFacts): string {
  return schedule.spec?.cluster?.name ?? "the cluster";
}

export function suspendFacts(schedule: ScheduleFacts): ActionDialogFacts {
  return {
    subject: subjectOf("ScheduledBackup", schedule.namespace, schedule.name),
    writes: [
      {
        verb: "patch",
        text: `patch ScheduledBackup ${schedule.namespace}/${schedule.name}: spec.suspend ${
          schedule.spec?.suspend === undefined ? "(unset)" : String(schedule.spec.suspend)
        } -> true`,
      },
    ],
    notes: [
      `While suspended the operator creates no backup of ${clusterWords(schedule)} for this schedule and the next run it reports goes stale.`,
      "Backups that are already running are not touched. WAL archiving does not depend on the schedule and goes on.",
    ],
    warnings: [],
  };
}

/**
 * What a resume makes the operator do. The controller computes the next run
 * from the last time it looked at the schedule: when that run is already in
 * the past it creates one backup at once, for that run only, and then goes
 * back to the cadence.
 */
export function resumeFacts(schedule: ScheduleFacts, now: Date): ActionDialogFacts {
  const next = parseGoTime(schedule.status?.nextScheduleTime);
  const notes: string[] = [];
  const warnings: string[] = [];

  if (!next) {
    notes.push("The schedule reports no next run yet: the operator computes it when it sees the schedule again.");
  } else if (next.getTime() <= now.getTime()) {
    warnings.push(
      `The next run was due at ${next.toISOString()}, which is in the past: the operator will create one backup of ${clusterWords(
        schedule,
      )} right away, and then go back to the cadence. It does not replay every run that was missed.`,
    );
  } else {
    notes.push(`The next run is due at ${next.toISOString()}: nothing is created before then.`);
  }

  return {
    subject: subjectOf("ScheduledBackup", schedule.namespace, schedule.name),
    writes: [
      {
        verb: "patch",
        text: `patch ScheduledBackup ${schedule.namespace}/${schedule.name}: spec.suspend true -> false`,
      },
    ],
    notes,
    warnings,
  };
}

export const SUSPEND_PATCH = { spec: { suspend: true } } as const;
/** The explicit value rather than the removal of the field: the object says what was decided. */
export const RESUME_PATCH = { spec: { suspend: false } } as const;

export function runNowBackupName(scheduleName: string, now: Date): string {
  return `${scheduleName}-manual-${compactTimestamp(now)}`;
}

export interface RunNowBackupBody {
  apiVersion: "postgresql.cnpg.io/v1";
  kind: "Backup";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: {
    cluster: { name: string };
    method?: BackupMethodKind;
    target?: BackupTarget;
    online?: boolean;
    onlineConfiguration?: OnlineConfiguration;
    pluginConfiguration?: PluginConfiguration;
  };
}

/**
 * The body of the one `create`: the six fields the controller copies from the
 * schedule, copied when the schedule declares them and left out when it does
 * not, so the backup gets the same defaults a run of the schedule would get.
 * Undefined when the schedule names no cluster.
 */
export function runNowBackup(schedule: ScheduleFacts, now: Date): RunNowBackupBody | undefined {
  const cluster = schedule.spec?.cluster?.name;
  if (!cluster) return undefined;
  const spec = schedule.spec ?? {};
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: {
      name: runNowBackupName(schedule.name, now),
      namespace: schedule.namespace,
      labels: { "cnpg.io/cluster": cluster },
      annotations: { [REQUESTED_FROM_SCHEDULE_ANNOTATION]: schedule.name },
    },
    spec: {
      cluster: { name: cluster },
      ...(spec.method !== undefined ? { method: spec.method } : {}),
      ...(spec.target !== undefined ? { target: spec.target } : {}),
      ...(spec.online !== undefined ? { online: spec.online } : {}),
      ...(spec.onlineConfiguration !== undefined ? { onlineConfiguration: spec.onlineConfiguration } : {}),
      ...(spec.pluginConfiguration !== undefined ? { pluginConfiguration: spec.pluginConfiguration } : {}),
    },
  };
}

/** What the missing owner reference means, by what the schedule declares for its own backups. */
export function runNowOwnershipSentence(ownerReference: "none" | "self" | "cluster" | undefined): string {
  switch (ownerReference) {
    case "self":
      return "Unlike the backups of the schedule, which the schedule owns, this one has no owner: it stays when the schedule is deleted.";
    case "cluster":
      return "Unlike the backups of the schedule, which the cluster owns, this one has no owner: it stays when the cluster is deleted.";
    default:
      return "Like the backups of the schedule, this one has no owner: it stays when the schedule or the cluster is deleted.";
  }
}

function methodWords(body: RunNowBackupBody): string {
  if (body.spec.pluginConfiguration?.name) return `method plugin (${body.spec.pluginConfiguration.name})`;
  return body.spec.method ? `method ${body.spec.method}` : "method left to the default of the API";
}

export function runNowFacts(schedule: ScheduleFacts, now: Date): ActionDialogFacts {
  const body = runNowBackup(schedule, now);
  const notes = [
    "This is an ordinary backup with the settings of the schedule, not a run of it: the last run and the next run of the schedule do not move.",
    runNowOwnershipSentence(schedule.spec?.backupOwnerReference),
  ];
  if (isSuspended(schedule)) {
    notes.unshift("The schedule is suspended and stays suspended: only this one backup is requested.");
  }
  return {
    subject: subjectOf("ScheduledBackup", schedule.namespace, schedule.name),
    writes: body
      ? [
          {
            verb: "create",
            text: `create Backup ${body.metadata.namespace}/${body.metadata.name}: cluster ${body.spec.cluster.name}, ${methodWords(
              body,
            )}${body.spec.target ? `, target ${body.spec.target}` : ""}, label cnpg.io/cluster=${
              body.spec.cluster.name
            }, annotation ${REQUESTED_FROM_SCHEDULE_ANNOTATION}=${schedule.name}`,
          },
        ]
      : [],
    notes,
    warnings:
      body?.spec.method === "barmanObjectStore" || (body && body.spec.method === undefined)
        ? ["The schedule uses the in-tree Barman object store method, which is deprecated upstream."]
        : [],
  };
}

/** The pattern of a run of the schedule: the name of a backup requested by hand must never match it. */
export function scheduleRunPattern(scheduleName: string): RegExp {
  return new RegExp(`^${scheduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{14}$`);
}
