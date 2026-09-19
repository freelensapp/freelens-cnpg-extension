/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { classifyPooler, poolerServiceHost, poolersOfCatalog, poolersOfCluster, poolerTypeWords } from "./poolers";

import type { PoolerSpec, PoolerStatus } from "../api/cnpg/pooler-v1";

function pooler(
  name: string,
  status: PoolerStatus | undefined,
  spec: Partial<PoolerSpec> = {},
  namespace = "db",
): Pooler {
  return new Pooler({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Pooler",
    metadata: { name, namespace },
    spec: { cluster: { name: "pg" }, instances: 2, type: "rw", pgbouncer: { poolMode: "session" }, ...spec },
    status,
  } as never);
}

describe("classifyPooler", () => {
  it("is Active with every instance ready and Progressing with fewer", () => {
    expect(classifyPooler(pooler("p", { phase: "active", instances: 2 }))).toMatchObject({
      state: "Active",
      className: "success",
      reason: "2 of 2 PgBouncer instances ready",
    });
    expect(classifyPooler(pooler("p", { phase: "active", instances: 1 }))).toMatchObject({
      state: "Progressing",
      className: "info",
      reason: "1 of 2 PgBouncer instances ready",
    });
    expect(classifyPooler(pooler("p", { phase: "active" })).state).toBe("Progressing");
  });

  it("says what a paused, an inactive and a failed pooler mean", () => {
    expect(classifyPooler(pooler("p", { phase: "paused", instances: 2 }))).toMatchObject({
      state: "Paused",
      className: "warning",
      reason: "Paused: clients queue until it is resumed",
    });
    expect(classifyPooler(pooler("p", { phase: "inactive", phaseReason: "cluster not ready" })).reason).toBe(
      "cluster not ready",
    );
    expect(classifyPooler(pooler("p", { phase: "failed", error: "cannot start\nstack" }))).toMatchObject({
      state: "Failed",
      className: "error",
      reason: "cannot start",
    });
  });

  it("is Unknown without a status or with a phase it does not know", () => {
    expect(classifyPooler(pooler("p", undefined)).reason).toBe("No status reported yet");
    expect(classifyPooler(pooler("p", { phase: "levitating" })).reason).toBe('Unknown phase "levitating"');
  });
});

describe("poolerTypeWords and poolerServiceHost", () => {
  it("says what the type fronts and what an application connects to", () => {
    expect(poolerTypeWords(pooler("p", undefined))).toBe("rw (primary)");
    expect(poolerTypeWords(pooler("p", undefined, { type: "ro" }))).toBe("ro (replicas)");
    expect(poolerTypeWords(pooler("p", undefined, { type: "r" }))).toBe("r (any instance)");
    expect(poolerTypeWords(pooler("p", undefined, { type: undefined }))).toBe("rw (primary)");
    expect(poolerServiceHost(pooler("pg-pooler-rw", undefined))).toBe("pg-pooler-rw.db.svc");
  });
});

describe("poolersOfCluster and poolersOfCatalog", () => {
  const cluster = new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name: "pg", namespace: "db" },
    spec: { instances: 1 },
  } as never);

  it("finds the poolers in front of a cluster, in its namespace, by name", () => {
    const poolers = [
      pooler("pg-rw", undefined),
      pooler("pg-ro", undefined, { type: "ro" }),
      pooler("other", undefined, { cluster: { name: "other" } }),
      pooler("elsewhere", undefined, {}, "elsewhere"),
    ];
    expect(poolersOfCluster(cluster, poolers).map((item) => item.metadata.name)).toEqual(["pg-ro", "pg-rw"]);
  });

  it("finds the poolers that take their image from a catalog, with the image under their key", () => {
    const images = {
      images: [],
      componentImages: [{ key: "pgbouncer", image: "ghcr.io/cloudnative-pg/pgbouncer:1.25.1" }],
    };
    const namespaced = new ImageCatalog({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ImageCatalog",
      metadata: { name: "images", namespace: "db" },
      spec: images,
    } as never);
    const clusterWide = new ClusterImageCatalog({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ClusterImageCatalog",
      metadata: { name: "images" },
      spec: images,
    } as never);
    const ref = (kind: string, key = "pgbouncer") => ({
      pgbouncer: { imageCatalogRef: { kind, name: "images", key } },
    });
    const poolers = [
      pooler("follows", undefined, ref("ImageCatalog")),
      pooler("wrong-key", undefined, ref("ImageCatalog", "missing")),
      pooler("elsewhere", undefined, ref("ImageCatalog"), "elsewhere"),
      pooler("cluster-wide", undefined, ref("ClusterImageCatalog"), "elsewhere"),
      pooler("plain", undefined),
    ];
    expect(poolersOfCatalog(namespaced, poolers).map((item) => [item.name, item.offered])).toEqual([
      ["follows", "ghcr.io/cloudnative-pg/pgbouncer:1.25.1"],
      ["wrong-key", undefined],
    ]);
    expect(poolersOfCatalog(clusterWide, poolers).map((item) => `${item.namespace}/${item.name}`)).toEqual([
      "elsewhere/cluster-wide",
    ]);
  });
});
