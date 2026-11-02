/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `pluginconfigurations.klio.cnpg.io` CRD of Klio
// (cloudnative-pg/klio, Apache-2.0), SPEC-0036. Klio is an optional CNPG-I
// backup plugin: the store of this kind may not exist on a cluster, and every
// reader treats that as "Klio is not installed", never as an error. Only the
// fields the drawer shows are typed.

import { Renderer } from "@freelensapp/extensions";

import type { CnpgKubeObjectCRD, KubeCondition } from "../types";

export const KLIO_API_VERSION = "klio.cnpg.io/v1alpha1";

export interface KlioRetention {
  latest?: number;
  [key: string]: unknown;
}

export interface KlioTier {
  enableBackup?: boolean;
  enableRecovery?: boolean;
  retention?: KlioRetention;
  [key: string]: unknown;
}

export interface PluginConfigurationSpec {
  /** The Cluster this configuration is for. */
  clusterName?: string;
  /** `standard` (default) or `read-only`. */
  mode?: string;
  serverAddress?: string;
  clientSecretName?: string;
  serverSecretName?: string;
  tier1?: KlioTier;
  tier2?: KlioTier;
  walPrefetch?: { count?: number; maxConcurrentDownloads?: number };
}

export interface PluginConfigurationStatus {
  conditions?: KubeCondition[];
}

export class PluginConfiguration extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  PluginConfigurationStatus,
  PluginConfigurationSpec
> {
  static readonly kind = "PluginConfiguration";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${KLIO_API_VERSION}/pluginconfigurations`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [KLIO_API_VERSION],
    plural: "pluginconfigurations",
    singular: "pluginconfiguration",
    shortNames: [],
    title: "Klio Configurations",
  };
}

export class PluginConfigurationApi extends Renderer.K8sApi.KubeApi<PluginConfiguration> {}
export class PluginConfigurationStore extends Renderer.K8sApi.KubeObjectStore<
  PluginConfiguration,
  PluginConfigurationApi
> {}
