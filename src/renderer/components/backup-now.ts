/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Everything the "Back up now" action decides (SPEC-0020), as pure functions
// over structurally declared inputs: the guard, the methods a cluster can be
// backed up with, the form defaults and their validation, the sentences of
// the dialog and the body of the one `create` it sends.
//
// The method is never left out of the body: the CRD default is the deprecated
// in-tree method, which fails on a cluster that only uses a plugin.

import { scheduleRunPattern } from "./scheduled-backup-actions";
import { compactTimestamp, disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export type BackupMethodKind = "plugin" | "volumeSnapshot" | "barmanObjectStore";
export type BackupTargetChoice = "default" | "primary" | "prefer-standby";

/** One way this cluster can be backed up, as the form offers it. */
export interface BackupMethodOption {
  /** Stable value of the select: `plugin:<name>`, `volumeSnapshot`, `barmanObjectStore`. */
  id: string;
  method: BackupMethodKind;
  /** The plugin, for the plugin method. */
  pluginName?: string;
  label: string;
  deprecated: boolean;
}

export interface BackupNowClusterFacts {
  name: string;
  namespace: string;
  hibernated: boolean;
  spec?: {
    plugins?: Array<{ name: string; enabled?: boolean; isWALArchiver?: boolean }>;
    backup?: {
      target?: "primary" | "prefer-standby";
      barmanObjectStore?: unknown;
      volumeSnapshot?: unknown;
    };
  };
  status?: {
    currentPrimary?: string;
    readyInstances?: number;
  };
}

/** A backup of the cluster, as far as the queue note needs it. */
export interface ExistingBackupFacts {
  name: string;
  phase?: string;
}

export interface BackupNowForm {
  methodId: string;
  target: BackupTargetChoice;
  name: string;
}

export const HIBERNATED_BACKUP_REASON = "The operator fails a backup requested on a hibernated cluster";
export const NO_BACKUP_METHOD_REASON =
  "The cluster declares no backup plugin and no backup section: the operator would fail the backup";

const DONE_PHASES: readonly string[] = ["completed", "failed"];

/** The methods the cluster declares, the WAL archiver plugin first, the deprecated one last. */
export function backupMethodOptions(cluster: BackupNowClusterFacts): BackupMethodOption[] {
  const plugins = (cluster.spec?.plugins ?? [])
    .filter((plugin) => plugin.name && plugin.enabled !== false)
    .sort((a, b) => Number(b.isWALArchiver === true) - Number(a.isWALArchiver === true));
  const options: BackupMethodOption[] = plugins.map((plugin) => ({
    id: `plugin:${plugin.name}`,
    method: "plugin",
    pluginName: plugin.name,
    label: `Plugin ${plugin.name}`,
    deprecated: false,
  }));
  if (cluster.spec?.backup?.volumeSnapshot) {
    options.push({ id: "volumeSnapshot", method: "volumeSnapshot", label: "Volume snapshot", deprecated: false });
  }
  if (cluster.spec?.backup?.barmanObjectStore) {
    options.push({
      id: "barmanObjectStore",
      method: "barmanObjectStore",
      label: "In-tree Barman object store (deprecated)",
      deprecated: true,
    });
  }
  return options;
}

export function canBackUpNow(cluster: BackupNowClusterFacts): ActionGuard {
  if (cluster.hibernated) return disabledGuard(HIBERNATED_BACKUP_REASON);
  if (backupMethodOptions(cluster).length === 0) return disabledGuard(NO_BACKUP_METHOD_REASON);
  return enabledGuard;
}

export function defaultBackupName(clusterName: string, now: Date): string {
  return `${clusterName}-${compactTimestamp(now)}`;
}

/** The preselected method is the first one: a deprecated method comes last, so it is chosen only when alone. */
export function defaultBackupForm(cluster: BackupNowClusterFacts, now: Date): BackupNowForm {
  return {
    methodId: backupMethodOptions(cluster)[0]?.id ?? "",
    target: "default",
    name: defaultBackupName(cluster.name, now),
  };
}

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * Why the name cannot be used, or undefined. A name of the form
 * `<schedule>-<14 digits>` for a schedule of this cluster is refused: the
 * operator would find the name taken when that run is due and skip it.
 */
export function backupNameError(
  name: string,
  scheduleNames: readonly string[],
  existing: readonly ExistingBackupFacts[],
): string | undefined {
  if (!name) return "A name is required";
  if (name.length > 253) return "The name is longer than 253 characters";
  if (!DNS_SUBDOMAIN.test(name)) {
    return "Lowercase letters, digits, '-' and '.', starting and ending with a letter or a digit";
  }
  const schedule = scheduleNames.find((candidate) => scheduleRunPattern(candidate).test(name));
  if (schedule) {
    return `This is the form of a run of the schedule ${schedule}: the operator would skip that run`;
  }
  if (existing.some((backup) => backup.name === name)) return "A backup with this name exists already";
  return undefined;
}

/** What "The cluster's default" resolves to, in words. */
export function resolvedTargetSentence(cluster: BackupNowClusterFacts, choice: BackupTargetChoice): string {
  const declared = cluster.spec?.backup?.target;
  const effective = choice === "default" ? (declared ?? "prefer-standby") : choice;
  const primary = cluster.status?.currentPrimary;
  const source =
    choice !== "default"
      ? ""
      : declared
        ? " (the cluster's .spec.backup.target)"
        : " (the operator's default: the cluster declares none)";
  if (effective === "primary") {
    return `Taken from the primary${primary ? ` ${primary}` : ""}${source}.`;
  }
  return `Taken from a ready standby when there is one, from the primary${primary ? ` ${primary}` : ""} otherwise${source}.`;
}

/** The backups of this cluster that are not finished: the new one waits its turn behind them. */
export function unfinishedBackups(existing: readonly ExistingBackupFacts[]): ExistingBackupFacts[] {
  return existing.filter((backup) => !DONE_PHASES.includes(backup.phase ?? ""));
}

export function backupNowNotes(
  cluster: BackupNowClusterFacts,
  form: BackupNowForm,
  existing: readonly ExistingBackupFacts[],
): string[] {
  const notes = [resolvedTargetSentence(cluster, form.target)];
  const waiting = unfinishedBackups(existing);
  if (waiting.length > 0) {
    notes.push(
      `${waiting.length === 1 ? "1 backup" : `${waiting.length} backups`} of this cluster ${
        waiting.length === 1 ? "is" : "are"
      } not finished (${waiting.map((backup) => backup.name).join(", ")}): the operator runs one at a time, oldest first, so this one waits its turn.`,
    );
  }
  if ((cluster.status?.readyInstances ?? 0) === 0) {
    notes.push("No instance is ready right now: the backup stays pending until one is.");
  }
  notes.push("The spec of a backup cannot be edited once it is created.");
  return notes;
}

export function backupNowWarnings(form: BackupNowForm, options: readonly BackupMethodOption[]): string[] {
  const option = options.find((candidate) => candidate.id === form.methodId);
  return option?.deprecated
    ? ["The in-tree Barman object store method is deprecated upstream: prefer the Barman Cloud plugin."]
    : [];
}

export interface BackupBody {
  apiVersion: "postgresql.cnpg.io/v1";
  kind: "Backup";
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    cluster: { name: string };
    method: BackupMethodKind;
    target?: "primary" | "prefer-standby";
    pluginConfiguration?: { name: string };
  };
}

/** The body of the one `create`. Undefined when the form names a method the cluster does not offer. */
export function backupNowBody(cluster: BackupNowClusterFacts, form: BackupNowForm): BackupBody | undefined {
  const option = backupMethodOptions(cluster).find((candidate) => candidate.id === form.methodId);
  if (!option) return undefined;
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: {
      name: form.name,
      namespace: cluster.namespace,
      labels: { "cnpg.io/cluster": cluster.name },
    },
    spec: {
      cluster: { name: cluster.name },
      method: option.method,
      ...(form.target === "default" ? {} : { target: form.target }),
      ...(option.pluginName ? { pluginConfiguration: { name: option.pluginName } } : {}),
    },
  };
}

function methodWords(body: BackupBody): string {
  return body.spec.pluginConfiguration
    ? `method plugin (${body.spec.pluginConfiguration.name})`
    : `method ${body.spec.method}`;
}

/** The facts of the dialog, recomputed as the form changes. */
export function backupNowDialogFacts(
  cluster: BackupNowClusterFacts,
  form: BackupNowForm,
  existing: readonly ExistingBackupFacts[],
): ActionDialogFacts {
  const body = backupNowBody(cluster, form);
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: body
      ? [
          {
            verb: "create",
            text: `create Backup ${cluster.namespace}/${form.name || "<name>"}: cluster ${cluster.name}, ${methodWords(body)}${
              body.spec.target ? `, target ${body.spec.target}` : ""
            }, label cnpg.io/cluster=${cluster.name}`,
          },
        ]
      : [],
    notes: backupNowNotes(cluster, form, existing),
    warnings: backupNowWarnings(form, backupMethodOptions(cluster)),
  };
}

/** Why OK is disabled, or undefined. */
export function backupNowBlockReason(
  cluster: BackupNowClusterFacts,
  form: BackupNowForm,
  scheduleNames: readonly string[],
  existing: readonly ExistingBackupFacts[],
): string | undefined {
  if (!backupNowBody(cluster, form)) return "Choose a method";
  return backupNameError(form.name, scheduleNames, existing);
}
