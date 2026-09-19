/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POOLER_INTERVAL_MS, PoolerPoller } from "./pooler-poller";

import type { PodProxyClient, ProxyResult } from "../../api/instance/pod-proxy";
import type { Visibility } from "./live-poller";

const TARGETS = [
  { namespace: "db", pod: "pooler-a", scheme: "http" as const },
  { namespace: "db", pod: "pooler-b", scheme: "http" as const },
];

function visibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const api: Visibility = {
    isHidden: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    api,
    listeners,
    set(value: boolean) {
      hidden = value;
      for (const listener of listeners) listener();
    },
  };
}

function client(answer: (pod: string) => Promise<ProxyResult<string>>) {
  const calls: string[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error("the pooler poller must only read the PgBouncer exporter");
  };
  const api: PodProxyClient = {
    getStatus: refuse,
    getMetrics: refuse,
    getPoolerMetrics: (_namespace, pod) => {
      calls.push(pod);
      return answer(pod);
    },
  };
  return { api, calls };
}

const ok = async (): Promise<ProxyResult<string>> => ({
  ok: true,
  scheme: "http",
  value: "cnpg_pgbouncer_lists_free_clients 49\n",
});

describe("PoolerPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the exporter of every pod at once and then at its interval, and nothing else", async () => {
    const { api, calls } = client(ok);
    const window = visibility();
    const poller = new PoolerPoller({ client: api, targets: () => TARGETS, visibility: window.api });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.sort()).toEqual(["pooler-a", "pooler-b"]);
    expect(poller.answered).toBe(true);
    expect(poller.samples.get("pooler-a")).toEqual([
      { name: "cnpg_pgbouncer_lists_free_clients", labels: {}, value: 49 },
    ]);

    await vi.advanceTimersByTimeAsync(POOLER_INTERVAL_MS);
    expect(calls).toHaveLength(4);
    poller.stop();
  });

  it("keeps the failure of a pod next to the answers of the others", async () => {
    const { api } = client(async (pod) =>
      pod === "pooler-b" ? { ok: false, failure: { kind: "forbidden", status: 403 } } : ok(),
    );
    const poller = new PoolerPoller({ client: api, targets: () => TARGETS, visibility: visibility().api });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect([...poller.samples.keys()]).toEqual(["pooler-a"]);
    expect(poller.failures.get("pooler-b")).toEqual({ kind: "forbidden", status: 403 });
    poller.stop();
  });

  it("stops while the window is hidden, reads at once when it is back, and forgets the pods that went away", async () => {
    const { api, calls } = client(ok);
    const window = visibility();
    let targets = TARGETS;
    const poller = new PoolerPoller({ client: api, targets: () => targets, visibility: window.api });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    window.set(true);
    await vi.advanceTimersByTimeAsync(POOLER_INTERVAL_MS * 3);
    expect(calls).toEqual([]);

    targets = [TARGETS[0]];
    window.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["pooler-a"]);
    expect([...poller.samples.keys()]).toEqual(["pooler-a"]);
    poller.stop();
  });

  it("drops the answers that arrive after the drawer closed, and unsubscribes", async () => {
    let release: (() => void) | undefined;
    const { api } = client(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, scheme: "http", value: "up 1\n" });
        }),
    );
    const window = visibility();
    const poller = new PoolerPoller({ client: api, targets: () => [TARGETS[0]], visibility: window.api });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(POOLER_INTERVAL_MS);
    expect(poller.samples.size).toBe(0);
    expect(poller.answered).toBe(false);
    expect(window.listeners.size).toBe(0);
  });
});
