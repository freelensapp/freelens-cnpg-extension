/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `clusters.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0001 R2, R4; SPEC-0003 "CRD model"). The status
// carries the full surface the operator writes; the spec is limited to what
// the views read. Unknown keys are tolerated through index signatures so a
// newer operator never breaks the parsing.

import { Renderer } from "@freelensapp/extensions";

import type { CnpgKubeObjectCRD, KubeCondition } from "../types";

export const CNPG_API_GROUP = "postgresql.cnpg.io";
export const CNPG_API_VERSION = `${CNPG_API_GROUP}/v1`;

/** Annotation carrying the JSON list of fenced instance names, or `["*"]`. */
export const FENCED_INSTANCES_ANNOTATION = "cnpg.io/fencedInstances";
/** Annotation switching the whole cluster off: `on` or `off`. */
export const HIBERNATION_ANNOTATION = "cnpg.io/hibernation";

export interface LocalObjectReference {
  name: string;
}

export interface StorageConfiguration {
  size?: string;
  storageClass?: string;
  resizeInUseVolumes?: boolean;
  pvcTemplate?: Record<string, unknown>;
}

export interface PluginConfiguration {
  name: string;
  enabled?: boolean;
  isWALArchiver?: boolean;
  parameters?: Record<string, string>;
}

export interface BackupConfiguration {
  target?: "primary" | "prefer-standby";
  retentionPolicy?: string;
  /** Deprecated in-tree method (SPEC-0001 R8): shown with a "deprecated" badge, never generated. */
  barmanObjectStore?: Record<string, unknown>;
  volumeSnapshot?: Record<string, unknown>;
}

export interface SynchronousReplicaConfiguration {
  method?: "any" | "first";
  number?: number;
  dataDurability?: "required" | "preferred";
  failoverQuorum?: boolean;
  maxStandbyNamesFromCluster?: number;
  standbyNamesPre?: string[];
  standbyNamesPost?: string[];
}

export interface PostgresConfiguration {
  parameters?: Record<string, string>;
  pg_hba?: string[];
  pg_ident?: string[];
  shared_preload_libraries?: string[];
  synchronous?: SynchronousReplicaConfiguration;
  enableAlterSystem?: boolean;
  promotionTimeout?: number;
  [key: string]: unknown;
}

export interface MonitoringConfiguration {
  enablePodMonitor?: boolean;
  disableDefaultQueries?: boolean;
  metricsQueriesTTL?: string;
  /** Opt-in TLS on the metrics port, with the PostgreSQL server certificate (SPEC-0001 R6). */
  tls?: { enabled?: boolean };
  customQueriesConfigMap?: Array<{ name: string; key: string }>;
  customQueriesSecret?: Array<{ name: string; key: string }>;
  [key: string]: unknown;
}

export interface ReplicaClusterConfiguration {
  enabled?: boolean;
  source?: string;
  primary?: string;
  self?: string;
  promotionToken?: string;
  minApplyDelay?: string;
}

export interface CertificatesConfiguration {
  serverCASecret?: string;
  serverTLSSecret?: string;
  clientCASecret?: string;
  replicationTLSSecret?: string;
  serverAltDNSNames?: string[];
}

export interface ImageCatalogRef {
  apiGroup?: string;
  kind: string;
  name: string;
  major: number;
}

export interface ExternalCluster {
  name: string;
  connectionParameters?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClusterSpec {
  instances: number;
  description?: string;
  imageName?: string;
  imageCatalogRef?: ImageCatalogRef;
  postgresql?: PostgresConfiguration;
  storage?: StorageConfiguration;
  walStorage?: StorageConfiguration;
  backup?: BackupConfiguration;
  plugins?: PluginConfiguration[];
  monitoring?: MonitoringConfiguration;
  bootstrap?: Record<string, unknown>;
  replica?: ReplicaClusterConfiguration;
  enableSuperuserAccess?: boolean;
  superuserSecret?: LocalObjectReference;
  primaryUpdateStrategy?: "unsupervised" | "supervised";
  primaryUpdateMethod?: "switchover" | "restart";
  minSyncReplicas?: number;
  maxSyncReplicas?: number;
  resources?: Record<string, unknown>;
  affinity?: Record<string, unknown>;
  certificates?: CertificatesConfiguration;
  externalClusters?: ExternalCluster[];
  managed?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CertificatesStatus extends CertificatesConfiguration {
  /** Secret name to expiry in the Go `time.String()` layout (SPEC-0001 R2). */
  expirations?: Record<string, string>;
}

export interface ImageInfo {
  image: string;
  majorVersion: number;
  extensions?: Array<{ name: string; [key: string]: unknown }>;
}

export interface InstanceReportedState {
  isPrimary?: boolean;
  timeLineID?: number;
  ip?: string;
}

export type InstancesStatusGroup = "healthy" | "replicating" | "failed";

export interface Topology {
  /** Instance name to placement details; empty objects on 1.30.0. */
  instances?: Record<string, Record<string, unknown>>;
  nodesUsed?: number;
  successfullyExtracted?: boolean;
}

export interface PluginStatus {
  name: string;
  version?: string;
  status?: string;
  capabilities?: string[];
  operatorCapabilities?: string[];
  walCapabilities?: string[];
  backupCapabilities?: string[];
  restoreJobHookCapabilities?: string[];
}

export interface TablespaceStatus {
  name: string;
  owner?: string;
  state?: string;
  error?: string;
}

export interface ManagedRolesStatus {
  byStatus?: Record<string, string[]>;
  cannotReconcile?: Record<string, string[]>;
  passwordStatus?: Record<string, { resourceVersion?: string; transactionID?: number }>;
}

export interface ClusterStatus {
  phase?: string;
  phaseReason?: string;
  instances?: number;
  /** Omitted from the JSON when zero (SPEC-0003 notes): readers treat absent as 0. */
  readyInstances?: number;
  instanceNames?: string[];
  instancesStatus?: Partial<Record<InstancesStatusGroup, string[]>>;
  instancesReportedState?: Record<string, InstanceReportedState>;
  currentPrimary?: string;
  targetPrimary?: string;
  currentPrimaryTimestamp?: string;
  currentPrimaryFailingSinceTimestamp?: string;
  targetPrimaryTimestamp?: string;
  timelineID?: number;
  topology?: Topology;
  writeService?: string;
  readService?: string;
  image?: string;
  pgDataImageInfo?: ImageInfo;
  targetPgDataImageInfo?: ImageInfo;
  systemID?: string;
  conditions?: KubeCondition[];
  certificates?: CertificatesStatus;
  pluginStatus?: PluginStatus[];
  poolerIntegrations?: { pgBouncerIntegration?: { secrets?: string[] } };
  managedRolesStatus?: ManagedRolesStatus;
  tablespacesStatus?: TablespaceStatus[];
  healthyPVC?: string[];
  danglingPVC?: string[];
  resizingPVC?: string[];
  initializingPVC?: string[];
  unusablePVC?: string[];
  pvcCount?: number;
  jobCount?: number;
  switchReplicaClusterStatus?: { inProgress?: boolean };
  onlineUpdateEnabled?: boolean;
  availableArchitectures?: Array<{ goArch: string; hash: string }>;
  cloudNativePGOperatorHash?: string;
  cloudNativePGCommitHash?: string;
  /** Deprecated with plugin backups (SPEC-0001 H3): fallback only. */
  firstRecoverabilityPoint?: string;
  firstRecoverabilityPointByMethod?: Record<string, string>;
  lastSuccessfulBackup?: string;
  lastSuccessfulBackupByMethod?: Record<string, string>;
  lastFailedBackup?: string;
  [key: string]: unknown;
}

export class Cluster extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  ClusterStatus,
  ClusterSpec
> {
  static readonly kind = "Cluster";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/clusters`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "clusters",
    singular: "cluster",
    shortNames: [],
    title: "PostgreSQL Clusters",
  };

  /** `true` when the hibernation annotation is `on` (SPEC-0001 H1). */
  static getHibernation(object: Cluster): boolean {
    return object.metadata?.annotations?.[HIBERNATION_ANNOTATION]?.trim().toLowerCase() === "on";
  }

  /**
   * Names of the fenced instances from the annotation; `["*"]` expands to
   * every known instance. Malformed annotations count as no fencing.
   */
  static getFencedInstances(object: Cluster): string[] {
    const raw = object.metadata?.annotations?.[FENCED_INSTANCES_ANNOTATION];
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const names = parsed.filter((item): item is string => typeof item === "string");
    if (names.includes("*")) {
      return [...(object.status?.instanceNames ?? [])];
    }
    return names;
  }

  static getCondition(object: Cluster, type: string): KubeCondition | undefined {
    return object.status?.conditions?.find((condition) => condition.type === type);
  }

  /** The current primary instance name, when the status reports one. */
  static getPrimary(object: Cluster): string | undefined {
    return object.status?.currentPrimary || undefined;
  }

  /** Declared instances, from the status when present, else from the spec. */
  static getInstances(object: Cluster): number {
    return object.status?.instances ?? object.spec?.instances ?? 0;
  }

  /** Ready instances; the operator omits the field when zero. */
  static getReadyInstances(object: Cluster): number {
    return object.status?.readyInstances ?? 0;
  }
}

export class ClusterApi extends Renderer.K8sApi.KubeApi<Cluster> {}
export class ClusterStore extends Renderer.K8sApi.KubeObjectStore<Cluster, ClusterApi> {}
