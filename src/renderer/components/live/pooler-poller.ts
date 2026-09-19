/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The polling loop of the Pooler drawer (SPEC-0012): the PgBouncer exporter of
// every pooler pod, every fifteen seconds while the drawer is open and the
// window visible. One round at a time; nothing when nobody is looking.

import { makeObservable, observable, runInAction } from "mobx";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import { documentVisibility } from "./live-poller";

import type { PodProxyClient, ProxyFailure, ProxyScheme } from "../../api/instance/pod-proxy";
import type { MetricSample } from "../../api/instance/prometheus-text";
import type { Visibility } from "./live-poller";

export const POOLER_INTERVAL_MS = 15_000;

export interface PoolerPollTarget {
  namespace: string;
  pod: string;
  scheme: ProxyScheme;
}

export interface PoolerPollerOptions {
  client: PodProxyClient;
  targets: () => PoolerPollTarget[];
  intervalMs?: number;
  visibility?: Visibility;
  now?: () => number;
}

export class PoolerPoller {
  readonly samples = observable.map<string, MetricSample[]>({}, { deep: false });
  readonly failures = observable.map<string, ProxyFailure>({}, { deep: false });
  lastSuccess: number | undefined = undefined;
  /** True once a round has come back, whatever it brought. */
  answered = false;

  readonly intervalMs: number;

  private readonly client: PodProxyClient;
  private readonly targets: () => PoolerPollTarget[];
  private readonly visibility: Visibility;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private busy = false;

  constructor(options: PoolerPollerOptions) {
    this.client = options.client;
    this.targets = options.targets;
    this.intervalMs = options.intervalMs ?? POOLER_INTERVAL_MS;
    this.visibility = options.visibility ?? documentVisibility;
    this.now = options.now ?? Date.now;
    makeObservable(this, { lastSuccess: observable, answered: observable });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.visibility.subscribe(() => this.reschedule());
    this.reschedule();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
  }

  private reschedule(): void {
    clearTimeout(this.timer);
    if (!this.unsubscribe || this.visibility.isHidden()) return;
    const tick = async () => {
      await this.round();
      if (this.unsubscribe && !this.visibility.isHidden()) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  private async round(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const targets = this.targets();
      const results = await Promise.all(
        targets.map(async (target) => ({
          target,
          result: await this.client.getPoolerMetrics(target.namespace, target.pod, target.scheme),
        })),
      );
      // The drawer closed while the requests were out: nobody wants the answers.
      if (!this.unsubscribe) return;

      runInAction(() => {
        const pods = new Set(targets.map((target) => target.pod));
        for (const pod of [...this.samples.keys()]) if (!pods.has(pod)) this.samples.delete(pod);
        for (const pod of [...this.failures.keys()]) if (!pods.has(pod)) this.failures.delete(pod);
        for (const { target, result } of results) {
          if (result.ok) {
            this.samples.set(target.pod, parsePrometheusText(result.value));
            this.failures.delete(target.pod);
            this.lastSuccess = this.now();
          } else {
            this.samples.delete(target.pod);
            this.failures.set(target.pod, result.failure);
          }
        }
        this.answered = true;
      });
    } finally {
      this.busy = false;
    }
  }
}
