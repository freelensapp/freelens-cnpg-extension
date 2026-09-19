/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import { catalogMajors, classifyCatalog, clustersOfCatalog, imageShort, imageTag } from "./image-catalogs";

import type { CatalogImage } from "../api/cnpg/image-catalog-v1";

const PG18 = "ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie";
const PG17 = "ghcr.io/cloudnative-pg/postgresql:17.6-system-trixie";

const images: CatalogImage[] = [
  { major: 17, image: PG17 },
  { major: 18, image: PG18, extensions: [{ name: "pgvector" }, { name: "postgis" }, {}] },
];

function namespaced(name = "images", namespace = "db", entries = images): ImageCatalog {
  return new ImageCatalog({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ImageCatalog",
    metadata: { name, namespace },
    spec: { images: entries },
  } as never);
}

function clusterWide(name = "images"): ClusterImageCatalog {
  return new ClusterImageCatalog({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ClusterImageCatalog",
    metadata: { name },
    spec: { images },
  } as never);
}

function cluster(
  name: string,
  ref: { kind?: string; name: string; major: number } | undefined,
  running?: string,
  namespace = "db",
) {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace },
    spec: {
      instances: 1,
      imageCatalogRef: ref ? { apiGroup: "postgresql.cnpg.io", kind: "ImageCatalog", ...ref } : undefined,
    },
    status: { image: running },
  } as never);
}

describe("imageTag and catalogMajors", () => {
  it("reads the tag, shortens a digest and defaults to latest", () => {
    expect(imageTag(PG18)).toBe("18.4-system-trixie");
    expect(imageTag("registry:5000/pg/postgresql:17")).toBe("17");
    expect(imageTag("registry:5000/pg/postgresql")).toBe("latest");
    expect(imageTag("ghcr.io/x/pg@sha256:0123456789abcdef0123456789abcdef")).toBe("sha256:0123456789ab");
    expect(imageShort(PG18)).toBe("postgresql:18.4-system-trixie");
    expect(imageShort("postgres:17")).toBe("postgres:17");
  });

  it("lists the majors, the highest first, with their extension names", () => {
    expect(catalogMajors(namespaced())).toEqual([
      { major: 18, image: PG18, tag: "18.4-system-trixie", extensions: ["pgvector", "postgis"] },
      { major: 17, image: PG17, tag: "17.6-system-trixie", extensions: [] },
    ]);
    expect(catalogMajors(namespaced("empty", "db", []))).toEqual([]);
  });
});

describe("clustersOfCatalog", () => {
  const clusters = [
    cluster("aligned", { name: "images", major: 18 }, PG18),
    cluster("rolling", { name: "images", major: 17 }, "ghcr.io/cloudnative-pg/postgresql:17.5-system-trixie"),
    cluster("blocked", { name: "images", major: 16 }, undefined),
    cluster("other-catalog", { name: "somewhere-else", major: 18 }, PG18),
    cluster("other-namespace", { name: "images", major: 18 }, PG18, "elsewhere"),
    cluster("cluster-wide", { kind: "ClusterImageCatalog", name: "images", major: 18 }, PG18, "elsewhere"),
    cluster("no-ref", undefined, PG18),
  ];

  it("finds the followers of a namespaced catalog in its own namespace, what blocks first", () => {
    expect(
      clustersOfCatalog(namespaced(), clusters).map((follower) => [follower.name, follower.state, follower.major]),
    ).toEqual([
      ["blocked", "Missing major", 16],
      ["rolling", "Rolling out", 17],
      ["aligned", "Aligned", 18],
    ]);
  });

  it("finds the followers of a cluster scoped catalog in every namespace, by kind", () => {
    expect(
      clustersOfCatalog(clusterWide(), clusters).map((follower) => `${follower.namespace}/${follower.name}`),
    ).toEqual(["elsewhere/cluster-wide"]);
  });

  it("tells what the catalog offers and what the cluster runs", () => {
    const [rolling] = clustersOfCatalog(namespaced(), [clusters[1]]);
    expect(rolling).toMatchObject({ offered: PG17, running: "ghcr.io/cloudnative-pg/postgresql:17.5-system-trixie" });
  });
});

describe("classifyCatalog", () => {
  it("is Missing major when a follower asks for what the catalog does not offer", () => {
    expect(classifyCatalog(namespaced(), [cluster("pg", { name: "images", major: 16 })])).toMatchObject({
      state: "Missing major",
      className: "error",
      reason: "pg asks for PostgreSQL 16, which the catalog does not offer",
    });
  });

  it("is In use, saying who still has to move", () => {
    const moving = [
      cluster("a", { name: "images", major: 18 }, PG18),
      cluster("b", { name: "images", major: 17 }, "old"),
    ];
    expect(classifyCatalog(namespaced(), moving).reason).toBe("2 clusters, 1 not yet on the image of the catalog");
    expect(classifyCatalog(namespaced(), [moving[0]])).toMatchObject({
      state: "In use",
      className: "success",
      reason: "1 cluster, all on the image of the catalog",
    });
  });

  it("is Unused without a follower", () => {
    expect(classifyCatalog(clusterWide(), [])).toMatchObject({ state: "Unused", className: "info" });
  });
});
