/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The failover quorum in words (SPEC-0011). Before promoting a replica the
// operator checks `R + W > N`: R the promotable replicas, W the replicas a
// commit waits for, N the potentially synchronous replicas. R is what the
// extension can see of it (the named standbys the cluster status reports
// healthy): an estimate for the reader, never the operator's own check.

import { Cluster } from "../api/cnpg/cluster-v1";
import { instanceFacts } from "./cluster-health";

import type { FailoverQuorum } from "../api/cnpg/failover-quorum-v1";
import type { HostStatusClass } from "./cluster-health";

export type QuorumState = "Safe" | "At risk" | "Stale" | "Reset" | "Orphan";

export interface QuorumStandby {
  name: string;
  /** Healthy per `Cluster.status.instancesStatus`; undefined without the cluster. */
  healthy?: boolean;
}

export interface QuorumFacts {
  state: QuorumState;
  label: QuorumState;
  className: HostStatusClass;
  reason: string;
  method?: string;
  /** N: the potentially synchronous standbys. */
  named: number;
  /** W: the standbys a commit waits for. */
  mustConfirm: number;
  /** R as the extension sees it: the named standbys the cluster reports healthy. */
  healthy: number;
  writtenBy?: string;
  standbys: QuorumStandby[];
}

const PRESENTATION: Record<QuorumState, HostStatusClass> = {
  Safe: "success",
  "At risk": "error",
  Stale: "warning",
  Reset: "warning",
  Orphan: "info",
};

/** The cluster a quorum belongs to: same name, same namespace. */
export function clusterOfQuorum(quorum: FailoverQuorum, clusters: readonly Cluster[]): Cluster | undefined {
  return clusters.find(
    (cluster) =>
      cluster.metadata?.name === quorum.metadata?.name && cluster.metadata?.namespace === quorum.metadata?.namespace,
  );
}

export function quorumFacts(quorum: FailoverQuorum, cluster: Cluster | undefined): QuorumFacts {
  const status = quorum.status;
  const names = status?.standbyNames ?? [];
  const mustConfirm = status?.standbyNumber ?? 0;
  const instances = cluster ? instanceFacts(cluster) : [];
  const standbys: QuorumStandby[] = names.map((name) => {
    const instance = instances.find((candidate) => candidate.name === name);
    return { name, healthy: cluster ? instance?.health === "healthy" && !instance.fenced : undefined };
  });
  const healthy = standbys.filter((standby) => standby.healthy).length;
  const base = {
    method: status?.method?.toUpperCase(),
    named: names.length,
    mustConfirm,
    healthy,
    writtenBy: status?.primary || undefined,
    standbys,
  };
  const facts = (state: QuorumState, reason: string): QuorumFacts => ({
    state,
    label: state,
    className: PRESENTATION[state],
    reason,
    ...base,
  });

  if (!cluster) {
    return facts("Orphan", "Its cluster is not there");
  }
  if (names.length === 0) {
    return facts(
      "Reset",
      "Reset while the configuration changes: no failover happens until the primary writes it again",
    );
  }
  const currentPrimary = Cluster.getPrimary(cluster);
  if (status?.primary && currentPrimary && status.primary !== currentPrimary) {
    return facts("Stale", `Written by ${status.primary}, which is no longer the primary (${currentPrimary} is)`);
  }
  const counts = `${healthy} of ${names.length} potentially synchronous standbys are healthy and ${mustConfirm} must confirm`;
  if (healthy + mustConfirm > names.length) {
    return facts("Safe", `A failover could be decided safely: ${counts}`);
  }
  return facts("At risk", `The operator would promote nothing: ${counts}`);
}
