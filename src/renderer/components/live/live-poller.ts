/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The polling loops of the live view (SPEC-0006 "Poller"): the status of every
// instance every few seconds, the metrics at the pace the exporter refreshes
// them. One request per pod and endpoint at a time, a slower pace for a pod
// that keeps failing, and nothing at all while nobody is looking: the loops
// stop when the window is hidden or the page goes away.

import { action, makeObservable, observable, runInAction } from "mobx";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import { appendPoint } from "./series";

import type { PodProxyClient, ProxyScheme } from "../../api/instance/pod-proxy";
import type { InstanceReading } from "./live-model";
import type { SeriesPoint } from "./series";

export const STATUS_INTERVAL_MS = 5000;
/** The exporter caches its queries for 30 seconds by default: asking more often returns the same numbers. */
export const METRICS_INTERVAL_MS = 30_000;
/** After this many failures in a row a pod is asked at the slow pace. */
export const FAILURES_BEFORE_BACKOFF = 3;
export const BACKOFF_INTERVAL_MS = 30_000;

export interface PollTarget {
  namespace: string;
  pod: string;
  statusScheme: ProxyScheme;
  metricsScheme: ProxyScheme;
}

/** Whether somebody is looking, and a way to hear about changes. */
export interface Visibility {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export const documentVisibility: Visibility = {
  isHidden: () => typeof document !== "undefined" && document.hidden,
  subscribe: (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export interface LivePollerOptions {
  client: PodProxyClient;
  /** Read at every round, so the loops follow the pods as they come and go. */
  targets: () => PollTarget[];
  /** Figures to remember for the sparklines, derived from the readings after every round. */
  sample?: (readings: ReadonlyMap<string, InstanceReading>) => Record<string, number | undefined>;
  statusIntervalMs?: number;
  metricsIntervalMs?: number;
  visibility?: Visibility;
  now?: () => number;
}

type Endpoint = "status" | "metrics";

export class LivePoller {
  readonly readings = observable.map<string, InstanceReading>({}, { deep: false });
  readonly series = observable.map<string, SeriesPoint[]>({}, { deep: false });
  lastSuccess: number | undefined = undefined;
  paused = false;
  running = false;

  readonly statusIntervalMs: number;
  readonly metricsIntervalMs: number;

  private readonly client: PodProxyClient;
  private readonly targets: () => PollTarget[];
  private readonly sample?: LivePollerOptions["sample"];
  private readonly visibility: Visibility;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly nextAllowed = new Map<string, number>();
  private timers: Partial<Record<Endpoint, ReturnType<typeof setTimeout>>> = {};
  private unsubscribe: (() => void) | undefined;

  constructor(options: LivePollerOptions) {
    this.client = options.client;
    this.targets = options.targets;
    this.sample = options.sample;
    this.statusIntervalMs = options.statusIntervalMs ?? STATUS_INTERVAL_MS;
    this.metricsIntervalMs = options.metricsIntervalMs ?? METRICS_INTERVAL_MS;
    this.visibility = options.visibility ?? documentVisibility;
    this.now = options.now ?? Date.now;
    makeObservable(this, {
      lastSuccess: observable,
      paused: observable,
      running: observable,
      setPaused: action,
    });
  }

  /** Starts the loops; safe to call twice. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.visibility.subscribe(() => this.reschedule(true));
    this.reschedule(true);
  }

  /** Stops everything; answers still in flight are dropped when they arrive. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearTimers();
    runInAction(() => {
      this.running = false;
    });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.reschedule(!paused);
  }

  /** A manual refresh: both endpoints now, whatever the backoff says. */
  async refresh(): Promise<void> {
    this.nextAllowed.clear();
    await Promise.all([this.round("status"), this.round("metrics")]);
  }

  private get active(): boolean {
    return Boolean(this.unsubscribe) && !this.paused && !this.visibility.isHidden();
  }

  private clearTimers(): void {
    for (const timer of Object.values(this.timers)) clearTimeout(timer);
    this.timers = {};
  }

  private reschedule(immediate: boolean): void {
    this.clearTimers();
    const active = this.active;
    runInAction(() => {
      this.running = active;
    });
    if (!active) return;
    this.loop("status", this.statusIntervalMs, immediate);
    this.loop("metrics", this.metricsIntervalMs, immediate);
  }

  private loop(endpoint: Endpoint, intervalMs: number, immediate: boolean): void {
    const tick = async () => {
      await this.round(endpoint);
      if (this.active) this.timers[endpoint] = setTimeout(tick, intervalMs);
    };
    this.timers[endpoint] = setTimeout(tick, immediate ? 0 : intervalMs);
  }

  private async round(endpoint: Endpoint): Promise<void> {
    const targets = this.targets();
    const names = new Set(targets.map((target) => target.pod));
    runInAction(() => {
      for (const name of [...this.readings.keys()]) if (!names.has(name)) this.readings.delete(name);
    });
    await Promise.all(targets.map((target) => this.read(endpoint, target)));
    if (!this.unsubscribe) return;
    const figures = this.sample?.(this.readings);
    if (figures) {
      const time = this.now();
      runInAction(() => {
        for (const [key, value] of Object.entries(figures)) {
          if (value === undefined) continue;
          this.series.set(key, appendPoint(this.series.get(key) ?? [], { time, value }));
        }
      });
    }
  }

  private async read(endpoint: Endpoint, target: PollTarget): Promise<void> {
    const key = `${target.namespace}/${target.pod}:${endpoint}`;
    if (this.inFlight.has(key)) return;
    if ((this.nextAllowed.get(key) ?? 0) > this.now()) return;

    this.inFlight.add(key);
    try {
      const result =
        endpoint === "status"
          ? await this.client.getStatus(target.namespace, target.pod, target.statusScheme)
          : await this.client.getMetrics(target.namespace, target.pod, target.metricsScheme);
      // The page went away while the request was out: nobody wants the answer.
      if (!this.unsubscribe) return;

      if (result.ok) {
        this.failures.delete(key);
        this.nextAllowed.delete(key);
      } else {
        const count = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, count);
        if (count >= FAILURES_BEFORE_BACKOFF) this.nextAllowed.set(key, this.now() + BACKOFF_INTERVAL_MS);
      }

      runInAction(() => {
        const previous = this.readings.get(target.pod) ?? {};
        if (endpoint === "status") {
          const status = result as Awaited<ReturnType<PodProxyClient["getStatus"]>>;
          this.readings.set(target.pod, {
            ...previous,
            status: status.ok ? { ok: true, value: status.value } : { ok: false, failure: status.failure },
          });
        } else {
          const metrics = result as Awaited<ReturnType<PodProxyClient["getMetrics"]>>;
          this.readings.set(target.pod, {
            ...previous,
            metrics: metrics.ok
              ? { ok: true, value: parsePrometheusText(metrics.value) }
              : { ok: false, failure: metrics.failure },
          });
        }
        if (result.ok) this.lastSuccess = this.now();
      });
    } finally {
      this.inFlight.delete(key);
    }
  }
}
