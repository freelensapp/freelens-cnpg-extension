/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of what a PgBouncer pooler is doing right now (SPEC-0012), from
// the samples of the exporter of every pooler pod (`cnpg_pgbouncer_*`), summed
// over the pods. PgBouncer's own admin pool (database `pgbouncer`, how the
// exporter reads the figures) and the pool of the operator's `auth_query` user
// are the platform's: they are left out of what the user is shown.

import { selectSamples, singleValue } from "../../api/instance/prometheus-text";

import type { MetricSample } from "../../api/instance/prometheus-text";
import type { Level } from "./live-model";

/** A client waiting longer than this for a server connection is an error worth the eye. */
export const POOLER_WAIT_ERROR_MS = 5000;

const ADMIN_DATABASE = "pgbouncer";
/** The user PgBouncer runs its `auth_query` with: the operator's own, not an application's. */
const AUTH_QUERY_USER = "cnpg_pooler_pgbouncer";

/** PgBouncer's admin pool and the operator's authentication pool: the platform's own, left out of the user figures. */
function isPlatformPool(sample: MetricSample): boolean {
  return sample.labels.database === ADMIN_DATABASE || sample.labels.user === AUTH_QUERY_USER;
}

export interface PoolView {
  database: string;
  user: string;
  clientsActive: number;
  clientsWaiting: number;
  serversActive: number;
  serversIdle: number;
  serversUsed: number;
  /** The longest a client of the pool has been waiting, in milliseconds. */
  maxWaitMs: number;
}

export interface PoolerLiveView {
  clients: { active: number; waiting: number; free: number };
  servers: { active: number; idle: number; used: number; free: number };
  pools: PoolView[];
  longestWaitMs: number;
  level: Level;
  /** How many pooler pods answered. */
  pods: number;
}

function poolKey(sample: MetricSample): string {
  return `${sample.labels.database ?? ""}\u0000${sample.labels.user ?? ""}`;
}

export function buildPoolerView(
  samplesByPod: ReadonlyMap<string, readonly MetricSample[]>,
): PoolerLiveView | undefined {
  if (samplesByPod.size === 0) return undefined;

  const pools = new Map<string, PoolView>();
  let freeClients = 0;
  let freeServers = 0;

  for (const samples of samplesByPod.values()) {
    freeClients += singleValue(samples, "cnpg_pgbouncer_lists_free_clients") ?? 0;
    freeServers += singleValue(samples, "cnpg_pgbouncer_lists_free_servers") ?? 0;

    const read = (name: string, key: keyof PoolView) => {
      for (const sample of selectSamples(samples, name)) {
        if (isPlatformPool(sample) || !Number.isFinite(sample.value)) continue;
        const id = poolKey(sample);
        const pool =
          pools.get(id) ??
          ({
            database: sample.labels.database ?? "",
            user: sample.labels.user ?? "",
            clientsActive: 0,
            clientsWaiting: 0,
            serversActive: 0,
            serversIdle: 0,
            serversUsed: 0,
            maxWaitMs: 0,
          } satisfies PoolView);
        if (key === "maxWaitMs") pool.maxWaitMs = Math.max(pool.maxWaitMs, sample.value);
        else (pool[key] as number) += sample.value;
        pools.set(id, pool);
      }
    };

    read("cnpg_pgbouncer_pools_cl_active", "clientsActive");
    read("cnpg_pgbouncer_pools_cl_waiting", "clientsWaiting");
    read("cnpg_pgbouncer_pools_sv_active", "serversActive");
    read("cnpg_pgbouncer_pools_sv_idle", "serversIdle");
    read("cnpg_pgbouncer_pools_sv_used", "serversUsed");

    // The wait comes as whole seconds plus a microsecond remainder.
    const seconds = new Map(selectSamples(samples, "cnpg_pgbouncer_pools_maxwait").map((s) => [poolKey(s), s.value]));
    for (const sample of selectSamples(samples, "cnpg_pgbouncer_pools_maxwait_us")) {
      if (isPlatformPool(sample)) continue;
      const pool = pools.get(poolKey(sample));
      if (!pool) continue;
      const wait =
        (seconds.get(poolKey(sample)) ?? 0) * 1000 + (Number.isFinite(sample.value) ? sample.value / 1000 : 0);
      pool.maxWaitMs = Math.max(pool.maxWaitMs, wait);
    }
  }

  const list = [...pools.values()].sort(
    (a, b) =>
      b.clientsWaiting - a.clientsWaiting ||
      b.clientsActive - a.clientsActive ||
      a.database.localeCompare(b.database) ||
      a.user.localeCompare(b.user),
  );
  const sum = (key: keyof PoolView) => list.reduce((total, pool) => total + (pool[key] as number), 0);
  const waiting = sum("clientsWaiting");
  const longestWaitMs = list.reduce((longest, pool) => Math.max(longest, pool.maxWaitMs), 0);

  return {
    clients: { active: sum("clientsActive"), waiting, free: freeClients },
    servers: { active: sum("serversActive"), idle: sum("serversIdle"), used: sum("serversUsed"), free: freeServers },
    pools: list,
    longestWaitMs,
    level: longestWaitMs > POOLER_WAIT_ERROR_MS ? "error" : waiting > 0 ? "warning" : "ok",
    pods: samplesByPod.size,
  };
}
