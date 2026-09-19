/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `poolers.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0012): a PgBouncer deployment in front of one
// service type of a cluster. The pod template and the service template of the
// spec are left out: the views read what PgBouncer does, not how its pod is
// shaped (the host's own Pod and Service views show that).

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { LocalObjectReference } from "./cluster-v1";

export type PoolerType = "rw" | "ro" | "r";
export type PoolerPhase = "active" | "paused" | "inactive" | "failed";

export interface PgBouncerSpec {
  poolMode?: "session" | "transaction";
  parameters?: Record<string, string>;
  paused?: boolean;
  image?: string;
  imageCatalogRef?: { apiGroup?: string; kind?: string; name?: string; key?: string };
  pg_hba?: string[];
  authQuery?: string;
  authQuerySecret?: LocalObjectReference;
  clientCASecret?: LocalObjectReference;
  clientTLSSecret?: LocalObjectReference;
  serverCASecret?: LocalObjectReference;
  serverTLSSecret?: LocalObjectReference;
}

export interface PoolerSpec {
  cluster: LocalObjectReference;
  type?: PoolerType;
  instances?: number;
  pgbouncer?: PgBouncerSpec;
  monitoring?: { enablePodMonitor?: boolean; tls?: { enabled?: boolean }; [key: string]: unknown };
  serviceAccountName?: string;
  [key: string]: unknown;
}

export interface PoolerSecretVersion {
  name?: string;
  version?: string;
}

export interface PoolerStatus {
  phase?: PoolerPhase | string;
  phaseReason?: string;
  error?: string;
  /** Ready PgBouncer instances. */
  instances?: number;
  image?: string;
  secrets?: {
    clientCA?: PoolerSecretVersion;
    clientTLS?: PoolerSecretVersion;
    serverCA?: PoolerSecretVersion;
    serverTLS?: PoolerSecretVersion;
    pgBouncerSecrets?: { authQuery?: PoolerSecretVersion };
  };
}

/** The label the operator puts on the deployment, the service and the pods of a pooler. */
export const POOLER_NAME_LABEL = "cnpg.io/poolerName";

export class Pooler extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  PoolerStatus,
  PoolerSpec
> {
  static readonly kind = "Pooler";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/poolers`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "poolers",
    singular: "pooler",
    shortNames: [],
    title: "Poolers",
  };

  static getClusterName(object: Pooler): string | undefined {
    return object.spec?.cluster?.name;
  }
}

export class PoolerApi extends Renderer.K8sApi.KubeApi<Pooler> {}
export class PoolerStore extends Renderer.K8sApi.KubeObjectStore<Pooler, PoolerApi> {}
