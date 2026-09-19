/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `subscriptions.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0015): the consuming end of a logical
// replication. The publisher is an entry of `externalClusters` of the
// subscriber cluster, named by `externalClusterName`.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { LocalObjectReference } from "./cluster-v1";
import type { DeclarativeStatus, ReclaimPolicy } from "./database-v1";

export interface SubscriptionSpec {
  cluster: LocalObjectReference;
  dbname: string;
  /** The name inside PostgreSQL. */
  name: string;
  externalClusterName: string;
  publicationName: string;
  /** Defaults to the database of the external cluster entry. */
  publicationDBName?: string;
  /** The `WITH` clause of `CREATE SUBSCRIPTION`. */
  parameters?: Record<string, string>;
  subscriptionReclaimPolicy?: ReclaimPolicy;
}

export class Subscription extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  DeclarativeStatus,
  SubscriptionSpec
> {
  static readonly kind = "Subscription";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/subscriptions`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "subscriptions",
    singular: "subscription",
    shortNames: [],
    title: "Subscriptions",
  };

  static getClusterName(object: Subscription): string | undefined {
    return object.spec?.cluster?.name || undefined;
  }
}

export class SubscriptionApi extends Renderer.K8sApi.KubeApi<Subscription> {}
export class SubscriptionStore extends Renderer.K8sApi.KubeObjectStore<Subscription, SubscriptionApi> {}
