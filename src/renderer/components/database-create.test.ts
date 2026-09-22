/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  databaseBlockReason,
  databaseBody,
  databaseErrors,
  databaseFacts,
  databaseWarnings,
  defaultDatabaseForm,
} from "./database-create";
import {
  clusterStateReason,
  databaseNameError,
  parameterRowErrors,
  roleNameError,
  withClause,
} from "./declarative-create";

import type { DatabaseForm, DatabaseInputs } from "./database-create";

const READY: DatabaseInputs = {
  clusters: [
    {
      name: "pg",
      hibernated: false,
      primaryRunning: true,
      replica: false,
      owners: ["app", "postgres", "reporting"],
      tablespaces: ["fast"],
    },
    { name: "sleepy", hibernated: true, primaryRunning: false, replica: false, owners: ["app"], tablespaces: [] },
    { name: "mirror", hibernated: false, primaryRunning: true, replica: true, owners: [], tablespaces: [] },
  ],
  databases: [{ objectName: "pg-inventory", cluster: "pg", name: "inventory" }],
  reads: { clusters: "ready", databases: "ready" },
};

function filled(overrides: Partial<DatabaseForm> = {}): DatabaseForm {
  return { ...defaultDatabaseForm("db", "pg"), name: "pg-orders", dbName: "orders", owner: "app", ...overrides };
}

describe("the shared rules", () => {
  it("know the reserved names and the state of a cluster", () => {
    expect(databaseNameError("orders")).toBeUndefined();
    expect(databaseNameError("postgres")).toBe("The name postgres is reserved");
    expect(databaseNameError("template0")).toMatch(/reserved/);
    expect(databaseNameError("Orders")).toMatch(/lowercase/);
    expect(roleNameError("reporting")).toBeUndefined();
    expect(roleNameError("postgres")).toBe("The role name postgres is reserved");
    expect(roleNameError("streaming_replica")).toMatch(/reserved/);
    expect(roleNameError("pg_thing")).toMatch(/reserved by PostgreSQL/);
    expect(roleNameError("cnpg_thing")).toMatch(/reserved by the operator/);
    expect(clusterStateReason(READY.clusters[0])).toBeUndefined();
    expect(clusterStateReason(READY.clusters[1])).toMatch(/hibernated/);
    expect(clusterStateReason(READY.clusters[2])).toMatch(/replica cluster/);
    expect(
      parameterRowErrors([
        { key: "publish", value: "insert" },
        { key: "publish", value: "x" },
        { key: "", value: "" },
      ]),
    ).toEqual({
      "0.key": "publish is set twice",
      "1.key": "publish is set twice",
      "2.key": "A parameter needs a name",
    });
    expect(parameterRowErrors([{ key: "nope", value: "1" }], ["publish"])["0.key"]).toMatch(
      /not a parameter PostgreSQL knows/,
    );
    expect(
      withClause([
        { key: "publish", value: "insert" },
        { key: "copy_data", value: "false" },
      ]),
    ).toBe(" WITH (publish = insert, copy_data = false)");
    expect(withClause([])).toBe("");
  });
});

describe("the errors and warnings", () => {
  it("want a cluster, a name, a database and an owner that PostgreSQL accepts", () => {
    expect(databaseBlockReason(READY, defaultDatabaseForm("db"))).toBe("Pick a cluster");
    expect(databaseBlockReason(READY, filled({ name: "" }))).toBe("A name is required");
    expect(databaseBlockReason(READY, filled({ dbName: "template1" }))).toBe("The name template1 is reserved");
    expect(databaseBlockReason(READY, filled({ owner: "" }))).toBe("An owner is required");
    expect(databaseBlockReason(READY, filled())).toBeUndefined();
  });

  it("check the objects inside and the creation options", () => {
    const errors = databaseErrors(
      READY,
      filled({
        extensions: [
          { name: "uuid-ossp", version: "", schema: "" },
          { name: "uuid-ossp", version: "", schema: "" },
          { name: "", version: "", schema: "" },
          { name: "postgis", version: "3.4", schema: "1bad" },
        ],
        schemas: [
          { name: "sales", owner: "app" },
          { name: "sales", owner: "" },
          { name: "Bad", owner: "" },
        ],
        template: "1t",
        localeProvider: "icu",
        tablespace: "no space",
        connectionLimit: "-5",
      }),
    );
    expect(errors["extensions.1.name"]).toBe("uuid-ossp is listed twice");
    expect(errors["extensions.2.name"]).toBe("An extension needs a name");
    expect(errors["extensions.3.schema"]).toMatch(/digit/);
    expect(errors.extensions).toBe("An extension is wrong");
    expect(errors["schemas.1.name"]).toBe("sales is listed twice");
    expect(errors["schemas.2.name"]).toMatch(/lowercase/);
    expect(errors.template).toMatch(/digit/);
    expect(errors.locale).toMatch(/icu provider/);
    expect(errors.tablespace).toMatch(/lowercase/);
    expect(errors.connectionLimit).toBe("The connection limit is a whole number, -1 for no limit");
    expect(databaseErrors(READY, filled({ connectionLimit: "-1" })).connectionLimit).toBeUndefined();
  });

  it("warn on collisions, unknown owners and a second object for the same database", () => {
    expect(databaseWarnings(READY, filled({ name: "pg-inventory" })).name).toMatch(/already exists/);
    expect(databaseWarnings(READY, filled({ owner: "ghost" })).owner).toMatch(/No role named ghost is known for pg/);
    expect(databaseWarnings(READY, filled({ dbName: "inventory" })).dbName).toMatch(
      /pg-inventory already declares the database inventory/,
    );
    expect(databaseWarnings(READY, filled({ tablespace: "slow" })).tablespace).toMatch(/no tablespace named slow/);
    expect(databaseWarnings(READY, filled({ cluster: "ghost" })).cluster).toMatch(/No cluster named ghost/);
    expect(databaseWarnings(READY, filled())).toEqual({});
  });
});

describe("the body and the facts", () => {
  it("sends the minimal object, and the rest when set", () => {
    expect(databaseBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Database",
      metadata: { name: "pg-orders", namespace: "db" },
      spec: { cluster: { name: "pg" }, name: "orders", owner: "app" },
    });
    const body = databaseBody(
      filled({
        reclaim: "delete",
        extensions: [{ name: "postgis", version: "3.4", schema: "gis" }],
        schemas: [{ name: "sales", owner: "app" }],
        template: "template0",
        encoding: "UTF8",
        localeProvider: "icu",
        locale: "en-US",
        tablespace: "fast",
        connectionLimit: "10",
        allowConnections: "false",
        isTemplate: true,
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      cluster: { name: "pg" },
      name: "orders",
      owner: "app",
      databaseReclaimPolicy: "delete",
      template: "template0",
      encoding: "UTF8",
      localeProvider: "icu",
      icuLocale: "en-US",
      tablespace: "fast",
      connectionLimit: 10,
      allowConnections: false,
      isTemplate: true,
      extensions: [{ name: "postgis", version: "3.4", schema: "gis" }],
      schemas: [{ name: "sales", owner: "app" }],
    });
  });

  it("says the SQL in words and what it costs", () => {
    const facts = databaseFacts(
      READY,
      filled({ extensions: [{ name: "pg_stat_statements", version: "", schema: "" }], reclaim: "delete" }),
    );
    expect(facts.subject).toBe("Database db/pg-orders");
    expect(facts.writes[0].text).toBe("create Database db/pg-orders: database orders owned by app on pg");
    expect(facts.notes[0]).toBe("The primary of pg runs CREATE DATABASE orders OWNER app.");
    expect(facts.notes[1]).toBe("Then CREATE EXTENSION pg_stat_statements in it.");
    expect(facts.notes).toContain("Deleting the Database object drops the database in PostgreSQL.");
    expect(facts.warnings).toEqual([
      "With the delete policy the database and everything in it go when the object is deleted.",
    ]);
    expect(databaseFacts(READY, filled({ cluster: "sleepy" })).warnings[0]).toMatch(/hibernated/);
    expect(databaseFacts(READY, filled({ cluster: "mirror" })).warnings[0]).toMatch(/replica cluster/);
  });
});
