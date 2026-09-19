/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `scheduledbackups.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0001 R3). The Overview reads the next
// scheduled backup per cluster (SPEC-0004); SPEC-0005 adds the pages.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { BackupMethod, BackupPluginConfiguration } from "./backup-v1";
import type { LocalObjectReference } from "./cluster-v1";

export interface ScheduledBackupSpec {
  cluster: LocalObjectReference;
  /** Cron expression with a seconds field (six fields, SPEC-0001 R3). */
  schedule: string;
  suspend?: boolean;
  immediate?: boolean;
  backupOwnerReference?: "none" | "self" | "cluster";
  method?: BackupMethod;
  target?: "primary" | "prefer-standby";
  online?: boolean;
  onlineConfiguration?: { immediateCheckpoint?: boolean; waitForArchive?: boolean };
  pluginConfiguration?: BackupPluginConfiguration;
}

export interface ScheduledBackupStatus {
  lastCheckTime?: string;
  lastScheduleTime?: string;
  nextScheduleTime?: string;
  error?: string;
  [key: string]: unknown;
}

export class ScheduledBackup extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  ScheduledBackupStatus,
  ScheduledBackupSpec
> {
  static readonly kind = "ScheduledBackup";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/scheduledbackups`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "scheduledbackups",
    singular: "scheduledbackup",
    shortNames: [],
    title: "Scheduled Backups",
  };

  static getClusterName(object: ScheduledBackup): string | undefined {
    return object.spec?.cluster?.name;
  }

  static isSuspended(object: ScheduledBackup): boolean {
    return object.spec?.suspend ?? false;
  }
}

export class ScheduledBackupApi extends Renderer.K8sApi.KubeApi<ScheduledBackup> {}
export class ScheduledBackupStore extends Renderer.K8sApi.KubeObjectStore<ScheduledBackup, ScheduledBackupApi> {}
