/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `objectstores.barmancloud.cnpg.io` CRD schema of the
// Barman Cloud plugin v0.15.0 (SPEC-0001 R8, SPEC-0009). The plugin is
// optional: the store of this kind may not exist on a cluster, and every
// reader treats that as "the plugin is not installed", never as an error.

import { Renderer } from "@freelensapp/extensions";

import type { CnpgKubeObjectCRD } from "../types";

export const BARMAN_CLOUD_API_VERSION = "barmancloud.cnpg.io/v1";

/** The plugin name a Cluster or a Backup uses to point at the Barman Cloud plugin. */
export const BARMAN_CLOUD_PLUGIN_NAME = "barman-cloud.cloudnative-pg.io";

export interface SecretKeySelector {
  name: string;
  key: string;
}

export interface ObjectStoreConfiguration {
  destinationPath?: string;
  endpointURL?: string;
  endpointCA?: SecretKeySelector;
  serverName?: string;
  s3Credentials?: {
    accessKeyId?: SecretKeySelector;
    secretAccessKey?: SecretKeySelector;
    sessionToken?: SecretKeySelector;
    region?: SecretKeySelector;
    inheritFromIAMRole?: boolean;
  };
  azureCredentials?: {
    connectionString?: SecretKeySelector;
    storageAccount?: SecretKeySelector;
    storageKey?: SecretKeySelector;
    storageSasToken?: SecretKeySelector;
    inheritFromAzureAD?: boolean;
    useDefaultAzureCredentials?: boolean;
  };
  googleCredentials?: {
    applicationCredentials?: SecretKeySelector;
    gkeEnvironment?: boolean;
  };
  wal?: { compression?: string; encryption?: string; maxParallel?: number; [key: string]: unknown };
  data?: {
    compression?: string;
    encryption?: string;
    jobs?: number;
    immediateCheckpoint?: boolean;
    [key: string]: unknown;
  };
  tags?: Record<string, string>;
  historyTags?: Record<string, string>;
  [key: string]: unknown;
}

export interface ObjectStoreSpec {
  configuration?: ObjectStoreConfiguration;
  retentionPolicy?: string;
  instanceSidecarConfiguration?: Record<string, unknown>;
}

/** The plugin's own account of how far back one server can be recovered. */
export interface ServerRecoveryWindow {
  firstRecoverabilityPoint?: string;
  lastSuccessfulBackupTime?: string;
  lastFailedBackupTime?: string;
}

export interface ObjectStoreStatus {
  /** Keyed by server name: the cluster name unless the cluster overrides it. */
  serverRecoveryWindow?: Record<string, ServerRecoveryWindow>;
  [key: string]: unknown;
}

export class ObjectStore extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  ObjectStoreStatus,
  ObjectStoreSpec
> {
  static readonly kind = "ObjectStore";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${BARMAN_CLOUD_API_VERSION}/objectstores`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [BARMAN_CLOUD_API_VERSION],
    plural: "objectstores",
    singular: "objectstore",
    shortNames: [],
    title: "Object Stores",
  };
}

export class ObjectStoreApi extends Renderer.K8sApi.KubeApi<ObjectStore> {}
export class ObjectStoreStore extends Renderer.K8sApi.KubeObjectStore<ObjectStore, ObjectStoreApi> {}
