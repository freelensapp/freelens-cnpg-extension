/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import { buildPoolerView, POOLER_WAIT_ERROR_MS } from "./pooler-model";

// Trimmed from the answer of a pooler pod of the E2E cluster (operator 1.30.0), plus a user pool.
const POD_A = `
cnpg_pgbouncer_lists_free_clients 49
cnpg_pgbouncer_lists_free_servers 3
cnpg_pgbouncer_pools_cl_active{database="pgbouncer",user="pgbouncer"} 1
cnpg_pgbouncer_pools_cl_waiting{database="pgbouncer",user="pgbouncer"} 0
cnpg_pgbouncer_pools_cl_active{database="app",user="app"} 5
cnpg_pgbouncer_pools_cl_waiting{database="app",user="app"} 3
cnpg_pgbouncer_pools_sv_active{database="app",user="app"} 5
cnpg_pgbouncer_pools_sv_idle{database="app",user="app"} 0
cnpg_pgbouncer_pools_sv_used{database="app",user="app"} 1
cnpg_pgbouncer_pools_maxwait{database="app",user="app"} 1
cnpg_pgbouncer_pools_maxwait_us{database="app",user="app"} 250000
`;

const POD_B = `
cnpg_pgbouncer_lists_free_clients 50
cnpg_pgbouncer_lists_free_servers 1
cnpg_pgbouncer_pools_cl_active{database="app",user="app"} 2
cnpg_pgbouncer_pools_cl_waiting{database="app",user="app"} 0
cnpg_pgbouncer_pools_sv_active{database="app",user="app"} 2
cnpg_pgbouncer_pools_sv_idle{database="app",user="app"} 3
cnpg_pgbouncer_pools_cl_active{database="reports",user="reader"} 1
cnpg_pgbouncer_pools_sv_active{database="reports",user="reader"} 1
cnpg_pgbouncer_pools_maxwait{database="reports",user="reader"} 0
cnpg_pgbouncer_pools_maxwait_us{database="reports",user="reader"} 0
`;

const pods = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([pod, text]) => [pod, parsePrometheusText(text)] as const));

describe("buildPoolerView", () => {
  it("has nothing to say before a pod answers", () => {
    expect(buildPoolerView(new Map())).toBeUndefined();
  });

  it("sums the pools over the pods and leaves the admin pool out", () => {
    const view = buildPoolerView(pods({ a: POD_A, b: POD_B }));
    expect(view).toMatchObject({
      pods: 2,
      clients: { active: 8, waiting: 3, free: 99 },
      servers: { active: 8, idle: 3, used: 1, free: 4 },
      longestWaitMs: 1250,
      level: "warning",
    });
    expect(view?.pools).toEqual([
      {
        database: "app",
        user: "app",
        clientsActive: 7,
        clientsWaiting: 3,
        serversActive: 7,
        serversIdle: 3,
        serversUsed: 1,
        maxWaitMs: 1250,
      },
      {
        database: "reports",
        user: "reader",
        clientsActive: 1,
        clientsWaiting: 0,
        serversActive: 1,
        serversIdle: 0,
        serversUsed: 0,
        maxWaitMs: 0,
      },
    ]);
  });

  it("is ok when nobody waits, and an error past the wait threshold", () => {
    expect(buildPoolerView(pods({ b: POD_B }))?.level).toBe("ok");
    const stuck = POD_A.replace(
      'pools_maxwait{database="app",user="app"} 1',
      `pools_maxwait{database="app",user="app"} ${POOLER_WAIT_ERROR_MS / 1000 + 1}`,
    );
    expect(buildPoolerView(pods({ a: stuck }))?.level).toBe("error");
  });

  it("shows an idle pooler as such: only the admin pool answers", () => {
    const idle = `
cnpg_pgbouncer_lists_free_clients 49
cnpg_pgbouncer_pools_cl_active{database="pgbouncer",user="pgbouncer"} 1
`;
    expect(buildPoolerView(pods({ a: idle }))).toMatchObject({
      clients: { active: 0, waiting: 0, free: 49 },
      pools: [],
      level: "ok",
    });
  });
});
