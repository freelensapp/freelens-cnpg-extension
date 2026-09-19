/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `imagecatalogs.postgresql.cnpg.io` and
// `clusterimagecatalogs.postgresql.cnpg.io` CRD schemas of CloudNativePG
// v1.30.0 (SPEC-0010). The two kinds have the same spec and no status; the
// second one is cluster scoped.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";

export interface CatalogExtension {
  name?: string;
  image?: { reference?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CatalogImage {
  major: number;
  image: string;
  extensions?: CatalogExtension[];
}

export interface CatalogComponentImage {
  key: string;
  image: string;
}

export interface ImageCatalogSpec {
  images?: CatalogImage[];
  componentImages?: CatalogComponentImage[];
}

export type CatalogKind = "ImageCatalog" | "ClusterImageCatalog";

export class ImageCatalog extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  Record<string, never>,
  ImageCatalogSpec
> {
  static readonly kind = "ImageCatalog";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/imagecatalogs`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "imagecatalogs",
    singular: "imagecatalog",
    shortNames: [],
    title: "Image Catalogs",
  };
}

export class ImageCatalogApi extends Renderer.K8sApi.KubeApi<ImageCatalog> {}
export class ImageCatalogStore extends Renderer.K8sApi.KubeObjectStore<ImageCatalog, ImageCatalogApi> {}

export class ClusterImageCatalog extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  Record<string, never>,
  ImageCatalogSpec
> {
  static readonly kind = "ClusterImageCatalog";
  static readonly namespaced = false;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/clusterimagecatalogs`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "clusterimagecatalogs",
    singular: "clusterimagecatalog",
    shortNames: [],
    title: "Cluster Image Catalogs",
  };
}

export class ClusterImageCatalogApi extends Renderer.K8sApi.KubeApi<ClusterImageCatalog> {}
export class ClusterImageCatalogStore extends Renderer.K8sApi.KubeObjectStore<
  ClusterImageCatalog,
  ClusterImageCatalogApi
> {}

/** Either kind: the views treat them alike. */
export type AnyImageCatalog = ImageCatalog | ClusterImageCatalog;
