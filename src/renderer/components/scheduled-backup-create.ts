/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create ScheduledBackup form (SPEC-0026): the methods
// the picked cluster offers, the expression the cron editor builds and its
// next runs, which field is wrong and why, what the operator will do with
// the schedule, and the exact body of the one `create`. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import { backupMethodOptions } from "./backup-now";
import { collisionWarning, createLine, firstError, objectNameError } from "./create-forms";
import { cronFromPreset, cronPresetErrors, defaultCronPresetValues, formatRun, nextRuns, runInterval } from "./cron";
import { describeSchedule, SCHEDULE_TIME_ZONE_NOTE } from "./cron-text";
import { subjectOf } from "./write-actions";

import type { BackupMethodOption, BackupNowClusterFacts, BackupTargetChoice } from "./backup-now";
import type { CronPresetValues } from "./cron";
import type { ActionDialogFacts } from "./write-actions";

export type ReadState = "loading" | "ready" | "unavailable";

/** A cluster of the namespace as the form needs it: what `backupMethodOptions` reads, plus its phase. */
export interface ScheduleClusterChoice extends BackupNowClusterFacts {
  phase?: string;
}

export interface ScheduledBackupInputs {
  clusters: ScheduleClusterChoice[];
  /** The schedules of the namespace, for the collision warning. */
  schedules: string[];
  /** Whether the VolumeSnapshot CRD exists in the Kubernetes cluster; undefined while unknown. */
  volumeSnapshotCrd?: boolean;
  reads: Record<"clusters" | "schedules" | "crds", ReadState>;
}

export function emptyScheduledBackupInputs(): ScheduledBackupInputs {
  return { clusters: [], schedules: [], reads: { clusters: "loading", schedules: "loading", crds: "loading" } };
}

export type BackupOwner = "none" | "self" | "cluster";

export interface ScheduledBackupForm {
  namespace: string;
  name: string;
  cluster: string;
  cron: CronPresetValues;
  /** The id of a `BackupMethodOption` of the cluster, or empty while none is picked. */
  methodId: string;
  target: BackupTargetChoice;
  /** Volume snapshots only (option dropping for the plugin). */
  online: boolean;
  immediateCheckpoint: boolean;
  waitForArchive: boolean;
  immediate: boolean;
  suspend: boolean;
  owner: BackupOwner;
}

export function defaultScheduledBackupForm(namespace: string, cluster = ""): ScheduledBackupForm {
  return {
    namespace,
    name: cluster ? `${cluster}-daily` : "",
    cluster,
    cron: defaultCronPresetValues(),
    methodId: "",
    target: "default",
    online: true,
    immediateCheckpoint: false,
    waitForArchive: true,
    immediate: false,
    suspend: false,
    owner: "none",
  };
}

export function pickedCluster(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
): ScheduleClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export const VOLUME_SNAPSHOT_CRD_REASON =
  "the VolumeSnapshot CRD is not installed in this Kubernetes cluster, and the operator refuses the method without it";

/** The methods the form offers for the picked cluster: never the deprecated in-tree one (F13). */
export function scheduleMethodOptions(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
): Array<BackupMethodOption & { reason?: string }> {
  const cluster = pickedCluster(inputs, form);
  if (!cluster) return [];
  return backupMethodOptions(cluster)
    .filter((option) => !option.deprecated)
    .map((option) => ({
      ...option,
      reason:
        option.method === "volumeSnapshot" && inputs.volumeSnapshotCrd === false
          ? VOLUME_SNAPSHOT_CRD_REASON
          : undefined,
    }));
}

/** The method the form should start with when the cluster changes: the first usable one. */
export function defaultMethodId(inputs: ScheduledBackupInputs, form: ScheduledBackupForm): string {
  return scheduleMethodOptions(inputs, form).find((option) => !option.reason)?.id ?? "";
}

export function pickedMethod(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
): (BackupMethodOption & { reason?: string }) | undefined {
  return scheduleMethodOptions(inputs, form).find((option) => option.id === form.methodId);
}

export const SCHEDULE_FIELD_ORDER: readonly string[] = ["namespace", "cluster", "name", "cron", "methodId"];

export const NO_METHOD_REASON =
  "The cluster declares no backup plugin and no volume snapshot section: add one to the cluster before scheduling backups";

export function scheduledBackupErrors(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  const nameError = objectNameError(form.name);
  if (nameError) errors.name = nameError;
  const cronErrors = cronPresetErrors(form.cron);
  const cronError =
    cronErrors.custom ?? cronErrors.minute ?? cronErrors.hour ?? cronErrors.weekday ?? cronErrors.monthDay;
  if (cronError) errors.cron = cronError;
  const cluster = pickedCluster(inputs, form);
  if (cluster) {
    const options = scheduleMethodOptions(inputs, form);
    if (options.length === 0) errors.methodId = NO_METHOD_REASON;
    else if (form.methodId === "") errors.methodId = "Pick a method";
    else {
      const picked = options.find((option) => option.id === form.methodId);
      if (!picked) errors.methodId = "Pick a method the cluster offers";
      else if (picked.reason) errors.methodId = `Volume snapshots cannot be scheduled: ${picked.reason}`;
    }
  } else if (form.cluster !== "" && form.methodId === "") {
    errors.methodId = "Pick a method";
  }
  return errors;
}

export function scheduledBackupWarnings(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning("scheduled backup", form.name, inputs.schedules);
  if (collision) warnings.name = collision;
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !pickedCluster(inputs, form)) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: the backups will stay pending until it exists`;
  }
  return warnings;
}

/** The expression the form sends, from the preset or as typed. */
export function scheduleExpression(form: ScheduledBackupForm): string {
  return cronFromPreset(form.cron);
}

const OWNER_SENTENCES: Record<BackupOwner, string> = {
  none: "The backups belong to nobody: they outlive the schedule and the cluster.",
  self: "The schedule owns its backups: deleting the schedule deletes them.",
  cluster: "The cluster owns the backups: deleting the cluster deletes them.",
};

export function scheduledBackupBody(inputs: ScheduledBackupInputs, form: ScheduledBackupForm): Record<string, unknown> {
  const method = pickedMethod(inputs, form);
  const spec: Record<string, unknown> = {
    cluster: { name: form.cluster },
    schedule: scheduleExpression(form),
  };
  if (method) {
    spec.method = method.method;
    if (method.pluginName) spec.pluginConfiguration = { name: method.pluginName };
  }
  if (form.target !== "default") spec.target = form.target;
  if (method?.method === "volumeSnapshot") {
    spec.online = form.online;
    if (form.online)
      spec.onlineConfiguration = { immediateCheckpoint: form.immediateCheckpoint, waitForArchive: form.waitForArchive };
  }
  spec.immediate = form.immediate;
  if (form.suspend) spec.suspend = true;
  spec.backupOwnerReference = form.owner;
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "ScheduledBackup",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

/** The next three runs, as the form prints them. */
export function scheduledBackupNextRuns(form: ScheduledBackupForm, now: Date): string[] {
  return nextRuns(scheduleExpression(form), now, 3).map(formatRun);
}

export const FREQUENT_RUN_SECONDS = 15 * 60;

export function scheduledBackupNotes(inputs: ScheduledBackupInputs, form: ScheduledBackupForm, now: Date): string[] {
  const expression = scheduleExpression(form);
  const words = describeSchedule(expression);
  const runs = scheduledBackupNextRuns(form, now);
  const notes: string[] = [];
  if (words) {
    notes.push(
      `Runs ${words.charAt(0).toLowerCase()}${words.slice(1)} (${SCHEDULE_TIME_ZONE_NOTE})${runs.length > 0 ? `; next at ${runs.join(", ")}` : ""}.`,
    );
  } else if (runs.length > 0) {
    notes.push(`Next runs at ${runs.join(", ")} (${SCHEDULE_TIME_ZONE_NOTE}).`);
  }
  notes.push(
    `Each run creates a Backup named ${form.name || "<name>"}-<time of the run>, labelled as a child of the schedule.`,
  );
  if (form.immediate) notes.push("A first backup is requested as soon as the schedule exists.");
  if (form.suspend) notes.push("Created suspended: nothing runs until it is resumed (SPEC-0021).");
  notes.push(OWNER_SENTENCES[form.owner]);
  const method = pickedMethod(inputs, form);
  if (method?.method === "plugin") {
    notes.push(
      `The plugin ${method.pluginName} takes the backup on ${form.target === "default" ? "the cluster's default target" : form.target}.`,
    );
  }
  return notes;
}

export function scheduledBackupSummaryWarnings(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
  now: Date,
): string[] {
  const warnings: string[] = [];
  const cluster = pickedCluster(inputs, form);
  if (cluster?.hibernated) {
    warnings.push(
      form.immediate
        ? "The cluster is hibernated: the first backup right away fails, and every run until the cluster is resumed."
        : "The cluster is hibernated: every run fails until the cluster is resumed.",
    );
  } else if (cluster && form.immediate && cluster.phase && cluster.phase !== "Cluster in healthy state") {
    warnings.push(`The cluster is not healthy (${cluster.phase}): a first backup right away may fail.`);
  }
  if (cluster && !(cluster.spec?.plugins ?? []).some((plugin) => plugin.isWALArchiver && plugin.enabled !== false)) {
    warnings.push("The cluster declares no WAL archiver: point in time recovery is not possible from these backups.");
  }
  const interval = runInterval(scheduleExpression(form), now);
  if (interval !== undefined && interval < FREQUENT_RUN_SECONDS) {
    warnings.push(
      `Runs every ${Math.round(interval / 60) || 1} minute${Math.round(interval / 60) === 1 ? "" : "s"}: backups of one cluster run one at a time, and the others queue.`,
    );
  }
  return warnings;
}

export function scheduledBackupFacts(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
  now: Date,
): ActionDialogFacts {
  const method = pickedMethod(inputs, form);
  const parts = [
    `cluster ${form.cluster || "?"}`,
    `schedule "${scheduleExpression(form) || "?"}"`,
    method ? (method.pluginName ? `method plugin (${method.pluginName})` : `method ${method.method}`) : "method ?",
    `owner ${form.owner}`,
  ];
  return {
    subject: subjectOf("ScheduledBackup", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [{ verb: "create", text: createLine("ScheduledBackup", form.namespace, form.name, parts.join(", ")) }],
    notes: scheduledBackupNotes(inputs, form, now),
    warnings: scheduledBackupSummaryWarnings(inputs, form, now),
  };
}

export function scheduledBackupBlockReason(
  inputs: ScheduledBackupInputs,
  form: ScheduledBackupForm,
  accessReason?: string,
): string | undefined {
  return firstError(SCHEDULE_FIELD_ORDER, scheduledBackupErrors(inputs, form)) ?? accessReason;
}

export function scheduledBackupSuccessMessage(namespace: string, name: string): string {
  return `Requested the scheduled backup ${namespace}/${name}: the operator computes its next run now`;
}
