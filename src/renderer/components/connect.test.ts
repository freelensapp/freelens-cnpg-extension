/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { applicationUser, clusterServiceRows, poolerServiceRow, psqlCommand, secretValue } from "./connect";

describe("the Connect section (SPEC-0031)", () => {
  it("lists rw, ro and r of a cluster, with the in-cluster host, the FQDN and what each is for", () => {
    const rows = clusterServiceRows({ name: "e2e-main", namespace: "cnpg-e2e" });
    expect(rows.map((row) => [row.service, row.host, row.purpose])).toEqual([
      ["e2e-main-rw", "e2e-main-rw.cnpg-e2e", "read and write: the primary only"],
      ["e2e-main-ro", "e2e-main-ro.cnpg-e2e", "read only: the replicas only"],
      ["e2e-main-r", "e2e-main-r.cnpg-e2e", "read: any instance, the primary included"],
    ]);
    expect(rows[0]).toMatchObject({ fqdn: "e2e-main-rw.cnpg-e2e.svc.cluster.local", port: 5432 });
  });

  it("leaves out the services spec.managed.services disables, and adds its own", () => {
    const rows = clusterServiceRows({
      name: "pg",
      namespace: "db",
      managed: {
        services: {
          disabledDefaultServices: ["ro", "r"],
          additional: [
            { selectorType: "rw", serviceTemplate: { metadata: { name: "pg-lb" } } },
            { selectorType: "nope", serviceTemplate: { metadata: { name: "pg-bad" } } },
          ],
        },
      },
    });
    expect(rows.map((row) => [row.service, row.type, row.additional])).toEqual([
      ["pg-rw", "rw", false],
      ["pg-lb", "rw", true],
    ]);
  });

  it("gives the service of a pooler, in front of the service of its type", () => {
    expect(poolerServiceRow("pg-pooler", "db", "ro")).toMatchObject({
      service: "pg-pooler",
      host: "pg-pooler.db",
      purpose: "PgBouncer in front of read only: the replicas only",
    });
  });

  it("names the application user and its Secret, app and app by default", () => {
    expect(applicationUser({ name: "e2e-main", namespace: "cnpg-e2e" })).toEqual({
      database: "app",
      user: "app",
      secret: "e2e-main-app",
    });
    expect(
      applicationUser({
        name: "pg",
        namespace: "db",
        bootstrap: { initdb: { database: "shop", owner: "shopper", secret: { name: "shop-creds" } } },
      }),
    ).toEqual({ database: "shop", user: "shopper", secret: "shop-creds" });
    expect(applicationUser({ name: "pg", namespace: "db", bootstrap: { recovery: { database: "x" } } })).toEqual({
      database: "x",
      user: "x",
      secret: "pg-app",
    });
  });

  it("decodes a key of a Secret, and builds a psql command without a password", () => {
    const uri = "postgresql://app:s3cr%C3%A8t@e2e-main-rw.cnpg-e2e:5432/app";
    const data = { uri: btoa(uri), word: btoa(String.fromCharCode(...new TextEncoder().encode("crème"))) };
    expect(secretValue(data, "uri")).toBe(uri);
    expect(secretValue(data, "word")).toBe("crème");
    expect(secretValue(data, "missing")).toBeUndefined();
    expect(psqlCommand(41234, "app", "app")).toBe('psql "host=127.0.0.1 port=41234 dbname=app user=app"');
    expect(psqlCommand(1, "my db", "o'neil")).toBe("psql \"host=127.0.0.1 port=1 dbname='my db' user='o\\'neil'\"");
  });
});
