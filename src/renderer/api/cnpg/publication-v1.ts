/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `publications.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0015): the publishing end of a logical
// replication, declared for a database of a cluster.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { LocalObjectReference } from "./cluster-v1";
import type { DeclarativeStatus, ReclaimPolicy } from "./database-v1";

export interface PublicationTable {
  name: string;
  schema?: string;
  /** Only the table itself, not the tables that inherit from it. */
  only?: boolean;
  columns?: string[];
}

/** Either one table or every table of a schema. */
export interface PublicationObject {
  table?: PublicationTable;
  tablesInSchema?: string;
}

export interface PublicationSpec {
  cluster: LocalObjectReference;
  dbname: string;
  /** The name inside PostgreSQL. */
  name: string;
  target: { allTables?: boolean; objects?: PublicationObject[] };
  /** The `WITH` clause of `CREATE PUBLICATION`. */
  parameters?: Record<string, string>;
  publicationReclaimPolicy?: ReclaimPolicy;
}

export class Publication extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  DeclarativeStatus,
  PublicationSpec
> {
  static readonly kind = "Publication";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/publications`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "publications",
    singular: "publication",
    shortNames: [],
    title: "Publications",
  };

  static getClusterName(object: Publication): string | undefined {
    return object.spec?.cluster?.name || undefined;
  }
}

export class PublicationApi extends Renderer.K8sApi.KubeApi<Publication> {}
export class PublicationStore extends Renderer.K8sApi.KubeObjectStore<Publication, PublicationApi> {}
