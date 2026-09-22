/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  defaultPoolerForm,
  defaultPoolerName,
  PGBOUNCER_PARAMETERS,
  poolerBlockReason,
  poolerBody,
  poolerErrors,
  poolerFacts,
  poolerSummaryWarnings,
  poolerTypeReason,
  poolerWarnings,
} from "./pooler-create";

import type { PoolerForm, PoolerInputs } from "./pooler-create";

const READY: PoolerInputs = {
  clusters: [
    { name: "pg", instances: 3, hibernated: false },
    { name: "solo", instances: 1, hibernated: false },
    { name: "sleepy", instances: 2, hibernated: true },
  ],
  poolers: ["pg-pooler-ro"],
  services: ["pg-rw", "pg-ro", "pg-r", "pg-any", "taken"],
  secrets: ["auth"],
  reads: { clusters: "ready", poolers: "ready", services: "ready", secrets: "ready" },
};

function filled(overrides: Partial<PoolerForm> = {}): PoolerForm {
  return { ...defaultPoolerForm("db", "pg"), ...overrides };
}

describe("the defaults", () => {
  it("name the pooler after the cluster and the type", () => {
    expect(defaultPoolerName("pg", "rw")).toBe("pg-pooler-rw");
    expect(defaultPoolerName("", "rw")).toBe("");
    expect(defaultPoolerForm("db").name).toBe("");
    expect(poolerBlockReason(READY, defaultPoolerForm("db"))).toBe("Pick a cluster");
    expect(poolerBlockReason(READY, filled())).toBeUndefined();
    expect(PGBOUNCER_PARAMETERS).toHaveLength(57);
  });
});

describe("the errors", () => {
  it("refuse the names of the cluster's services, a taken Service and a bad label", () => {
    expect(poolerErrors(READY, filled({ name: "pg" })).name).toMatch(/name of the cluster or of one of its services/);
    expect(poolerErrors(READY, filled({ name: "pg-rw" })).name).toMatch(/one of its services/);
    expect(poolerErrors(READY, filled({ name: "pg-any" })).name).toMatch(/one of its services/);
    expect(poolerErrors(READY, filled({ name: "taken" })).name).toMatch(/A Service named taken already exists/);
    expect(poolerErrors(READY, filled({ name: "1pooler" })).name).toMatch(/starts with a letter/);
    expect(
      poolerErrors({ ...READY, reads: { ...READY.reads, services: "unavailable" } }, filled({ name: "taken" })).name,
    ).toBeUndefined();
  });

  it("check the instances, the parameters and the auth pair", () => {
    expect(poolerErrors(READY, filled({ instances: "0" })).instances).toBe("Instances is 1 or more");
    const parameters = poolerErrors(
      READY,
      filled({
        parameters: [
          { key: "pool_mode", value: "transaction" },
          { key: "max_client_conn", value: "" },
          { key: "default_pool_size", value: "20" },
          { key: "default_pool_size", value: "30" },
        ],
      }),
    );
    expect(parameters["parameters.0.key"]).toMatch(/pool_mode is not a setting the operator lets a pooler set/);
    expect(parameters["parameters.1.value"]).toBe("A parameter needs a value");
    expect(parameters["parameters.2.key"]).toBe("default_pool_size is set twice");
    expect(parameters.parameters).toBe("A parameter is wrong");
    expect(poolerErrors(READY, filled({ authQuerySecret: "auth" })).authQuery).toMatch(/needs the auth query/);
    expect(poolerErrors(READY, filled({ authQuery: "SELECT 1" })).authQuerySecret).toMatch(/needs the secret/);
    expect(poolerErrors(READY, filled({ authQuery: "SELECT 1", authQuerySecret: "auth" }))).toEqual({});
  });

  it("warn on collisions, unseen references and one instance clusters", () => {
    expect(poolerWarnings(READY, filled({ name: "pg-pooler-ro" })).name).toMatch(/already exists/);
    expect(poolerWarnings(READY, filled({ cluster: "ghost" })).cluster).toMatch(/stays inactive/);
    expect(poolerWarnings(READY, filled({ authQuerySecret: "nope", authQuery: "SELECT 1" })).authQuerySecret).toMatch(
      /No secret named nope/,
    );
    expect(poolerTypeReason(READY, filled({ cluster: "solo" }), "ro")).toMatch(/one instance/);
    expect(poolerTypeReason(READY, filled({ cluster: "solo" }), "rw")).toBeUndefined();
    expect(poolerTypeReason(READY, filled(), "ro")).toBeUndefined();
  });
});

describe("the body and the facts", () => {
  it("always sends the pgbouncer section, and the rest when set", () => {
    expect(poolerBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Pooler",
      metadata: { name: "pg-pooler-rw", namespace: "db" },
      spec: { cluster: { name: "pg" }, type: "rw", instances: 1, pgbouncer: { poolMode: "session" } },
    });
    const body = poolerBody(
      filled({
        type: "ro",
        name: "pg-pooler-ro",
        instances: "2",
        poolMode: "transaction",
        parameters: [{ key: "max_client_conn", value: "500" }],
        paused: true,
        authQuerySecret: "auth",
        authQuery: "SELECT usename, passwd FROM pg_shadow WHERE usename=$1",
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      cluster: { name: "pg" },
      type: "ro",
      instances: 2,
      pgbouncer: {
        poolMode: "transaction",
        parameters: { max_client_conn: "500" },
        paused: true,
        authQuerySecret: { name: "auth" },
        authQuery: "SELECT usename, passwd FROM pg_shadow WHERE usename=$1",
      },
    });
  });

  it("say what the operator creates and what transaction mode costs", () => {
    const facts = poolerFacts(READY, filled());
    expect(facts.subject).toBe("Pooler db/pg-pooler-rw");
    expect(facts.writes[0].text).toBe("create Pooler db/pg-pooler-rw: cluster pg, type rw, 1 instance, session mode");
    expect(facts.notes[0]).toBe(
      "The operator creates a Deployment and a Service named pg-pooler-rw: 1 PgBouncer pod in session mode in front of pg-rw. Writes and reads go to the primary.",
    );
    expect(facts.notes[1]).toMatch(/operator's own query and user/);
    expect(facts.warnings).toEqual([]);
    const costly = poolerSummaryWarnings(
      READY,
      filled({ cluster: "solo", type: "r", poolMode: "transaction", parameters: [{ key: "verbose", value: "1" }] }),
    );
    expect(costly[0]).toMatch(/prepared statements/);
    expect(costly[1]).toMatch(/Type r on a cluster with one instance/);
    expect(costly[2]).toMatch(/crash loops/);
    expect(poolerFacts(READY, filled({ cluster: "sleepy", paused: true })).notes).toContain(
      "The cluster is hibernated: the pooler will have nothing to connect to until it is resumed.",
    );
  });
});
