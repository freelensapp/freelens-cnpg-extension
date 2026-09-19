/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the Barman Cloud object stores (SPEC-0009): what kind of store
// it is, which clusters write to it and under which server name, and the
// recovery window the plugin itself reports for each of them. No JSX, no
// colors: states map to the host's status classes as everywhere else.

import { BARMAN_CLOUD_PLUGIN_NAME } from "../api/barmancloud/object-store-v1";
import { parseGoTime } from "./go-time";

import type { ObjectStore } from "../api/barmancloud/object-store-v1";
import type { Cluster } from "../api/cnpg/cluster-v1";
import type { HostStatusClass } from "./cluster-health";

export type StoreProvider = "S3" | "S3 compatible" | "Azure Blob" | "Google Cloud Storage" | "Unknown";

/** What kind of object storage the store points at, from its path and its credentials. */
export function storeProvider(store: ObjectStore): StoreProvider {
  const configuration = store.spec?.configuration;
  const path = configuration?.destinationPath?.toLowerCase() ?? "";
  if (configuration?.azureCredentials || path.startsWith("azure://") || path.includes(".blob.core.")) {
    return "Azure Blob";
  }
  if (configuration?.googleCredentials || path.startsWith("gs://")) return "Google Cloud Storage";
  if (configuration?.s3Credentials || path.startsWith("s3://")) {
    return configuration?.endpointURL ? "S3 compatible" : "S3";
  }
  return "Unknown";
}

export interface StoreCluster {
  cluster: Cluster;
  name: string;
  /** The name the cluster writes under in the bucket: its own unless it overrides it. */
  serverName: string;
  /** True when the store receives the WAL of the cluster, not only its backups. */
  walArchiver: boolean;
}

/** The plugin entry of a cluster that names the store, if any. */
function pluginEntryFor(cluster: Cluster, storeName: string) {
  return cluster.spec?.plugins?.find(
    (plugin) =>
      plugin.name === BARMAN_CLOUD_PLUGIN_NAME &&
      plugin.enabled !== false &&
      plugin.parameters?.barmanObjectName === storeName,
  );
}

/** The clusters of the store's namespace whose Barman Cloud plugin entry names it. */
export function clustersOfStore(store: ObjectStore, clusters: readonly Cluster[]): StoreCluster[] {
  const storeName = store.metadata?.name ?? "";
  const namespace = store.metadata?.namespace;
  const found: StoreCluster[] = [];
  for (const cluster of clusters) {
    if (cluster.metadata?.namespace !== namespace) continue;
    const entry = pluginEntryFor(cluster, storeName);
    if (!entry) continue;
    const name = cluster.metadata?.name ?? "";
    found.push({
      cluster,
      name,
      serverName: entry.parameters?.serverName || name,
      walArchiver: entry.isWALArchiver ?? false,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The store a cluster writes to and the server name it uses, from its plugin entry. */
export function storeOfCluster(cluster: Cluster): { storeName: string; serverName: string } | undefined {
  const entry = cluster.spec?.plugins?.find(
    (plugin) =>
      plugin.name === BARMAN_CLOUD_PLUGIN_NAME && plugin.enabled !== false && plugin.parameters?.barmanObjectName,
  );
  const storeName = entry?.parameters?.barmanObjectName;
  if (!storeName) return undefined;
  return { storeName, serverName: entry?.parameters?.serverName || (cluster.metadata?.name ?? "") };
}

export type RecoveryWindowState = "Protected" | "Failing" | "Empty";

export interface RecoveryWindow {
  serverName: string;
  /** The cluster that writes under this server name; absent for an orphan (a deleted cluster still in the bucket). */
  cluster?: StoreCluster;
  firstRecoverabilityPoint?: Date;
  lastSuccessfulBackup?: Date;
  lastFailedBackup?: Date;
  state: RecoveryWindowState;
}

/** One entry per server the plugin reports, joined to its cluster when there is one; failing first, then by name. */
export function recoveryWindows(store: ObjectStore, clusters: readonly Cluster[]): RecoveryWindow[] {
  const writers = clustersOfStore(store, clusters);
  const windows = Object.entries(store.status?.serverRecoveryWindow ?? {}).map(([serverName, window]) => {
    const lastSuccessfulBackup = parseGoTime(window.lastSuccessfulBackupTime);
    const lastFailedBackup = parseGoTime(window.lastFailedBackupTime);
    let state: RecoveryWindowState = "Empty";
    if (lastFailedBackup && (!lastSuccessfulBackup || lastFailedBackup.getTime() > lastSuccessfulBackup.getTime())) {
      state = "Failing";
    } else if (lastSuccessfulBackup) {
      state = "Protected";
    }
    return {
      serverName,
      cluster: writers.find((writer) => writer.serverName === serverName),
      firstRecoverabilityPoint: parseGoTime(window.firstRecoverabilityPoint),
      lastSuccessfulBackup,
      lastFailedBackup,
      state,
    };
  });
  const rank: Record<RecoveryWindowState, number> = { Failing: 0, Empty: 1, Protected: 2 };
  return windows.sort((a, b) => rank[a.state] - rank[b.state] || a.serverName.localeCompare(b.serverName));
}

/** The earliest point any server of the store can be recovered from. */
export function oldestRecoveryPoint(windows: readonly RecoveryWindow[]): Date | undefined {
  return windows.reduce<Date | undefined>((oldest, window) => {
    const point = window.firstRecoverabilityPoint;
    if (!point) return oldest;
    return !oldest || point.getTime() < oldest.getTime() ? point : oldest;
  }, undefined);
}

export type StoreState = "In use" | "Unused" | "Failing";

export interface StoreHealth {
  state: StoreState;
  label: StoreState;
  className: HostStatusClass;
  reason: string;
}

export function classifyStore(store: ObjectStore, clusters: readonly Cluster[]): StoreHealth {
  const writers = clustersOfStore(store, clusters);
  const windows = recoveryWindows(store, clusters);
  const failing = windows.filter((window) => window.state === "Failing");
  if (failing.length > 0) {
    return {
      state: "Failing",
      label: "Failing",
      className: "error",
      reason: `The last backup failed for ${failing.map((window) => window.serverName).join(", ")}`,
    };
  }
  if (writers.length === 0) {
    const orphans = windows.length;
    return {
      state: "Unused",
      label: "Unused",
      className: "info",
      reason:
        orphans > 0
          ? `No cluster writes here; the bucket still holds ${orphans} server${orphans === 1 ? "" : "s"}`
          : "No cluster writes here",
    };
  }
  return {
    state: "In use",
    label: "In use",
    className: "success",
    reason: `${writers.length} cluster${writers.length === 1 ? "" : "s"}: ${writers.map((writer) => writer.name).join(", ")}`,
  };
}
