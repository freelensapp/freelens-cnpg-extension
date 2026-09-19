/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the leases (SPEC-0019, shared with SPEC-0016): the facts of a
// Kubernetes Lease, and what the primary lease of a cluster says about who may
// be primary. The lease named after the cluster must be held by an instance
// before it promotes; the primary renews it every few seconds and releases it
// on a clean shutdown.

import { Cluster } from "../api/cnpg/cluster-v1";
import { humanizeDuration } from "./backup-health";
import { parseGoTime } from "./go-time";

import type { LeaseLike } from "../api/core/lease";
import type { HostStatusClass } from "./cluster-health";

export interface LeaseFacts {
  /** Empty when the lease was released. */
  holder: string;
  acquiredAt?: Date;
  renewedAt?: Date;
  durationSeconds?: number;
  transitions: number;
  /** Renewed within twice its duration: whoever holds it is alive. */
  current: boolean;
}

export function leaseFacts(lease: LeaseLike, now: Date = new Date()): LeaseFacts {
  const spec = lease.spec;
  const renewedAt = parseGoTime(spec?.renewTime);
  const durationSeconds = spec?.leaseDurationSeconds;
  const age = renewedAt ? now.getTime() - renewedAt.getTime() : undefined;
  return {
    holder: spec?.holderIdentity?.trim() ?? "",
    acquiredAt: parseGoTime(spec?.acquireTime),
    renewedAt,
    durationSeconds,
    transitions: spec?.leaseTransitions ?? 0,
    current: age !== undefined && durationSeconds !== undefined && age <= durationSeconds * 2 * 1000,
  };
}

/** The pod behind a leader election identity: controller-runtime writes `<pod>_<uuid>`. */
export function holderPod(holder: string): string {
  return holder.split("_")[0];
}

/** The lease of a cluster: same name, same namespace. */
export function leaseOfCluster(cluster: Cluster, leases: readonly LeaseLike[]): LeaseLike | undefined {
  return leases.find(
    (lease) =>
      lease.metadata?.name === cluster.metadata?.name && lease.metadata?.namespace === cluster.metadata?.namespace,
  );
}

export type PrimaryLeaseState = "Held" | "Released" | "Stale" | "Mismatch" | "Missing";

export interface PrimaryLeaseHealth {
  state: PrimaryLeaseState;
  label: PrimaryLeaseState;
  className: HostStatusClass;
  reason: string;
  facts?: LeaseFacts;
}

const PRESENTATION: Record<PrimaryLeaseState, HostStatusClass> = {
  Held: "success",
  Released: "info",
  Stale: "warning",
  Mismatch: "warning",
  Missing: "info",
};

function health(state: PrimaryLeaseState, reason: string, facts?: LeaseFacts): PrimaryLeaseHealth {
  return { state, label: state, className: PRESENTATION[state], reason, facts };
}

export function primaryLeaseHealth(
  lease: LeaseLike | undefined,
  cluster: Cluster,
  now: Date = new Date(),
): PrimaryLeaseHealth {
  if (!lease) return health("Missing", "The cluster has no primary lease object, or it cannot be read");
  const facts = leaseFacts(lease, now);
  const primary = Cluster.getPrimary(cluster);

  if (!facts.holder) {
    return health(
      "Released",
      Cluster.getHibernation(cluster)
        ? "Released: the cluster is hibernated, nobody is primary"
        : "Released: the last primary shut down cleanly, any eligible instance may take it",
      facts,
    );
  }
  if (!facts.current) {
    const silent = facts.renewedAt ? humanizeDuration(now.getTime() - facts.renewedAt.getTime()) : "an unknown time";
    return health(
      "Stale",
      `${facts.holder} stopped renewing it ${silent} ago: once it expires another instance may promote`,
      facts,
    );
  }
  if (primary && facts.holder !== primary) {
    return health(
      "Mismatch",
      `Held by ${facts.holder} while the cluster reports ${primary} as primary: a switchover or a failover is in progress`,
      facts,
    );
  }
  return health("Held", `Held and renewed by the primary, ${facts.holder}`, facts);
}

export const PRIMARY_LEASE_DEFAULTS = {
  leaseDurationSeconds: 15,
  renewDeadlineSeconds: 10,
  retryPeriodSeconds: 2,
  releasedLeaseDurationSeconds: 1,
} as const;

export type PrimaryLeaseTimings = { -readonly [Key in keyof typeof PRIMARY_LEASE_DEFAULTS]: number };

/** The timings in effect: `.spec.primaryLease` over the operator's defaults. */
export function primaryLeaseTimings(cluster: Cluster): PrimaryLeaseTimings {
  const declared = (cluster.spec?.primaryLease ?? {}) as Partial<PrimaryLeaseTimings>;
  return {
    leaseDurationSeconds: declared.leaseDurationSeconds ?? PRIMARY_LEASE_DEFAULTS.leaseDurationSeconds,
    renewDeadlineSeconds: declared.renewDeadlineSeconds ?? PRIMARY_LEASE_DEFAULTS.renewDeadlineSeconds,
    retryPeriodSeconds: declared.retryPeriodSeconds ?? PRIMARY_LEASE_DEFAULTS.retryPeriodSeconds,
    releasedLeaseDurationSeconds:
      declared.releasedLeaseDurationSeconds ?? PRIMARY_LEASE_DEFAULTS.releasedLeaseDurationSeconds,
  };
}

/** What the timings mean for a failover, in one sentence. */
export function leaseTimingWords(cluster: Cluster): string {
  const timings = primaryLeaseTimings(cluster);
  const custom = cluster.spec?.primaryLease ? "" : " (the defaults)";
  return (
    `A primary that dies without releasing it holds a promotion back for up to ${timings.leaseDurationSeconds} s; ` +
    `it gives up after ${timings.renewDeadlineSeconds} s of failed renewals; ` +
    `the others retry every ${timings.retryPeriodSeconds} s${custom}`
  );
}
