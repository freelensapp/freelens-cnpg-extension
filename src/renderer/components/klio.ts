/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What a Klio PluginConfiguration says (SPEC-0036), read-only: the cluster it
// is for and whether that cluster uses it, where its server is, the tiers and
// their retention, and the readiness the controller reports. Pure.

import { KLIO_PLUGIN } from "./install-guide";

import type { PluginConfiguration } from "../api/klio/plugin-configuration-v1alpha1";
import type { HostStatusClass } from "./cluster-health";

interface ClusterLike {
  metadata?: { name?: string; namespace?: string };
  spec?: { plugins?: { name: string; enabled?: boolean; parameters?: Record<string, string> }[] };
}

export interface KlioFacts {
  cluster?: string;
  /** The clusters of the namespace whose Klio plugin entry names this configuration. */
  usedBy: string[];
  /** The cluster the spec names does not refer to it: nothing uses this configuration. */
  unused: boolean;
  mode: string;
  server?: string;
  tiers: { tier: string; words: string }[];
  state: "Ready" | "Not ready" | "Unknown";
  className: HostStatusClass;
  reason: string;
}

function tierWords(tier: PluginConfiguration["spec"]["tier1"] | undefined, second: boolean): string | undefined {
  if (!tier) return undefined;
  const parts: string[] = [];
  if (second) {
    parts.push(tier.enableBackup ? "backups copied" : "no backups");
    parts.push(tier.enableRecovery ? "recovery from it" : "no recovery from it");
  }
  if (tier.retention?.latest !== undefined) parts.push(`keeps the latest ${tier.retention.latest}`);
  return parts.length > 0 ? parts.join(", ") : "default settings";
}

export function klioFacts(configuration: PluginConfiguration, clusters: readonly ClusterLike[]): KlioFacts {
  const name = configuration.metadata?.name;
  const namespace = configuration.metadata?.namespace;
  const usedBy = clusters
    .filter(
      (cluster) =>
        cluster.metadata?.namespace === namespace &&
        cluster.spec?.plugins?.some(
          (plugin) =>
            plugin.name === KLIO_PLUGIN &&
            plugin.enabled !== false &&
            plugin.parameters?.pluginConfigurationRef === name,
        ),
    )
    .map((cluster) => cluster.metadata?.name ?? "")
    .sort();
  const spec = configuration.spec;
  const ready = configuration.status?.conditions?.find((condition) => condition.type === "Ready");
  const state = !ready ? "Unknown" : ready.status === "True" ? "Ready" : "Not ready";
  const tiers = [
    { tier: "Tier 1", words: tierWords(spec?.tier1, false) },
    { tier: "Tier 2", words: tierWords(spec?.tier2, true) },
  ].filter((entry): entry is { tier: string; words: string } => entry.words !== undefined);
  return {
    cluster: spec?.clusterName,
    usedBy,
    unused: usedBy.length === 0,
    mode: spec?.mode ?? "standard",
    server: spec?.serverAddress,
    tiers,
    state,
    className: state === "Ready" ? "success" : state === "Not ready" ? "error" : "info",
    reason: ready?.message || (ready ? ready.reason || state : "The controller reports no Ready condition"),
  };
}
