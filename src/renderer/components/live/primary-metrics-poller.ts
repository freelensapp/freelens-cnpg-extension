/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The polling loop of the drawers that show a figure of a database or of a
// replication slot (SPEC-0013, SPEC-0015): the metrics exporter of the current
// primary of a cluster, at the pace the exporter refreshes its own numbers.

import { Cluster } from "../../api/cnpg/cluster-v1";
import { metricsScheme } from "../../api/instance/pod-proxy";
import { METRICS_INTERVAL_MS } from "./live-poller";
import { SamplesPoller } from "./samples-poller";

import type { PodProxyClient } from "../../api/instance/pod-proxy";
import type { Visibility } from "./live-poller";
import type { SamplesPollTarget } from "./samples-poller";

/** The pod to ask for a cluster: its current primary, when it has one. */
export function primaryTarget(cluster: Cluster | undefined): SamplesPollTarget[] {
  const pod = cluster ? Cluster.getPrimary(cluster) : undefined;
  const namespace = cluster?.metadata?.namespace;
  if (!cluster || !pod || !namespace) return [];
  return [{ namespace, pod, scheme: metricsScheme(cluster) }];
}

export interface PrimaryMetricsPollerOptions {
  client: PodProxyClient;
  /** Read at every round, so the loop follows a switchover. */
  cluster: () => Cluster | undefined;
  intervalMs?: number;
  visibility?: Visibility;
  now?: () => number;
}

export class PrimaryMetricsPoller extends SamplesPoller {
  constructor(options: PrimaryMetricsPollerOptions) {
    super({
      client: options.client,
      targets: () => primaryTarget(options.cluster()),
      intervalMs: options.intervalMs ?? METRICS_INTERVAL_MS,
      visibility: options.visibility,
      now: options.now,
      read: (client, target) => client.getMetrics(target.namespace, target.pod, target.scheme),
    });
  }
}
