/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  catalogBlockReason,
  catalogBody,
  catalogErrors,
  catalogFacts,
  catalogWarnings,
  defaultCatalogForm,
  tagMajor,
} from "./image-catalog-create";

import type { CatalogForm, CatalogInputs } from "./image-catalog-create";

const READY: CatalogInputs = { catalogs: ["postgresql"], reads: { catalogs: "ready" } };
const IMAGE_17 = "ghcr.io/cloudnative-pg/postgresql:17.5-standard-trixie";
const IMAGE_18 = "ghcr.io/cloudnative-pg/postgresql:18.1-system-trixie";

function form(patch: Partial<CatalogForm> = {}): CatalogForm {
  return {
    ...defaultCatalogForm("ImageCatalog", "db"),
    name: "pg",
    images: [
      { major: "17", image: IMAGE_17 },
      { major: "18", image: IMAGE_18 },
    ],
    ...patch,
  };
}

describe("Create ImageCatalog and ClusterImageCatalog (SPEC-0032)", () => {
  it("starts with one empty row, in the namespace for an ImageCatalog and none for a ClusterImageCatalog", () => {
    expect(defaultCatalogForm("ImageCatalog", "db")).toEqual({
      kind: "ImageCatalog",
      namespace: "db",
      name: "",
      images: [{ major: "", image: "" }],
    });
    expect(defaultCatalogForm("ClusterImageCatalog", "db").namespace).toBe("");
  });

  it("sends the body the CRD expects, with the majors as numbers and no namespace when cluster scoped", () => {
    expect(catalogBody(form())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ImageCatalog",
      metadata: { name: "pg", namespace: "db" },
      spec: {
        images: [
          { major: 17, image: IMAGE_17 },
          { major: 18, image: IMAGE_18 },
        ],
      },
    });
    expect(catalogBody(form({ kind: "ClusterImageCatalog", namespace: "" })).metadata).toEqual({ name: "pg" });
  });

  it("checks the rules of the CRD: one to eight images, majors of 10 or more, each once", () => {
    expect(catalogErrors(READY, form())).toEqual({});
    expect(catalogErrors(READY, form({ images: [] })).images).toBe("A catalog lists one image at least");
    const nine = Array.from({ length: 9 }, (_, index) => ({ major: String(10 + index), image: IMAGE_17 }));
    expect(catalogErrors(READY, form({ images: nine })).images).toBe("A catalog lists 8 images at most");
    const wrong = catalogErrors(
      READY,
      form({
        images: [
          { major: "9", image: IMAGE_17 },
          { major: "17", image: IMAGE_17 },
          { major: "17", image: "postgres:latest" },
          { major: "x", image: "" },
        ],
      }),
    );
    expect(wrong).toMatchObject({
      "images.0.major": "A major is 10 or more",
      "images.2.major": "PostgreSQL 17 is listed twice",
      "images.2.image": "The operator refuses the tag latest: it could not detect upgrades",
      "images.3.major": "A major is a whole number",
      "images.3.image": "An image is required",
      images: "An image is wrong",
    });
    expect(wrong["images.1.major"]).toBeUndefined();
  });

  it("refuses a name already there and a missing namespace, in the order of the form", () => {
    expect(catalogErrors(READY, form({ name: "postgresql" })).name).toBe(
      "An image catalog named postgresql already exists in this namespace",
    );
    expect(catalogErrors(READY, form({ kind: "ClusterImageCatalog", namespace: "", name: "postgresql" })).name).toBe(
      "A cluster image catalog named postgresql already exists",
    );
    expect(catalogBlockReason(READY, form({ namespace: "", name: "" }))).toBe("A namespace is required");
    expect(catalogBlockReason(READY, form(), "denied")).toBe("denied");
  });

  it("warns when the tag reads another major than the one given", () => {
    expect(tagMajor(IMAGE_17)).toBe(17);
    expect(tagMajor("localhost:5000/postgres")).toBeUndefined();
    expect(tagMajor("postgres:16@sha256:abc")).toBe(16);
    expect(catalogWarnings(form({ images: [{ major: "18", image: IMAGE_17 }] }))).toEqual({
      "images.0.image": "The tag reads PostgreSQL 17, not 18: a cluster asking this catalog for 18 would run 17",
    });
    expect(catalogFacts(form({ images: [{ major: "18", image: IMAGE_17 }] })).warnings).toHaveLength(1);
  });

  it("says what is created, and where", () => {
    expect(catalogFacts(form()).writes[0].text).toBe("create ImageCatalog db/pg: PostgreSQL 17, 18");
    const cluster = catalogFacts(form({ kind: "ClusterImageCatalog", namespace: "" }));
    expect(cluster.subject).toBe("ClusterImageCatalog pg");
    expect(cluster.writes[0].text).toBe("create ClusterImageCatalog pg: PostgreSQL 17, 18");
  });
});
