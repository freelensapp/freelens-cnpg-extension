/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  defaultPublicationForm,
  emptyObjectRow,
  publicationBlockReason,
  publicationBody,
  publicationErrors,
  publicationFacts,
  publicationWarnings,
} from "./publication-create";

import type { PublicationForm, PublicationInputs } from "./publication-create";

const READY: PublicationInputs = {
  clusters: [
    { name: "pg", hibernated: false, primaryRunning: true, replica: false, databases: ["app", "orders"] },
    { name: "mirror", hibernated: false, primaryRunning: true, replica: true, databases: [] },
  ],
  publications: [{ objectName: "pg-numbers", cluster: "pg", dbname: "app", name: "numbers_pub" }],
  reads: { clusters: "ready", publications: "ready" },
};

function filled(overrides: Partial<PublicationForm> = {}): PublicationForm {
  return {
    ...defaultPublicationForm("db", "pg"),
    name: "pg-orders-pub",
    dbname: "app",
    pubName: "orders_pub",
    ...overrides,
  };
}

describe("the errors and warnings", () => {
  it("want the names and, for objects, at least one entry with the rules of the CRD", () => {
    expect(publicationBlockReason(READY, defaultPublicationForm("db"))).toBe("Pick a cluster");
    expect(publicationBlockReason(READY, filled({ pubName: "1pub" }))).toMatch(/digit/);
    expect(publicationBlockReason(READY, filled({ target: "objects" }))).toBe(
      "List at least one schema or table, or publish all tables",
    );
    const errors = publicationErrors(
      READY,
      filled({
        target: "objects",
        objects: [
          { ...emptyObjectRow("schema"), name: "sales" },
          { ...emptyObjectRow("table"), name: "orders", columns: "id, total" },
          { ...emptyObjectRow("table"), name: "", schema: "Bad" },
          { ...emptyObjectRow("table"), name: "t", columns: "id, 1bad" },
        ],
        parameters: [
          { key: "publish", value: "insert" },
          { key: "nope", value: "1" },
        ],
      }),
    );
    expect(errors["objects.1.columns"]).toMatch(/column list cannot go with a schema entry/);
    expect(errors["objects.2.name"]).toBe("A table is required");
    expect(errors["objects.2.schema"]).toMatch(/lowercase/);
    expect(errors["objects.3.columns"]).toMatch(/1bad is not a column name/);
    expect(errors.objects).toBe("An entry is wrong");
    expect(errors["parameters.1.key"]).toMatch(/not a parameter PostgreSQL knows here/);
    expect(errors.parameters).toBe("A parameter is wrong");
    expect(publicationBlockReason(READY, filled())).toBeUndefined();
    expect(
      publicationBlockReason(
        READY,
        filled({ target: "objects", objects: [{ ...emptyObjectRow("table"), name: "orders", columns: "id" }] }),
      ),
    ).toBeUndefined();
  });

  it("warn on collisions, unknown databases and a rival object", () => {
    expect(publicationWarnings(READY, filled({ name: "pg-numbers" })).name).toMatch(/already exists/);
    expect(publicationWarnings(READY, filled({ dbname: "ghost" })).dbname).toMatch(
      /No database named ghost is known for pg/,
    );
    expect(publicationWarnings(READY, filled({ pubName: "numbers_pub" })).pubName).toMatch(
      /pg-numbers already declares the publication numbers_pub/,
    );
    expect(publicationWarnings(READY, filled({ cluster: "ghost" })).cluster).toMatch(/No cluster named ghost/);
    expect(publicationWarnings(READY, filled())).toEqual({});
  });
});

describe("the body and the facts", () => {
  it("sends all tables or the entries, with the WITH clause and the policy when set", () => {
    expect(publicationBody(filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Publication",
      metadata: { name: "pg-orders-pub", namespace: "db" },
      spec: { cluster: { name: "pg" }, dbname: "app", name: "orders_pub", target: { allTables: true } },
    });
    const body = publicationBody(
      filled({
        target: "objects",
        objects: [
          { ...emptyObjectRow("schema"), name: "sales" },
          { ...emptyObjectRow("table"), name: "orders", schema: "public", only: true },
          { ...emptyObjectRow("table"), name: "" },
        ],
        parameters: [{ key: "publish", value: "insert,update" }],
        reclaim: "delete",
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      cluster: { name: "pg" },
      dbname: "app",
      name: "orders_pub",
      target: { objects: [{ tablesInSchema: "sales" }, { table: { name: "orders", schema: "public", only: true } }] },
      parameters: { publish: "insert,update" },
      publicationReclaimPolicy: "delete",
    });
    const columns = publicationBody(
      filled({ target: "objects", objects: [{ ...emptyObjectRow("table"), name: "t", columns: "a, b" }] }),
    ) as {
      spec: { target: { objects: Array<{ table: { columns: string[] } }> } };
    };
    expect(columns.spec.target.objects[0].table.columns).toEqual(["a", "b"]);
  });

  it("says the SQL in words and what it costs", () => {
    const facts = publicationFacts(READY, filled({ parameters: [{ key: "publish", value: "insert" }] }));
    expect(facts.subject).toBe("Publication db/pg-orders-pub");
    expect(facts.writes[0].text).toBe(
      "create Publication db/pg-orders-pub: publication orders_pub in app on pg, all tables",
    );
    expect(facts.notes[0]).toBe(
      "The primary of pg runs CREATE PUBLICATION orders_pub FOR ALL TABLES WITH (publish = insert) in the database app.",
    );
    expect(facts.notes[1]).toMatch(/REPLICATION and LOGIN/);
    expect(facts.warnings).toEqual([
      "All tables, present and future, of the database are published, with every column.",
    ]);
    const objects = publicationFacts(
      READY,
      filled({
        target: "objects",
        objects: [{ ...emptyObjectRow("table"), name: "orders", schema: "sales", only: true, columns: "id,total" }],
      }),
    );
    expect(objects.notes[0]).toMatch(/FOR TABLE ONLY sales.orders \(id, total\)/);
    expect(objects.warnings[0]).toMatch(/cannot check tables/);
    expect(publicationFacts(READY, filled({ cluster: "mirror" })).warnings[0]).toMatch(/replica cluster/);
  });
});
