/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import {
  failoverSafety,
  parseServiceHost,
  publicationHealth,
  publicationsOfSubscription,
  publicationTarget,
  resolvePublisher,
  slotName,
  subscriptionHealth,
  subscriptionNotes,
  subscriptionsOfPublication,
} from "./logical-replication";

import type { ClusterSpec } from "../api/cnpg/cluster-v1";
import type { PublicationSpec } from "../api/cnpg/publication-v1";
import type { SubscriptionSpec } from "../api/cnpg/subscription-v1";

function cluster(name: string, spec: Partial<ClusterSpec> = {}, namespace = "db"): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace },
    spec: { instances: 1, ...spec },
    status: { currentPrimary: `${name}-1`, readyInstances: 1 },
  } as never);
}

function publication(spec: Partial<PublicationSpec> = {}, name = "pub", namespace = "db"): Publication {
  return new Publication({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Publication",
    metadata: { name, namespace, generation: 1 },
    spec: { cluster: { name: "freddie" }, dbname: "app", name: "publisher", target: { allTables: true }, ...spec },
    status: { applied: true, observedGeneration: 1 },
  } as never);
}

function subscription(spec: Partial<SubscriptionSpec> = {}, name = "sub", namespace = "db"): Subscription {
  return new Subscription({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Subscription",
    metadata: { name, namespace, generation: 1 },
    spec: {
      cluster: { name: "king" },
      dbname: "app",
      name: "subscriber",
      externalClusterName: "freddie",
      publicationName: "publisher",
      ...spec,
    },
    status: { applied: true, observedGeneration: 1 },
  } as never);
}

const FREDDIE = cluster("freddie", { instances: 3 });
const KING = cluster("king", {
  externalClusters: [
    { name: "freddie", connectionParameters: { host: "freddie-rw.db.svc", user: "app", dbname: "app" } },
    { name: "elsewhere", connectionParameters: { host: "pg.example.com", user: "repl", dbname: "sales" } },
    { name: "nohost", connectionParameters: { user: "repl" } },
  ],
});

describe("publicationTarget", () => {
  it("reads all tables", () => {
    expect(publicationTarget(publication())).toEqual({ allTables: true, words: "All tables", objects: [] });
  });

  it("reads tables with their columns and schemas, and counts them in words", () => {
    const view = publicationTarget(
      publication({
        target: {
          objects: [
            { table: { schema: "public", name: "e2e_numbers", columns: ["i", "m"] } },
            { table: { name: "events", only: true } },
            { tablesInSchema: "audit" },
          ],
        },
      }),
    );
    expect(view.words).toBe("2 tables, 1 schema");
    expect(view.objects).toEqual([
      { kind: "Table", name: "public.e2e_numbers", detail: "columns i, m" },
      { kind: "Table", name: "events", detail: "all columns; the table only, not the ones that inherit from it" },
      { kind: "Schema", name: "audit", detail: "every table, the future ones included" },
    ]);
    expect(publicationTarget(publication({ target: {} })).words).toBe("Nothing");
  });
});

describe("parseServiceHost", () => {
  it("reads every form of a cluster service host", () => {
    expect(parseServiceHost("freddie-rw", "db")).toEqual({ cluster: "freddie", namespace: "db", service: "rw" });
    expect(parseServiceHost("freddie-rw.other", "db")).toEqual({
      cluster: "freddie",
      namespace: "other",
      service: "rw",
    });
    expect(parseServiceHost("freddie-ro.other.svc", "db")?.service).toBe("ro");
    expect(parseServiceHost("Freddie-R.other.svc.cluster.local.", "db")).toEqual({
      cluster: "freddie",
      namespace: "other",
      service: "r",
    });
    expect(parseServiceHost("my-pg-rw", "db")?.cluster).toBe("my-pg");
  });

  it("does not take any host for a cluster service", () => {
    expect(parseServiceHost("pg.example.com", "db")).toBeUndefined();
    expect(parseServiceHost("freddie-rw.example.com.", "db")).toBeUndefined();
    expect(parseServiceHost("freddie", "db")).toBeUndefined();
    expect(parseServiceHost(undefined, "db")).toBeUndefined();
  });
});

describe("resolvePublisher", () => {
  it("finds the cluster of this Kubernetes cluster behind the external cluster entry", () => {
    const view = resolvePublisher(subscription(), KING, [KING, FREDDIE]);
    expect(view).toMatchObject({
      outcome: "resolved",
      host: "freddie-rw.db.svc",
      user: "app",
      database: "app",
      service: "rw",
      words: "freddie through its rw service",
    });
    expect(view.cluster).toBe(FREDDIE);
  });

  it("prefers the publication database the subscription names", () => {
    expect(resolvePublisher(subscription({ publicationDBName: "sales" }), KING, [KING, FREDDIE]).database).toBe(
      "sales",
    );
  });

  it("calls a host that is no cluster here external, which is fine", () => {
    expect(resolvePublisher(subscription({ externalClusterName: "elsewhere" }), KING, [KING, FREDDIE])).toMatchObject({
      outcome: "external",
      host: "pg.example.com",
      words: "pg.example.com: not a cluster of this Kubernetes cluster, or not one you can see",
    });
    // A service host of a cluster nobody can see is external too.
    expect(resolvePublisher(subscription(), KING, [KING]).outcome).toBe("external");
    expect(resolvePublisher(subscription({ externalClusterName: "nohost" }), KING, [KING]).words).toBe(
      "The external cluster entry has no host",
    );
  });

  // As observed on the E2E cluster: the operator fails such a subscription too.
  it("says when the subscriber cluster declares no such external cluster", () => {
    expect(resolvePublisher(subscription({ externalClusterName: "e2e-nowhere" }), KING, [KING])).toMatchObject({
      outcome: "undefined",
      words: "The cluster king declares no external cluster named e2e-nowhere",
    });
    expect(resolvePublisher(subscription(), undefined, []).outcome).toBe("undefined");
  });
});

describe("the pair", () => {
  const matching = publication();
  const otherName = publication({ name: "another" }, "pub-other");
  const otherDatabase = publication({ dbname: "sales" }, "pub-sales");
  const otherCluster = publication({ cluster: { name: "king" } }, "pub-king");

  it("finds the publication a subscription consumes: publisher, database and name", () => {
    const publisher = resolvePublisher(subscription(), KING, [KING, FREDDIE]);
    expect(
      publicationsOfSubscription(subscription(), publisher, [otherName, otherDatabase, otherCluster, matching]),
    ).toEqual([matching]);
    const external = resolvePublisher(subscription({ externalClusterName: "elsewhere" }), KING, [KING, FREDDIE]);
    expect(publicationsOfSubscription(subscription(), external, [matching])).toEqual([]);
  });

  it("finds the subscriptions of a publication", () => {
    const consumer = subscription({}, "b-sub");
    const second = subscription({ name: "second" }, "a-sub");
    const stranger = subscription({ publicationName: "another" }, "c-sub");
    expect(subscriptionsOfPublication(matching, [consumer, stranger, second], [KING, FREDDIE])).toEqual([
      second,
      consumer,
    ]);
    expect(subscriptionsOfPublication(otherDatabase, [consumer], [KING, FREDDIE])).toEqual([]);
  });
});

describe("slot, notes and failover", () => {
  it("names the slot after the subscription unless slot_name says otherwise", () => {
    expect(slotName(subscription())).toBe("subscriber");
    expect(slotName(subscription({ parameters: { slot_name: "custom" } }))).toBe("custom");
  });

  it("notes the parameters that change what to expect", () => {
    expect(subscriptionNotes(subscription())).toEqual([]);
    expect(subscriptionNotes(subscription({ parameters: { enabled: "false", copy_data: "off" } }))).toEqual([
      "enabled = false: the subscription is defined but does not replicate",
      "copy_data = false: the rows that were already there are not copied",
    ]);
    expect(subscriptionNotes(subscription({ parameters: { connect: "false", create_slot: "false" } }))).toEqual([
      "connect = false: PostgreSQL never contacted the publisher, no slot was created",
    ]);
    expect(subscriptionNotes(subscription({ parameters: { create_slot: "false" } }))).toEqual([
      "create_slot = false: the slot on the publisher must be created by hand",
    ]);
  });

  it("says whether the logical slots of the publisher follow a failover", () => {
    expect(failoverSafety(undefined)).toBeUndefined();
    expect(failoverSafety(cluster("solo"))).toEqual({
      words: "solo has one instance: there is no failover to survive",
    });
    expect(failoverSafety(FREDDIE)?.safe).toBe(false);
    expect(failoverSafety(FREDDIE)?.words).toContain("does not synchronize its logical slots");
    const synchronized = cluster("safe", {
      instances: 3,
      replicationSlots: { highAvailability: { synchronizeLogicalDecoding: true } },
    });
    expect(failoverSafety(synchronized)).toMatchObject({ safe: true });
    const disabled = cluster("off", {
      instances: 3,
      replicationSlots: { highAvailability: { enabled: false, synchronizeLogicalDecoding: true } },
    });
    expect(failoverSafety(disabled)?.safe).toBe(false);
  });
});

describe("health", () => {
  it("reads both kinds with the shared model and their own words", () => {
    expect(publicationHealth(publication(), { cluster: FREDDIE }).state).toBe("Applied");
    const deleting = new Subscription({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Subscription",
      metadata: { name: "sub", namespace: "db", deletionTimestamp: "2026-09-19T10:00:00Z" },
      spec: { ...subscription().spec, subscriptionReclaimPolicy: "delete" },
    } as never);
    expect(subscriptionHealth(deleting, { cluster: KING }).reason).toBe(
      "Being deleted: the subscription is dropped from PostgreSQL first",
    );
  });
});
