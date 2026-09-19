/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `failoverquorums.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0011). The kind has a status only: it is written
// by the instance manager of the primary and reset by the operator while the
// PostgreSQL configuration changes. One object per cluster with the failover
// quorum on, named after the cluster.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";

export interface FailoverQuorumStatus {
  /** `ANY` or `FIRST`, in upper case on 1.30.0. */
  method?: string;
  /** The instance that wrote the object last. */
  primary?: string;
  /** The potentially synchronous instances. */
  standbyNames?: string[];
  /** How many standbys a commit waits for. */
  standbyNumber?: number;
}

export class FailoverQuorum extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  FailoverQuorumStatus,
  Record<string, never>
> {
  static readonly kind = "FailoverQuorum";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/failoverquorums`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "failoverquorums",
    singular: "failoverquorum",
    shortNames: [],
    title: "Failover Quorums",
  };
}

export class FailoverQuorumApi extends Renderer.K8sApi.KubeApi<FailoverQuorum> {}
export class FailoverQuorumStore extends Renderer.K8sApi.KubeObjectStore<FailoverQuorum, FailoverQuorumApi> {}
