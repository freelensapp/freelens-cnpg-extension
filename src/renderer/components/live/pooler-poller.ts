/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The polling loop of the Pooler drawer (SPEC-0012): the PgBouncer exporter of
// every pooler pod, every fifteen seconds while the drawer is open and the
// window visible.

import { SamplesPoller } from "./samples-poller";

import type { PodProxyClient } from "../../api/instance/pod-proxy";
import type { Visibility } from "./live-poller";
import type { SamplesPollTarget } from "./samples-poller";

export const POOLER_INTERVAL_MS = 15_000;

export type PoolerPollTarget = SamplesPollTarget;

export interface PoolerPollerOptions {
  client: PodProxyClient;
  targets: () => PoolerPollTarget[];
  intervalMs?: number;
  visibility?: Visibility;
  now?: () => number;
}

export class PoolerPoller extends SamplesPoller {
  constructor(options: PoolerPollerOptions) {
    super({
      ...options,
      intervalMs: options.intervalMs ?? POOLER_INTERVAL_MS,
      read: (client, target) => client.getPoolerMetrics(target.namespace, target.pod, target.scheme),
    });
  }
}
