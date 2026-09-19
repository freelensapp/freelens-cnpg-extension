/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canOpenPsql,
  isNamespaceName,
  isPodName,
  psqlCommand,
  psqlTabId,
  psqlTabTitle,
  psqlTarget,
  psqlTooltip,
} from "./psql";

import type { PsqlClusterFacts } from "./psql";

function cluster(overrides: Partial<PsqlClusterFacts> = {}): PsqlClusterFacts {
  return {
    name: "pg",
    namespace: "db",
    hibernated: false,
    currentPrimary: "pg-1",
    instances: [
      { name: "pg-1", role: "primary", fenced: false },
      { name: "pg-2", role: "replica", fenced: false },
      { name: "pg-3", role: "replica", fenced: true },
    ],
    ...overrides,
  };
}

describe("psqlTarget", () => {
  it("takes the named instance, then the current primary, then the health model's primary", () => {
    expect(psqlTarget(cluster(), "pg-2")).toEqual({ pod: "pg-2", namespace: "db", role: "replica", fenced: false });
    expect(psqlTarget(cluster())).toEqual({ pod: "pg-1", namespace: "db", role: "primary", fenced: false });
    expect(psqlTarget(cluster({ currentPrimary: undefined }))?.pod).toBe("pg-1");
  });

  it("trusts the current primary before the instance lists catch up, and refuses an instance that is not the cluster's", () => {
    expect(psqlTarget(cluster({ currentPrimary: "pg-9" }))).toEqual({
      pod: "pg-9",
      namespace: "db",
      role: "primary",
      fenced: false,
    });
    expect(psqlTarget(cluster(), "somebody-else-1")).toBeUndefined();
    expect(psqlTarget(cluster({ currentPrimary: undefined, instances: [] }))).toBeUndefined();
  });
});

describe("canOpenPsql", () => {
  it("is enabled on a primary and on a standby", () => {
    expect(canOpenPsql(cluster(), psqlTarget(cluster()))).toEqual({ enabled: true });
    expect(canOpenPsql(cluster(), psqlTarget(cluster(), "pg-2"))).toEqual({ enabled: true });
  });

  it("says why it is not", () => {
    const hibernated = cluster({ hibernated: true });
    expect(canOpenPsql(hibernated, psqlTarget(hibernated))).toEqual({
      enabled: false,
      reason: "The cluster is hibernated: there is no instance to connect to",
    });
    expect(canOpenPsql(cluster(), undefined)).toEqual({
      enabled: false,
      reason: "The cluster status names no primary yet",
    });
    expect(canOpenPsql(cluster(), psqlTarget(cluster(), "pg-3"))).toEqual({
      enabled: false,
      reason: "pg-3 is fenced: PostgreSQL is stopped on it",
    });
    const odd = cluster({ namespace: "Db; rm -rf /" });
    expect(canOpenPsql(odd, psqlTarget(odd))).toMatchObject({ enabled: false });
  });
});

describe("names", () => {
  it("accepts what the API server accepts and nothing a shell could read as more", () => {
    expect(isNamespaceName("cnpg-e2e")).toBe(true);
    expect(isPodName("e2e-main-1")).toBe(true);
    expect(isPodName("a.b-c.d")).toBe(true);
    for (const bad of [
      "",
      "Upper",
      "with space",
      "semi;colon",
      "quo'te",
      "dollar$x",
      "-lead",
      "trail-",
      "a".repeat(254),
    ]) {
      expect(isPodName(bad)).toBe(false);
    }
    expect(isNamespaceName("has.dot")).toBe(false);
    expect(isNamespaceName("a".repeat(64))).toBe(false);
    expect(isNamespaceName(undefined)).toBe(false);
  });
});

describe("psqlCommand", () => {
  const target = { pod: "e2e-main-1", namespace: "cnpg-e2e", role: "primary" as const, fenced: false };

  it("is the command the upstream plugin runs, on the postgres container", () => {
    expect(psqlCommand(target)).toBe("kubectl exec -i -t -n 'cnpg-e2e' 'e2e-main-1' -c postgres -- psql -U postgres");
  });

  it("uses the configured kubectl when there is one", () => {
    expect(psqlCommand(target, "/opt/bin/kubectl")).toBe(
      "'/opt/bin/kubectl' exec -i -t -n 'cnpg-e2e' 'e2e-main-1' -c postgres -- psql -U postgres",
    );
    expect(psqlCommand(target, "  ")).toMatch(/^kubectl exec/);
  });

  it("refuses to compose from a name that is not a Kubernetes name", () => {
    expect(() => psqlCommand({ ...target, pod: "x'; drop database app; --" })).toThrow(/refusing/);
    expect(() => psqlCommand({ ...target, namespace: "a b" })).toThrow(/refusing/);
  });

  it("names the tab after the pod", () => {
    expect(psqlTabTitle(target)).toBe("psql: e2e-main-1");
    expect(psqlTabId(target)).toBe("cnpg-psql-cnpg-e2e-e2e-main-1");
  });
});

describe("psqlTooltip", () => {
  it("states the superuser session and the role, or the reason", () => {
    const facts = cluster();
    expect(psqlTooltip(psqlTarget(facts), { enabled: true })).toBe(
      "Opens psql on the primary pg-1 as the postgres superuser, through kubectl exec with your own credentials (needs pods/exec)",
    );
    expect(psqlTooltip(psqlTarget(facts, "pg-2"), { enabled: true })).toContain(
      "on the standby pg-2 (a read-only session)",
    );
    expect(psqlTooltip(undefined, { enabled: false, reason: "The cluster status names no primary yet" })).toBe(
      "Open psql: The cluster status names no primary yet",
    );
  });
});
