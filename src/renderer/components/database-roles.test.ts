/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import {
  certificateFacts,
  declaredInlineRoles,
  expiryWords,
  inlineRival,
  inlineRoles,
  inlineStatusWords,
  passwordFacts,
  roleAttributes,
  roleAttributeWords,
  roleHealth,
} from "./database-roles";

import type { DatabaseRoleSpec, DatabaseRoleStatus } from "../api/cnpg/database-role-v1";

const NOW = new Date("2026-09-19T12:00:00Z");

function role(
  spec: Partial<DatabaseRoleSpec> = {},
  status: DatabaseRoleStatus | undefined = { applied: true, observedGeneration: 1 },
  metadata: Record<string, unknown> = {},
): DatabaseRole {
  return new DatabaseRole({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "DatabaseRole",
    metadata: { name: "pg-reporting", namespace: "db", generation: 1, ...metadata },
    spec: { cluster: { name: "pg" }, name: "reporting", ...spec },
    status,
  } as never);
}

function cluster(managedRoles: unknown[] = [], managedRolesStatus?: unknown): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "pg", namespace: "db" },
    spec: { instances: 1, managed: { roles: managedRoles } },
    status: { currentPrimary: "pg-1", readyInstances: 1, managedRolesStatus },
  } as never);
}

describe("roleAttributes", () => {
  it("lists what is granted in a fixed order and marks what overrides every restriction", () => {
    const attributes = roleAttributes({
      name: "x",
      bypassrls: true,
      replication: true,
      createrole: true,
      createdb: true,
      superuser: true,
      login: true,
      inherit: false,
    });
    expect(attributes.map((attribute) => attribute.label)).toEqual([
      "Login",
      "Superuser",
      "Create database",
      "Create role",
      "Replication",
      "Bypass RLS",
      "No inherit",
    ]);
    expect(attributes.filter((attribute) => attribute.className === "warning").map((a) => a.label)).toEqual([
      "Superuser",
      "Bypass RLS",
    ]);
  });

  it("calls a role with nothing granted a group role", () => {
    expect(roleAttributes({ name: "x", inherit: true })).toEqual([]);
    expect(roleAttributeWords({ name: "x" })).toBe("None (a group role)");
    expect(roleAttributeWords({ name: "x", login: true, replication: true })).toBe("Login, Replication");
  });
});

describe("passwordFacts", () => {
  it("names the source of the password and never more than the name of its Secret", () => {
    expect(passwordFacts({ name: "x", passwordSecret: { name: "x-password" } }, NOW)).toMatchObject({
      source: "secret",
      secretName: "x-password",
      words: "Secret x-password",
      expired: false,
    });
    expect(passwordFacts({ name: "x", disablePassword: true }, NOW)).toMatchObject({
      source: "disabled",
      words: "Disabled",
    });
    expect(passwordFacts({ name: "x" }, NOW)).toMatchObject({ source: "unmanaged", words: "Not managed" });
  });

  it("knows an expired password at the edge", () => {
    expect(passwordFacts({ name: "x", validUntil: "2026-09-19T12:00:00Z" }, NOW).expired).toBe(true);
    expect(passwordFacts({ name: "x", validUntil: "2026-09-19T12:00:01Z" }, NOW).expired).toBe(false);
    expect(expiryWords(passwordFacts({ name: "x" }, NOW), NOW)).toBe("Never");
    expect(expiryWords(passwordFacts({ name: "x", validUntil: "2026-09-20T12:00:00Z" }, NOW), NOW)).toBe("in 1d");
    expect(expiryWords(passwordFacts({ name: "x", validUntil: "2026-10-19T18:00:00Z" }, NOW), NOW)).toBe("in 30d");
    expect(expiryWords(passwordFacts({ name: "x", validUntil: "2035-01-01T00:00:00Z" }, NOW), NOW)).toBe("in 8 years");
    expect(expiryWords(passwordFacts({ name: "x", validUntil: "2025-01-01T00:00:00Z" }, NOW), NOW)).toBe(
      "20 months ago",
    );
  });
});

describe("certificateFacts", () => {
  it("is off without the stanza or with it disabled", () => {
    expect(certificateFacts(role(), NOW).state).toBe("off");
    expect(certificateFacts(role({ clientCertificate: { enabled: false } }), NOW).state).toBe("off");
  });

  it("names the Secret after the object and reads the expiry the operator reports", () => {
    const issued = role(
      { clientCertificate: {} },
      { applied: true, observedGeneration: 1, clientCertificate: { expiration: "2026-12-18T11:57:25Z" } },
    );
    expect(certificateFacts(issued, NOW)).toMatchObject({
      state: "ok",
      secretName: "pg-reporting-client-cert",
      words: "Expires in 89d",
    });
  });

  it("tells the last week, the expiry and the wait apart", () => {
    const status = (expiration: string) => ({
      applied: true,
      observedGeneration: 1,
      clientCertificate: { expiration },
    });
    expect(certificateFacts(role({ clientCertificate: {} }, status("2026-09-22T12:00:00Z")), NOW)).toMatchObject({
      state: "renewing",
      words: "Expires in 3d: the operator renews it in its last 7 days",
    });
    expect(certificateFacts(role({ clientCertificate: {} }, status("2026-09-18T12:00:00Z")), NOW)).toMatchObject({
      state: "expired",
      words: "Expired 1d ago: the operator should have renewed it",
    });
    expect(
      certificateFacts(
        role({ clientCertificate: {} }, { applied: true, clientCertificate: { message: "waiting for the client CA" } }),
        NOW,
      ),
    ).toMatchObject({ state: "pending", words: "waiting for the client CA" });
  });
});

describe("roleHealth", () => {
  // As observed on the E2E cluster (operator 1.30.0).
  it("tells the conflict with the cluster spec in words", () => {
    const rival = role(
      { name: "e2e_inline", login: true },
      { applied: false, message: "database role is already managed by the CNPG cluster" },
    );
    const owner = cluster([{ name: "e2e_inline", ensure: "present" }]);
    expect(inlineRival(rival, owner)?.name).toBe("e2e_inline");
    expect(roleHealth(rival, { cluster: owner }, NOW)).toMatchObject({
      state: "Failed",
      className: "error",
      reason: "Ignored: the cluster spec declares the same role in managed.roles, and the cluster spec wins",
    });
    // The message alone is enough, should the cluster not be loaded.
    expect(roleHealth(rival, { cluster: undefined, known: false }, NOW).reason).toContain("the cluster spec wins");
  });

  it("keeps any other failure as the operator words it", () => {
    const failing = role({}, { applied: false, message: 'ERROR: role "e2e_no_such_group" does not exist' });
    expect(roleHealth(failing, { cluster: cluster() }, NOW).reason).toBe(
      'ERROR: role "e2e_no_such_group" does not exist',
    );
  });

  it("warns on an applied login role whose password expired, and only on a login role", () => {
    const expired = { passwordSecret: { name: "s" }, validUntil: "2025-01-01T00:00:00Z" };
    const health = roleHealth(role({ ...expired, login: true }), { cluster: cluster() }, NOW);
    expect(health).toMatchObject({ state: "Applied", className: "warning" });
    expect(health.reason).toMatch(/^Applied, but the password expired .* ago: the role cannot log in with it$/);
    expect(roleHealth(role(expired), { cluster: cluster() }, NOW).className).toBe("success");
  });

  it("warns on an expired client certificate", () => {
    const stale = role(
      { login: true, clientCertificate: {} },
      { applied: true, observedGeneration: 1, clientCertificate: { expiration: "2026-09-01T00:00:00Z" } },
    );
    expect(roleHealth(stale, { cluster: cluster() }, NOW)).toMatchObject({ state: "Applied", className: "warning" });
  });

  it("says why a role with the delete policy can stay terminating", () => {
    const deleting = role(
      { databaseRoleReclaimPolicy: "delete" },
      { applied: true, observedGeneration: 1 },
      {
        deletionTimestamp: "2026-09-19T11:00:00Z",
      },
    );
    expect(roleHealth(deleting, { cluster: cluster() }, NOW).reason).toBe(
      "Being deleted: the role is dropped from PostgreSQL first. A role that owns objects cannot be dropped until they are reassigned or dropped",
    );
  });
});

describe("inline roles", () => {
  // As observed on the E2E cluster (operator 1.30.0).
  const STATUS = {
    byStatus: {
      "not-managed": ["app"],
      "pending-reconciliation": ["e2e_inline_stuck"],
      reconciled: ["e2e_inline"],
      reserved: ["postgres", "cnpg_metrics_exporter", "streaming_replica"],
    },
    cannotReconcile: {
      e2e_inline_stuck: ['could not perform CREATE on role e2e_inline_stuck: role "e2e_no_such_group" does not exist'],
    },
  };
  const owner = cluster([{ name: "e2e_inline" }, { name: "e2e_inline_stuck", inRoles: ["e2e_no_such_group"] }], STATUS);

  it("lists every role the operator reports, the stuck ones first and the platform's own last", () => {
    expect(inlineRoles(owner).map((entry) => `${entry.name}:${entry.className}`)).toEqual([
      "e2e_inline_stuck:error",
      "e2e_inline:success",
      "app:info",
      "cnpg_metrics_exporter:info",
      "postgres:info",
      "streaming_replica:info",
    ]);
  });

  it("narrows to the roles the cluster spec declares and words their state", () => {
    const declared = declaredInlineRoles(owner);
    expect(declared.map((entry) => entry.name)).toEqual(["e2e_inline_stuck", "e2e_inline"]);
    expect(inlineStatusWords(declared[0])).toBe(
      'cannot be reconciled: could not perform CREATE on role e2e_inline_stuck: role "e2e_no_such_group" does not exist',
    );
    expect(inlineStatusWords(declared[1])).toBe("reconciled");
  });

  it("keeps a role that is only in cannotReconcile and survives a cluster without the status", () => {
    const partial = cluster([{ name: "lonely" }], { cannotReconcile: { lonely: ["no"] } });
    expect(inlineRoles(partial)).toEqual([
      { name: "lonely", status: "pending-reconciliation", reasons: ["no"], className: "error" },
    ]);
    expect(inlineRoles(cluster())).toEqual([]);
    expect(inlineRoles(undefined)).toEqual([]);
  });
});
