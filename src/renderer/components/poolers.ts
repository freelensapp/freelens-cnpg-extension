/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the PgBouncer poolers (SPEC-0012): the state of a pooler in
// the closed set the list shows, what its type means, the host an application
// connects to, and which poolers front a cluster or follow an image catalog.

import { Pooler } from "../api/cnpg/pooler-v1";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { AnyImageCatalog } from "../api/cnpg/image-catalog-v1";
import type { PoolerType } from "../api/cnpg/pooler-v1";
import type { HostStatusClass } from "./cluster-health";

export type PoolerState = "Active" | "Progressing" | "Paused" | "Inactive" | "Failed" | "Unknown";

export interface PoolerHealth {
  state: PoolerState;
  label: PoolerState;
  className: HostStatusClass;
  reason: string;
}

const PRESENTATION: Record<PoolerState, HostStatusClass> = {
  Active: "success",
  Progressing: "info",
  Paused: "warning",
  Inactive: "info",
  Failed: "error",
  Unknown: "info",
};

function health(state: PoolerState, reason: string): PoolerHealth {
  return { state, label: state, className: PRESENTATION[state], reason };
}

export function poolerInstances(pooler: Pooler): { ready: number; declared: number } {
  return { ready: pooler.status?.instances ?? 0, declared: pooler.spec?.instances ?? 1 };
}

export function classifyPooler(pooler: Pooler): PoolerHealth {
  const status = pooler.status;
  const { ready, declared } = poolerInstances(pooler);
  const why = status?.phaseReason?.trim() || status?.error?.trim().split("\n")[0];

  switch (status?.phase) {
    case "failed":
      return health("Failed", why || "The pooler failed");
    case "paused":
      return health("Paused", "Paused: clients queue until it is resumed");
    case "inactive":
      return health("Inactive", why || "Inactive: its cluster is not ready for it");
    case "active":
      return ready < declared
        ? health("Progressing", `${ready} of ${declared} PgBouncer instances ready`)
        : health("Active", `${ready} of ${declared} PgBouncer instances ready`);
    case undefined:
    case "":
      return health("Unknown", "No status reported yet");
    default:
      return health("Unknown", `Unknown phase "${status?.phase}"`);
  }
}

const TYPE_WORDS: Record<PoolerType, string> = {
  rw: "rw (primary)",
  ro: "ro (replicas)",
  r: "r (any instance)",
};

/** What the pooler fronts, in words: the service type of the cluster it connects to. */
export function poolerTypeWords(pooler: Pooler): string {
  const type = pooler.spec?.type ?? "rw";
  return TYPE_WORDS[type] ?? type;
}

/** What an application puts in its connection string. */
export function poolerServiceHost(pooler: Pooler): string {
  return `${pooler.metadata?.name ?? ""}.${pooler.metadata?.namespace ?? ""}.svc`;
}

/** The poolers in front of a cluster: same namespace, `spec.cluster.name`. */
export function poolersOfCluster(cluster: Cluster, poolers: readonly Pooler[]): Pooler[] {
  return poolers
    .filter(
      (pooler) =>
        Pooler.getClusterName(pooler) === cluster.metadata?.name &&
        pooler.metadata?.namespace === cluster.metadata?.namespace,
    )
    .sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
}

export interface CatalogPooler {
  pooler: Pooler;
  name: string;
  namespace: string;
  key: string;
  /** The image the catalog offers under that key. */
  offered?: string;
}

/** The poolers that take their PgBouncer image from a catalog, by kind, name and, for the namespaced kind, namespace. */
export function poolersOfCatalog(catalog: AnyImageCatalog, poolers: readonly Pooler[]): CatalogPooler[] {
  const clusterScoped = catalog.kind === "ClusterImageCatalog";
  const found: CatalogPooler[] = [];
  for (const pooler of poolers) {
    const ref = pooler.spec?.pgbouncer?.imageCatalogRef;
    if (!ref || ref.name !== catalog.metadata?.name) continue;
    if ((ref.kind || "ImageCatalog") !== (clusterScoped ? "ClusterImageCatalog" : "ImageCatalog")) continue;
    if (!clusterScoped && pooler.metadata?.namespace !== catalog.metadata?.namespace) continue;
    const key = ref.key ?? "";
    found.push({
      pooler,
      name: pooler.metadata?.name ?? "",
      namespace: pooler.metadata?.namespace ?? "",
      key,
      offered: catalog.spec?.componentImages?.find((component) => component.key === key)?.image,
    });
  }
  return found.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
