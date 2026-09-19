/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `backups.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0001 R3). The store feeds the backup facts of
// the health model (H3); SPEC-0005 adds the list and detail pages on top.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { LocalObjectReference } from "./cluster-v1";

/** Label the operator puts on a backup created by a `ScheduledBackup` (SPEC-0005). */
export const PARENT_SCHEDULE_LABEL = "cnpg.io/scheduled-backup";

/** `barmanObjectStore` is the CRD default and is deprecated since 1.26 (SPEC-0001 R3). */
export type BackupMethod = "barmanObjectStore" | "volumeSnapshot" | "plugin";

export type BackupPhase =
  | "pending"
  | "started"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "walArchivingFailing"
  | "invalid backup definition";

export interface BackupPluginConfiguration {
  name: string;
  parameters?: Record<string, string>;
}

export interface BackupSpec {
  cluster: LocalObjectReference;
  method?: BackupMethod;
  target?: "primary" | "prefer-standby";
  online?: boolean;
  onlineConfiguration?: { immediateCheckpoint?: boolean; waitForArchive?: boolean };
  pluginConfiguration?: BackupPluginConfiguration;
}

export interface BackupStatus {
  phase?: BackupPhase | string;
  method?: string;
  online?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  reconciliationStartedAt?: string;
  reconciliationTerminatedAt?: string;
  backupId?: string;
  backupName?: string;
  beginWal?: string;
  endWal?: string;
  beginLSN?: string;
  endLSN?: string;
  error?: string;
  commandError?: string;
  commandOutput?: string;
  instanceID?: { podName?: string; ContainerID?: string; sessionID?: string };
  snapshotBackupStatus?: { elements?: Array<Record<string, unknown>> };
  destinationPath?: string;
  serverName?: string;
  majorVersion?: number;
  pluginMetadata?: Record<string, string>;
  [key: string]: unknown;
}

export class Backup extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  BackupStatus,
  BackupSpec
> {
  static readonly kind = "Backup";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/backups`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "backups",
    singular: "backup",
    shortNames: [],
    title: "Backups",
  };

  static getClusterName(object: Backup): string | undefined {
    return object.spec?.cluster?.name;
  }

  static getPhase(object: Backup): string | undefined {
    return object.status?.phase;
  }

  /** The declared method; the CRD default (`barmanObjectStore`) is deprecated. */
  static getMethod(object: Backup): BackupMethod {
    return object.spec?.method ?? "barmanObjectStore";
  }

  /**
   * The `ScheduledBackup` that created the backup. The label is the only
   * reliable pointer: ownership depends on `spec.backupOwnerReference`.
   */
  static getParentSchedule(object: Backup): string | undefined {
    return object.metadata?.labels?.[PARENT_SCHEDULE_LABEL] || undefined;
  }

  /** The instance pod that took the backup. */
  static getInstancePod(object: Backup): string | undefined {
    return object.status?.instanceID?.podName || undefined;
  }
}

export class BackupApi extends Renderer.K8sApi.KubeApi<Backup> {}
export class BackupStore extends Renderer.K8sApi.KubeObjectStore<Backup, BackupApi> {}
