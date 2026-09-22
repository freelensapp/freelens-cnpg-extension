/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  databaseRoleBlockReason,
  databaseRoleBody,
  databaseRoleErrors,
  databaseRoleFacts,
  databaseRoleSummaryWarnings,
  databaseRoleWarnings,
  defaultDatabaseRoleForm,
} from "./database-role-create";

import type { DatabaseRoleForm, DatabaseRoleInputs } from "./database-role-create";

const READY: DatabaseRoleInputs = {
  clusters: [
    {
      name: "pg",
      hibernated: false,
      primaryRunning: true,
      replica: false,
      managedRoles: ["inline_role"],
      roles: ["app", "reporting"],
    },
    { name: "sleepy", hibernated: true, primaryRunning: false, replica: false, managedRoles: [], roles: [] },
  ],
  roles: [{ objectName: "pg-reporting", cluster: "pg", name: "reporting" }],
  secrets: [
    { name: "batch-password", type: "kubernetes.io/basic-auth", username: "batch" },
    { name: "other-password", type: "kubernetes.io/basic-auth", username: "someone" },
    { name: "tls", type: "kubernetes.io/tls" },
  ],
  reads: { clusters: "ready", roles: "ready", secrets: "ready" },
};

function filled(overrides: Partial<DatabaseRoleForm> = {}): DatabaseRoleForm {
  return {
    ...defaultDatabaseRoleForm("db", "pg"),
    name: "pg-batch",
    roleName: "batch",
    passwordSecret: "batch-password",
    ...overrides,
  };
}

describe("the errors", () => {
  it("want a cluster, names PostgreSQL and the CRD accept, and a secret for the password", () => {
    expect(databaseRoleBlockReason(READY, defaultDatabaseRoleForm("db"))).toBe("Pick a cluster");
    expect(databaseRoleBlockReason(READY, filled({ roleName: "postgres" }))).toBe("The role name postgres is reserved");
    expect(databaseRoleBlockReason(READY, filled({ roleName: "pg_batch" }))).toMatch(/reserved by PostgreSQL/);
    expect(databaseRoleBlockReason(READY, filled({ roleName: "inline_role" }))).toMatch(
      /managed roles of pg: the inline entry always wins/,
    );
    expect(databaseRoleBlockReason(READY, filled({ passwordSecret: "" }))).toBe(
      "Pick the secret that holds the password",
    );
    expect(databaseRoleBlockReason(READY, filled({ auth: "none", passwordSecret: "" }))).toBeUndefined();
    expect(databaseRoleErrors(READY, filled({ clientCertificate: true, login: false })).clientCertificate).toMatch(
      /log in/,
    );
    expect(databaseRoleErrors(READY, filled({ connectionLimit: "-2" })).connectionLimit).toMatch(/-1 for no limit/);
    expect(databaseRoleErrors(READY, filled({ connectionLimit: "-1" })).connectionLimit).toBeUndefined();
    expect(databaseRoleErrors(READY, filled({ validUntil: "tomorrow" })).validUntil).toMatch(/RFC 3339/);
    const memberships = databaseRoleErrors(READY, filled({ inRoles: ["pg_monitor", "pg_monitor", "batch", "Bad"] }));
    expect(memberships["inRoles.1"]).toBe("pg_monitor is listed twice");
    expect(memberships["inRoles.2"]).toBe("A role cannot be a member of itself");
    expect(memberships["inRoles.3"]).toMatch(/lowercase/);
    expect(memberships.inRoles).toBe("A membership is wrong");
    expect(databaseRoleBlockReason(READY, filled())).toBeUndefined();
  });

  it("warn on collisions, a rival object, the secret and unknown groups", () => {
    expect(databaseRoleWarnings(READY, filled({ name: "pg-reporting" })).name).toMatch(/already exists/);
    expect(databaseRoleWarnings(READY, filled({ roleName: "reporting" })).roleName).toMatch(
      /pg-reporting already declares the role reporting/,
    );
    expect(databaseRoleWarnings(READY, filled({ passwordSecret: "nope" })).passwordSecret).toMatch(
      /No secret named nope/,
    );
    expect(databaseRoleWarnings(READY, filled({ passwordSecret: "tls" })).passwordSecret).toMatch(
      /kubernetes.io\/tls secret/,
    );
    expect(databaseRoleWarnings(READY, filled({ passwordSecret: "other-password" })).passwordSecret).toMatch(
      /carries the username someone, not batch/,
    );
    expect(databaseRoleWarnings(READY, filled({ inRoles: ["pg_monitor", "reporting", "ghost"] })).inRoles).toMatch(
      /No role named ghost is known for pg/,
    );
    expect(databaseRoleWarnings(READY, filled({ cluster: "ghost" })).cluster).toMatch(/No cluster named ghost/);
    expect(databaseRoleWarnings(READY, filled())).toEqual({});
  });
});

describe("the body and the facts", () => {
  it("sends the attributes that are on, the memberships and the authentication chosen", () => {
    expect(databaseRoleBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "DatabaseRole",
      metadata: { name: "pg-batch", namespace: "db" },
      spec: { cluster: { name: "pg" }, name: "batch", login: true, passwordSecret: { name: "batch-password" } },
    });
    const body = databaseRoleBody(
      filled({
        auth: "none",
        comment: "nightly batch",
        superuser: true,
        createdb: true,
        createrole: true,
        replication: true,
        bypassrls: true,
        inherit: false,
        connectionLimit: "5",
        validUntil: "2030-01-01T00:00:00Z",
        inRoles: ["pg_monitor", " reporting "],
        clientCertificate: true,
        reclaim: "delete",
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      cluster: { name: "pg" },
      name: "batch",
      comment: "nightly batch",
      login: true,
      superuser: true,
      createdb: true,
      createrole: true,
      replication: true,
      bypassrls: true,
      inherit: false,
      connectionLimit: 5,
      validUntil: "2030-01-01T00:00:00Z",
      inRoles: ["pg_monitor", "reporting"],
      disablePassword: true,
      clientCertificate: { enabled: true },
      databaseRoleReclaimPolicy: "delete",
    });
    const untouched = databaseRoleBody(filled({ auth: "untouched", login: false })) as {
      spec: Record<string, unknown>;
    };
    expect(untouched.spec.passwordSecret).toBeUndefined();
    expect(untouched.spec.disablePassword).toBeUndefined();
    expect(untouched.spec.login).toBeUndefined();
  });

  it("says the SQL in words and what it costs", () => {
    const facts = databaseRoleFacts(READY, filled({ inRoles: ["pg_monitor"], connectionLimit: "10" }));
    expect(facts.subject).toBe("DatabaseRole db/pg-batch");
    expect(facts.writes[0].text).toBe("create DatabaseRole db/pg-batch: role batch on pg, can log in");
    expect(facts.notes[0]).toBe(
      "The primary of pg runs CREATE ROLE batch WITH LOGIN CONNECTION LIMIT 10 IN ROLE pg_monitor.",
    );
    expect(facts.notes[1]).toMatch(/password comes from the secret batch-password/);
    expect(facts.warnings).toEqual([]);
    const costly = databaseRoleSummaryWarnings(
      READY,
      filled({
        cluster: "sleepy",
        superuser: true,
        replication: true,
        auth: "untouched",
        validUntil: "2020-01-01T00:00:00Z",
        reclaim: "delete",
      }),
    );
    expect(costly[0]).toMatch(/hibernated/);
    expect(costly[1]).toMatch(/superuser/);
    expect(costly[2]).toMatch(/REPLICATION/);
    expect(costly[3]).toMatch(/cannot connect by password/);
    expect(costly[4]).toMatch(/already past/);
    expect(costly[5]).toMatch(/delete policy/);
    expect(databaseRoleFacts(READY, filled({ auth: "none", clientCertificate: true })).notes[2]).toMatch(
      /pg-batch-client-cert/,
    );
  });
});
