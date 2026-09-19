/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Database } from "../api/cnpg/database-v1";
import {
  classifyDeclarative,
  clusterOf,
  conflictingObjects,
  connectionLimitWords,
  countHealth,
  countWords,
  creationParameters,
  databaseHealth,
  failureWords,
  generationWords,
  managedObjects,
  objectsOfCluster,
  reclaimWords,
} from "./declarative";

import type { DatabaseSpec, DatabaseStatus } from "../api/cnpg/database-v1";

function cluster({
  name = "pg",
  namespace = "db",
  primary = "pg-1" as string | undefined,
  ready = 1,
  hibernated = false,
  replica = false,
} = {}): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace, annotations: hibernated ? { "cnpg.io/hibernation": "on" } : {} },
    spec: { instances: 1, replica: replica ? { enabled: true, source: "origin" } : undefined },
    status: { currentPrimary: primary, readyInstances: ready },
  } as never);
}

function database(
  status: DatabaseStatus | undefined,
  spec: Partial<DatabaseSpec> = {},
  metadata: Record<string, unknown> = {},
): Database {
  return new Database({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: { name: "pg-inventory", namespace: "db", generation: 1, ...metadata },
    spec: { cluster: { name: "pg" }, name: "inventory", owner: "app", ...spec },
    status,
  } as never);
}

const WORDS = { what: "database" } as const;

describe("classifyDeclarative", () => {
  it("reads an applied object whose generation is current", () => {
    const health = classifyDeclarative(
      database({ applied: true, observedGeneration: 1 }),
      { cluster: cluster() },
      WORDS,
    );
    expect(health).toMatchObject({ state: "Applied", className: "success", reason: "Applied to PostgreSQL" });
  });

  it("says that a change waits when the applied generation is older", () => {
    const health = classifyDeclarative(
      database({ applied: true, observedGeneration: 2 }, {}, { generation: 3 }),
      { cluster: cluster() },
      WORDS,
    );
    expect(health.state).toBe("Updating");
    expect(health.reason).toBe("A change waits to be applied (generation 3, applied 2)");
  });

  // As observed on the E2E cluster (operator 1.30.0).
  it("shows the operator's own reason for a failure, first line only", () => {
    const message = 'while creating database "orders": ERROR: role "e2e_nobody" does not exist (SQLSTATE 42704)\nmore';
    const health = classifyDeclarative(database({ applied: false, message }), { cluster: cluster() }, WORDS);
    expect(health).toMatchObject({ state: "Failed", className: "error" });
    expect(health.reason).toBe(
      'while creating database "orders": ERROR: role "e2e_nobody" does not exist (SQLSTATE 42704)',
    );
  });

  it("tells the conflict between two objects in full", () => {
    const message = '"inventory" is already managed by object "e2e-db-inventory"';
    expect(failureWords(message, WORDS)).toBe(
      'Ignored: the object "e2e-db-inventory" already manages the same database',
    );
    // The wording of the upstream documentation.
    expect(
      failureWords(
        'reconciliation error: database "one" is already managed by Database object "cluster-example-one"',
        WORDS,
      ),
    ).toBe('Ignored: the object "cluster-example-one" already manages the same database');
  });

  it("does not leave a failure without words", () => {
    expect(failureWords(undefined, WORDS)).toBe("The database could not be applied; the operator gave no reason");
  });

  it("keeps a failure a failure even when the cluster is gone", () => {
    const health = classifyDeclarative(database({ applied: false, message: "boom" }), { cluster: undefined }, WORDS);
    expect(health.state).toBe("Failed");
  });

  it("reads the unset applied with a message as the operator waiting on purpose", () => {
    const health = classifyDeclarative(
      database({ message: "waiting for the cluster to become primary" }),
      { cluster: cluster({ replica: true }) },
      WORDS,
    );
    expect(health).toMatchObject({ state: "Waiting", className: "info" });
    expect(health.reason).toBe("Waiting for the cluster to become primary: a replica cluster is read-only");
    expect(classifyDeclarative(database({ message: "something else" }), { cluster: cluster() }, WORDS).reason).toBe(
      "something else",
    );
  });

  it("explains an object nobody could try to apply", () => {
    expect(classifyDeclarative(database(undefined), { cluster: cluster({ hibernated: true }) }, WORDS)).toMatchObject({
      state: "Pending",
      reason: "Waiting for a running primary: the cluster is hibernated",
    });
    expect(
      classifyDeclarative(database(undefined), { cluster: cluster({ primary: undefined, ready: 0 }) }, WORDS),
    ).toMatchObject({
      state: "Pending",
      reason: "Waiting for a running primary: its instance manager is what applies this object",
    });
    expect(classifyDeclarative(database(undefined), { cluster: cluster({ replica: true }) }, WORDS).state).toBe(
      "Waiting",
    );
    expect(classifyDeclarative(database(undefined), { cluster: cluster() }, WORDS)).toMatchObject({
      state: "Pending",
      reason: "Not applied yet",
    });
  });

  it("calls an object without its cluster an orphan, but only once the clusters are known", () => {
    expect(classifyDeclarative(database(undefined), { cluster: undefined }, WORDS)).toMatchObject({
      state: "Orphan",
      className: "warning",
      reason: "The Cluster pg is not there: nothing applies this object",
    });
    expect(classifyDeclarative(database(undefined), { cluster: undefined, known: false }, WORDS).state).toBe("Pending");
  });

  it("says what a deletion does to PostgreSQL, by reclaim policy", () => {
    const deleting = { deletionTimestamp: "2026-09-19T10:00:00Z" };
    expect(
      classifyDeclarative(
        database({ applied: true, observedGeneration: 1 }, {}, deleting),
        { cluster: cluster() },
        WORDS,
      ),
    ).toMatchObject({ state: "Deleting", reason: "Being deleted: the database stays in PostgreSQL" });
    expect(
      classifyDeclarative(
        database({ applied: false, message: "cannot drop" }, {}, deleting),
        { cluster: cluster() },
        { what: "database", reclaimPolicy: "delete" },
      ).reason,
    ).toBe("Being deleted, the database is dropped from PostgreSQL first. Last answer: cannot drop");
  });
});

describe("databaseHealth", () => {
  it("reads a database declared absent and applied as absent, not as a success", () => {
    const health = databaseHealth(database({ applied: true, observedGeneration: 1 }, { ensure: "absent" }), {
      cluster: cluster(),
    });
    expect(health).toMatchObject({ state: "Absent", className: "info" });
  });

  // As observed on the E2E cluster: the database carries a generic message,
  // the reason is in the entry of the managed object.
  it("names the managed object that failed instead of the generic message", () => {
    const failing = database(
      {
        applied: false,
        message: "database object reconciliation failed",
        extensions: [
          {
            name: "e2e_no_such_extension",
            applied: false,
            message: 'ERROR: extension "e2e_no_such_extension" is not available (SQLSTATE 0A000)',
          },
        ],
        schemas: [{ name: "reports", applied: true }],
      },
      { extensions: [{ name: "e2e_no_such_extension" }], schemas: [{ name: "reports", owner: "app" }] },
    );
    expect(databaseHealth(failing, { cluster: cluster() }).reason).toBe(
      'Extension "e2e_no_such_extension" failed: ERROR: extension "e2e_no_such_extension" is not available (SQLSTATE 0A000)',
    );
  });

  it("counts the other failed objects", () => {
    const failing = database(
      {
        applied: false,
        message: "database object reconciliation failed",
        extensions: [{ name: "a", applied: false, message: "no a" }],
        schemas: [{ name: "b", applied: false, message: "no b" }],
      },
      { extensions: [{ name: "a" }], schemas: [{ name: "b" }] },
    );
    expect(databaseHealth(failing, { cluster: cluster() }).reason).toBe('Extension "a" failed: no a (and 1 more)');
  });
});

describe("managedObjects", () => {
  it("joins every declared object with what the operator reported on it", () => {
    const rows = managedObjects(
      database(
        {
          applied: true,
          extensions: [{ name: "pgcrypto", applied: true }],
          servers: [{ name: "remote", applied: false, message: "no wrapper\nsecond line" }],
        },
        {
          extensions: [{ name: "pgcrypto", version: "1.3", schema: "public" }],
          schemas: [{ name: "stock", owner: "app", ensure: "absent" }],
          fdws: [{ name: "postgres_fdw", handler: "postgres_fdw_handler", owner: "postgres" }],
          servers: [{ name: "remote", fdw: "postgres_fdw" }],
        },
      ),
    );
    expect(rows).toEqual([
      {
        kind: "Extension",
        name: "pgcrypto",
        detail: "version 1.3, in schema public",
        ensure: "present",
        applied: true,
      },
      { kind: "Schema", name: "stock", detail: "owner app", ensure: "absent", applied: undefined },
      {
        kind: "FDW",
        name: "postgres_fdw",
        detail: "handler postgres_fdw_handler, owner postgres",
        ensure: "present",
        applied: undefined,
      },
      {
        kind: "Server",
        name: "remote",
        detail: "wrapper postgres_fdw",
        ensure: "present",
        applied: false,
        message: "no wrapper",
      },
    ]);
    expect(managedObjects(database(undefined))).toEqual([]);
    expect(managedObjects(database(undefined, { extensions: [{ name: "pgcrypto" }] }))[0].detail).toBe(
      "default version",
    );
  });
});

describe("helpers", () => {
  it("finds the cluster of an object in its own namespace only", () => {
    const here = cluster();
    const elsewhere = cluster({ namespace: "other" });
    expect(clusterOf(database(undefined), [elsewhere, here])).toBe(here);
    expect(clusterOf(database(undefined), [elsewhere])).toBeUndefined();
    expect(clusterOf(database(undefined, { cluster: { name: "" } }), [here])).toBeUndefined();
  });

  it("lists the objects of a cluster by name", () => {
    const b = database(undefined, {}, { name: "b" });
    const a = database(undefined, {}, { name: "a" });
    const other = database(undefined, { cluster: { name: "other" } }, { name: "c" });
    expect(objectsOfCluster(cluster(), [b, other, a])).toEqual([a, b]);
  });

  it("finds the rivals of an object: same namespace, cluster and PostgreSQL name", () => {
    const first = database(undefined, {}, { name: "first" });
    const second = database(undefined, {}, { name: "second" });
    const otherName = database(undefined, { name: "orders" }, { name: "third" });
    const otherCluster = database(undefined, { cluster: { name: "pg2" } }, { name: "fourth" });
    const otherNamespace = database(undefined, {}, { name: "fifth", namespace: "other" });
    const all = [first, second, otherName, otherCluster, otherNamespace];
    expect(conflictingObjects(second, all)).toEqual([first]);
    expect(conflictingObjects(otherName, all)).toEqual([]);
  });

  it("puts the reclaim policy, the generations and the connection limit in words", () => {
    expect(reclaimWords(undefined, "database")).toBe("retain: deleting this object leaves the database in PostgreSQL");
    expect(reclaimWords("delete", "role")).toBe("delete: deleting this object drops the role from PostgreSQL");
    expect(generationWords(database({ applied: true, observedGeneration: 2 }, {}, { generation: 2 }))).toBe(
      "2, applied",
    );
    expect(generationWords(database({ applied: true, observedGeneration: 1 }, {}, { generation: 2 }))).toBe(
      "2 declared, 1 applied",
    );
    expect(generationWords(database(undefined))).toBe("1 declared, none applied yet");
    expect(connectionLimitWords(undefined)).toBe("Unlimited");
    expect(connectionLimitWords(-1)).toBe("Unlimited");
    expect(connectionLimitWords(20)).toBe("20");
  });

  it("lists only the creation parameters that are set", () => {
    expect(creationParameters(database(undefined))).toEqual([]);
    expect(
      creationParameters(database(undefined, { encoding: "UTF8", localeProvider: "icu", icuLocale: "en-US" })),
    ).toEqual([
      { name: "Encoding", value: "UTF8" },
      { name: "Locale provider", value: "icu" },
      { name: "ICU locale", value: "en-US" },
    ]);
  });

  it("counts the conditions in three buckets and words only the ones that have something", () => {
    const healths = [
      classifyDeclarative(database({ applied: true, observedGeneration: 1 }), { cluster: cluster() }, WORDS),
      databaseHealth(database({ applied: true, observedGeneration: 1 }, { ensure: "absent" }), { cluster: cluster() }),
      classifyDeclarative(database({ applied: false, message: "x" }), { cluster: cluster() }, WORDS),
      classifyDeclarative(database(undefined), { cluster: undefined }, WORDS),
    ];
    const counts = countHealth(healths);
    expect(counts).toEqual({ total: 4, applied: 2, failed: 1, waiting: 1 });
    expect(countWords(counts)).toBe("2 applied, 1 failed, 1 waiting");
    expect(countWords(countHealth([]))).toBe("none");
  });
});
