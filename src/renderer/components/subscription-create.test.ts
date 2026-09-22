/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  defaultSubscriptionForm,
  NO_EXTERNAL_CLUSTER_REASON,
  publicationsBehind,
  subscriptionBlockReason,
  subscriptionBody,
  subscriptionErrors,
  subscriptionFacts,
  subscriptionWarnings,
} from "./subscription-create";

import type { SubscriptionForm, SubscriptionInputs } from "./subscription-create";

const READY: SubscriptionInputs = {
  clusters: [
    {
      name: "sub",
      hibernated: false,
      primaryRunning: true,
      replica: false,
      databases: ["app"],
      externalClusters: [
        { name: "pub", host: "pub-rw.db.svc", dbname: "app", user: "app", connectable: true, hasPassword: true },
        { name: "nopass", host: "other-rw.db.svc", connectable: true, hasPassword: false },
        { name: "store-only", connectable: false, hasPassword: false },
      ],
    },
    {
      name: "lonely",
      hibernated: false,
      primaryRunning: true,
      replica: false,
      databases: ["app"],
      externalClusters: [],
    },
  ],
  subscriptions: [{ objectName: "sub-numbers", cluster: "sub", dbname: "app", name: "numbers_sub" }],
  publications: [
    { cluster: "pub", namespace: "db", dbname: "app", name: "numbers_pub" },
    { cluster: "pub", namespace: "db", dbname: "app", name: "all_pub" },
  ],
  reads: { clusters: "ready", subscriptions: "ready", publications: "ready" },
};

function filled(overrides: Partial<SubscriptionForm> = {}): SubscriptionForm {
  return {
    ...defaultSubscriptionForm("db", "sub"),
    name: "sub-all",
    dbname: "app",
    subName: "all_sub",
    externalCluster: "pub",
    publicationName: "all_pub",
    ...overrides,
  };
}

describe("the errors and warnings", () => {
  it("want an external cluster with connection parameters, and the names", () => {
    expect(subscriptionBlockReason(READY, defaultSubscriptionForm("db"))).toBe("Pick a cluster");
    expect(subscriptionBlockReason(READY, filled({ cluster: "lonely", externalCluster: "" }))).toBe(
      NO_EXTERNAL_CLUSTER_REASON,
    );
    expect(subscriptionErrors(READY, filled({ externalCluster: "" })).externalCluster).toBe(
      "Pick the external cluster to subscribe to",
    );
    expect(subscriptionErrors(READY, filled({ externalCluster: "store-only" })).externalCluster).toMatch(
      /not an external cluster with connection parameters/,
    );
    expect(subscriptionErrors(READY, filled({ cluster: "ghost", externalCluster: "" })).externalCluster).toBe(
      "Name the external cluster to subscribe to",
    );
    expect(subscriptionErrors(READY, filled({ subName: "1sub" })).subName).toMatch(/digit/);
    expect(subscriptionErrors(READY, filled({ publicationDBName: "Bad" })).publicationDBName).toMatch(/lowercase/);
    expect(subscriptionErrors(READY, filled({ parameters: [{ key: "nope", value: "1" }] })).parameters).toBe(
      "A parameter is wrong",
    );
    expect(subscriptionBlockReason(READY, filled())).toBeUndefined();
  });

  it("warn on the password, the publication behind the entry, and rivals", () => {
    expect(subscriptionWarnings(READY, filled({ externalCluster: "nopass" })).externalCluster).toMatch(
      /names no password secret/,
    );
    expect(subscriptionWarnings(READY, filled({ publicationName: "ghost_pub" })).publicationName).toMatch(
      /No publication named ghost_pub is known on the cluster behind pub/,
    );
    expect(
      subscriptionWarnings(READY, filled({ externalCluster: "nopass", publicationName: "ghost_pub" })).publicationName,
    ).toBeUndefined();
    expect(subscriptionWarnings(READY, filled({ subName: "numbers_sub" })).subName).toMatch(
      /sub-numbers already declares/,
    );
    expect(subscriptionWarnings(READY, filled({ name: "sub-numbers" })).name).toMatch(/already exists/);
    expect(subscriptionWarnings(READY, filled({ dbname: "ghost" })).dbname).toMatch(/No database named ghost/);
    expect(subscriptionWarnings(READY, filled())).toEqual({});
    expect(
      publicationsBehind(READY, READY.clusters[0].externalClusters[0]).map((publication) => publication.name),
    ).toEqual(["numbers_pub", "all_pub"]);
    expect(publicationsBehind(READY, READY.clusters[0].externalClusters[2])).toEqual([]);
  });
});

describe("the body and the facts", () => {
  it("sends the five required fields, and the rest when set", () => {
    expect(subscriptionBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Subscription",
      metadata: { name: "sub-all", namespace: "db" },
      spec: {
        cluster: { name: "sub" },
        dbname: "app",
        name: "all_sub",
        externalClusterName: "pub",
        publicationName: "all_pub",
      },
    });
    const body = subscriptionBody(
      filled({ publicationDBName: "other", parameters: [{ key: "copy_data", value: "false" }], reclaim: "delete" }),
    ) as {
      spec: Record<string, unknown>;
    };
    expect(body.spec.publicationDBName).toBe("other");
    expect(body.spec.parameters).toEqual({ copy_data: "false" });
    expect(body.spec.subscriptionReclaimPolicy).toBe("delete");
  });

  it("says the SQL in words and what it costs", () => {
    const facts = subscriptionFacts(READY, filled());
    expect(facts.subject).toBe("Subscription db/sub-all");
    expect(facts.writes[0].text).toBe(
      "create Subscription db/sub-all: subscription all_sub in app on sub, from pub publication all_pub",
    );
    expect(facts.notes[0]).toBe(
      "The primary of sub runs CREATE SUBSCRIPTION all_sub CONNECTION '<pub-rw.db.svc, database app>' PUBLICATION all_pub in the database app.",
    );
    expect(facts.notes[2]).toMatch(/initial copy/);
    expect(facts.warnings).toEqual([]);
    const off = subscriptionFacts(
      READY,
      filled({ externalCluster: "nopass", parameters: [{ key: "copy_data", value: "false" }], reclaim: "delete" }),
    );
    expect(off.notes[2]).toBe("No initial copy: only the changes from now on arrive.");
    expect(off.warnings[0]).toMatch(/cannot be checked from here/);
    expect(off.warnings[1]).toMatch(/slot on the publisher/);
  });
});
