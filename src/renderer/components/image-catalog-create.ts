/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of Create ImageCatalog and Create ClusterImageCatalog
// (SPEC-0032): the rules of the CRD of CloudNativePG v1.30 (one to eight
// images, majors of 10 or more, each once), the image references the operator
// accepts, what the form will create and the exact body of the one `create`. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import { createLine, firstError, imageReferenceError, objectNameError } from "./create-forms";

import type { CatalogKind } from "../api/cnpg/image-catalog-v1";
import type { ActionDialogFacts } from "./write-actions";

export type ReadState = "loading" | "ready" | "unavailable";

/** The bounds of `spec.images` in the CRD. */
export const CATALOG_IMAGES_MAX = 8;
export const CATALOG_MAJOR_MIN = 10;

export interface CatalogImageRow {
  major: string;
  image: string;
}

export interface CatalogForm {
  kind: CatalogKind;
  /** Empty for a ClusterImageCatalog, which is cluster scoped. */
  namespace: string;
  name: string;
  images: CatalogImageRow[];
}

export interface CatalogInputs {
  /** The catalogs of this kind already there (in the namespace for an ImageCatalog). */
  catalogs: string[];
  reads: { catalogs: ReadState };
}

export function emptyCatalogInputs(): CatalogInputs {
  return { catalogs: [], reads: { catalogs: "loading" } };
}

export function defaultCatalogForm(kind: CatalogKind, namespace: string): CatalogForm {
  return { kind, namespace: kind === "ImageCatalog" ? namespace : "", name: "", images: [{ major: "", image: "" }] };
}

export const CATALOG_FIELD_ORDER: readonly string[] = ["namespace", "name", "images"];

/** The PostgreSQL major the tag of an image starts with (`17.5-standard-trixie` gives 17), or undefined. */
export function tagMajor(image: string): number | undefined {
  const named = image.trim().split("@")[0];
  const lastSlash = named.lastIndexOf("/");
  const lastColon = named.lastIndexOf(":");
  if (lastColon <= lastSlash) return undefined;
  const match = /^([0-9]+)/.exec(named.slice(lastColon + 1));
  return match ? Number(match[1]) : undefined;
}

export function catalogErrors(inputs: CatalogInputs, form: CatalogForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.kind === "ImageCatalog" && form.namespace === "") errors.namespace = "A namespace is required";
  const nameError = objectNameError(form.name);
  if (nameError) errors.name = nameError;
  else if (inputs.reads.catalogs === "ready" && inputs.catalogs.includes(form.name)) {
    errors.name =
      form.kind === "ImageCatalog"
        ? `An image catalog named ${form.name} already exists in this namespace`
        : `A cluster image catalog named ${form.name} already exists`;
  }
  if (form.images.length === 0) errors.images = "A catalog lists one image at least";
  else if (form.images.length > CATALOG_IMAGES_MAX)
    errors.images = `A catalog lists ${CATALOG_IMAGES_MAX} images at most`;
  const majors = form.images.map((row) => row.major.trim());
  form.images.forEach((row, index) => {
    const major = row.major.trim();
    if (major === "") errors[`images.${index}.major`] = "A major is required";
    else if (!/^[0-9]+$/.test(major)) errors[`images.${index}.major`] = "A major is a whole number";
    else if (Number(major) < CATALOG_MAJOR_MIN)
      errors[`images.${index}.major`] = `A major is ${CATALOG_MAJOR_MIN} or more`;
    else if (majors.indexOf(major) !== index) errors[`images.${index}.major`] = `PostgreSQL ${major} is listed twice`;
    const imageError = imageReferenceError(row.image);
    if (imageError) errors[`images.${index}.image`] = imageError;
  });
  if (!errors.images && Object.keys(errors).some((key) => key.startsWith("images.")))
    errors.images = "An image is wrong";
  return errors;
}

/** A row whose tag says another major than the one given: the operator does not check it, the cluster would fail. */
export function catalogWarnings(form: CatalogForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  form.images.forEach((row, index) => {
    const major = Number(row.major.trim());
    const tag = tagMajor(row.image);
    if (row.major.trim() !== "" && tag !== undefined && tag !== major) {
      warnings[`images.${index}.image`] =
        `The tag reads PostgreSQL ${tag}, not ${major}: a cluster asking this catalog for ${major} would run ${tag}`;
    }
  });
  return warnings;
}

export function catalogBody(form: CatalogForm): Record<string, unknown> {
  return {
    apiVersion: CNPG_API_VERSION,
    kind: form.kind,
    metadata: { name: form.name, ...(form.kind === "ImageCatalog" ? { namespace: form.namespace } : {}) },
    spec: {
      images: form.images.map((row) => ({
        major: /^[0-9]+$/.test(row.major.trim()) ? Number(row.major.trim()) : row.major.trim(),
        image: row.image.trim(),
      })),
    },
  };
}

function kindWords(kind: CatalogKind): string {
  return kind === "ImageCatalog" ? "image catalog" : "cluster image catalog";
}

export function catalogFacts(form: CatalogForm): ActionDialogFacts {
  const majors = form.images.map((row) => row.major.trim() || "?").join(", ");
  const scope = form.kind === "ImageCatalog" ? form.namespace || "<namespace>" : "cluster scoped";
  const warnings = Object.values(catalogWarnings(form));
  return {
    subject: `${form.kind} ${form.kind === "ImageCatalog" ? `${scope}/` : ""}${form.name || "<name>"}`,
    writes: [
      {
        verb: "create",
        text:
          form.kind === "ImageCatalog"
            ? createLine("ImageCatalog", form.namespace, form.name, `PostgreSQL ${majors}`)
            : `create ClusterImageCatalog ${form.name || "<name>"}: PostgreSQL ${majors}`,
      },
    ],
    notes: [
      form.kind === "ImageCatalog"
        ? `Clusters of ${scope} can then pick their image by major from it; nothing else changes.`
        : "Clusters of every namespace can then pick their image by major from it; nothing else changes.",
      "A cluster that uses a catalog moves to the new image of its major when the catalog changes.",
    ],
    warnings,
  };
}

export function catalogBlockReason(
  inputs: CatalogInputs,
  form: CatalogForm,
  accessReason?: string,
): string | undefined {
  return firstError(CATALOG_FIELD_ORDER, catalogErrors(inputs, form)) ?? accessReason;
}

export function catalogSuccessMessage(form: CatalogForm): string {
  const where = form.kind === "ImageCatalog" ? `${form.namespace}/${form.name}` : form.name;
  return `Created the ${kindWords(form.kind)} ${where}`;
}
