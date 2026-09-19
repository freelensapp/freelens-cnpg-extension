/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_INTERVAL_MS,
  FAILURES_BEFORE_BACKOFF,
  LivePoller,
  METRICS_INTERVAL_MS,
  STATUS_INTERVAL_MS,
} from "./live-poller";

import type { PodProxyClient, ProxyResult } from "../../api/instance/pod-proxy";
import type { PostgresqlStatus } from "../../api/instance/postgresql-status";
import type { PollTarget, Visibility } from "./live-poller";

const TARGETS: PollTarget[] = [
  { namespace: "db", pod: "pg-1", statusScheme: "https", metricsScheme: "http" },
  { namespace: "db", pod: "pg-2", statusScheme: "https", metricsScheme: "http" },
];

function statusOf(pod: string): ProxyResult<PostgresqlStatus> {
  return { ok: true, scheme: "https", value: { isPrimary: pod === "pg-1", pod: { metadata: { name: pod } } } };
}

function fakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    isHidden: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    visibility,
    listeners,
    set(value: boolean) {
      hidden = value;
      for (const listener of listeners) listener();
    },
  };
}

/** A client that records every call; the overrides replace what an endpoint answers. */
function fakeClient(overrides: Partial<PodProxyClient> = {}) {
  const calls: string[] = [];
  const answers: PodProxyClient = {
    getStatus: async (_namespace, pod) => statusOf(pod),
    getMetrics: async () => ({ ok: true, scheme: "http", value: "cnpg_backends_waiting_total 2\n" }),
    getPoolerMetrics: async () => ({ ok: true, scheme: "http", value: "" }),
    ...overrides,
  };
  const client: PodProxyClient = {
    getStatus: (namespace, pod, scheme) => {
      calls.push(`status:${pod}`);
      return answers.getStatus(namespace, pod, scheme);
    },
    getMetrics: (namespace, pod, scheme) => {
      calls.push(`metrics:${pod}`);
      return answers.getMetrics(namespace, pod, scheme);
    },
    getPoolerMetrics: (namespace, pod, scheme) => answers.getPoolerMetrics(namespace, pod, scheme),
  };
  return { calls, client };
}

describe("LivePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads both endpoints of every target at once, then each at its own pace", async () => {
    const { client, calls } = fakeClient();
    const { visibility } = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => TARGETS, visibility });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.sort()).toEqual(["metrics:pg-1", "metrics:pg-2", "status:pg-1", "status:pg-2"]);
    expect(poller.running).toBe(true);
    expect(poller.readings.get("pg-1")?.status).toMatchObject({ ok: true, value: { isPrimary: true } });
    expect(poller.readings.get("pg-2")?.metrics).toMatchObject({
      ok: true,
      value: [{ name: "cnpg_backends_waiting_total", labels: {}, value: 2 }],
    });
    expect(poller.lastSuccess).toBeDefined();

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(calls.sort()).toEqual(["status:pg-1", "status:pg-2"]);

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(METRICS_INTERVAL_MS - STATUS_INTERVAL_MS);
    expect(calls.filter((call) => call.startsWith("metrics:")).sort()).toEqual(["metrics:pg-1", "metrics:pg-2"]);
    poller.stop();
  });

  it("never has two requests out for the same pod and endpoint", async () => {
    let release: (() => void) | undefined;
    const { client, calls } = fakeClient({
      getStatus: (_namespace, pod) =>
        pod === "pg-1"
          ? new Promise((resolve) => {
              release = () => resolve(statusOf(pod));
            })
          : Promise.resolve(statusOf(pod)),
    });
    const { visibility } = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => TARGETS, visibility });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // The round waits for the slow pod, so no second round starts on top of it.
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * 3);
    expect(calls.filter((call) => call === "status:pg-1")).toHaveLength(1);

    // A manual refresh while the slow request is still out does not double it either.
    void poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call === "status:pg-1")).toHaveLength(1);

    release?.();
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(calls.filter((call) => call === "status:pg-1").length).toBeGreaterThan(1);
    poller.stop();
  });

  it("asks a pod that keeps failing at the slow pace, and at once on a manual refresh", async () => {
    const { client, calls } = fakeClient({
      getStatus: async (_namespace, pod) =>
        pod === "pg-2" ? { ok: false, failure: { kind: "unreachable", status: 503 } } : statusOf(pod),
    });
    const { visibility } = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => TARGETS, visibility });
    const failing = () => calls.filter((call) => call === "status:pg-2").length;

    poller.start();
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * (FAILURES_BEFORE_BACKOFF - 1));
    expect(failing()).toBe(FAILURES_BEFORE_BACKOFF);
    expect(poller.readings.get("pg-2")?.status).toEqual({ ok: false, failure: { kind: "unreachable", status: 503 } });

    await vi.advanceTimersByTimeAsync(BACKOFF_INTERVAL_MS - STATUS_INTERVAL_MS);
    expect(failing()).toBe(FAILURES_BEFORE_BACKOFF);
    // The healthy pod kept its pace meanwhile.
    expect(calls.filter((call) => call === "status:pg-1").length).toBeGreaterThan(FAILURES_BEFORE_BACKOFF + 2);

    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);
    expect(failing()).toBe(FAILURES_BEFORE_BACKOFF + 1);

    await poller.refresh();
    expect(failing()).toBe(FAILURES_BEFORE_BACKOFF + 2);
    poller.stop();
  });

  it("stops while the window is hidden and reads at once when it comes back", async () => {
    const { client, calls } = fakeClient();
    const window = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => TARGETS, visibility: window.visibility });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    window.set(true);
    expect(poller.running).toBe(false);
    await vi.advanceTimersByTimeAsync(METRICS_INTERVAL_MS * 2);
    expect(calls).toEqual([]);

    window.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.running).toBe(true);
    expect(calls.sort()).toEqual(["metrics:pg-1", "metrics:pg-2", "status:pg-1", "status:pg-2"]);
    poller.stop();
  });

  it("pauses and resumes on request", async () => {
    const { client, calls } = fakeClient();
    const { visibility } = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => TARGETS, visibility });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    poller.setPaused(true);
    await vi.advanceTimersByTimeAsync(METRICS_INTERVAL_MS);
    expect(calls).toEqual([]);
    expect(poller.running).toBe(false);

    poller.setPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.startsWith("status:"))).toHaveLength(2);
    poller.stop();
  });

  it("drops the answers that arrive after the page went away, and unsubscribes", async () => {
    let release: (() => void) | undefined;
    const { client } = fakeClient({
      getStatus: (_namespace, pod) =>
        new Promise((resolve) => {
          release = () => resolve(statusOf(pod));
        }),
    });
    const window = fakeVisibility();
    const poller = new LivePoller({ client, targets: () => [TARGETS[0]], visibility: window.visibility });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS * 2);
    expect(poller.readings.get("pg-1")?.status).toBeUndefined();
    expect(window.listeners.size).toBe(0);
    expect(poller.running).toBe(false);
  });

  it("follows the targets and remembers the sampled figures", async () => {
    const { client } = fakeClient();
    const { visibility } = fakeVisibility();
    let targets = TARGETS;
    let clock = 1000;
    const poller = new LivePoller({
      client,
      targets: () => targets,
      visibility,
      now: () => clock,
      sample: (readings) => ({ instances: readings.size, nothing: undefined }),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    clock = 6000;
    targets = [TARGETS[0]];
    await vi.advanceTimersByTimeAsync(STATUS_INTERVAL_MS);

    expect([...poller.readings.keys()]).toEqual(["pg-1"]);
    const series = poller.series.get("instances") ?? [];
    expect(series.at(-1)).toEqual({ time: 6000, value: 1 });
    expect(series[0].value).toBe(2);
    expect(poller.series.has("nothing")).toBe(false);
    poller.stop();
  });
});
