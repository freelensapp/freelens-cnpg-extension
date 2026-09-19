/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `databases.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0013): a PostgreSQL database declared for a
// cluster, with the extensions, schemas, foreign data wrappers and foreign
// servers the operator manages inside it. The status shape
// (`applied`, `message`, `observedGeneration`) is shared by the four
// declarative kinds of M4.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD } from "../types";
import type { LocalObjectReference } from "./cluster-v1";

export type EnsureOption = "present" | "absent";
export type ReclaimPolicy = "retain" | "delete";

/** What the instance manager of the primary writes after it tried to apply a declarative object. */
export interface DeclarativeStatus {
  /** `true` applied, `false` failed with the reason in `message`, unset when nobody could try. */
  applied?: boolean;
  message?: string;
  observedGeneration?: number;
}

export interface ManagedObjectStatus {
  name: string;
  applied: boolean;
  message?: string;
}

export interface DatabaseObjectSpec {
  name: string;
  ensure?: EnsureOption;
}

export interface ExtensionSpec extends DatabaseObjectSpec {
  version?: string;
  schema?: string;
}

export interface SchemaSpec extends DatabaseObjectSpec {
  owner?: string;
}

export interface OptionSpec {
  name: string;
  value: string;
  ensure?: EnsureOption;
}

export interface UsageSpec {
  name: string;
  type?: "grant" | "revoke";
}

export interface FdwSpec extends DatabaseObjectSpec {
  handler?: string;
  validator?: string;
  owner?: string;
  options?: OptionSpec[];
  usage?: UsageSpec[];
}

export interface ServerSpec extends DatabaseObjectSpec {
  fdw: string;
  options?: OptionSpec[];
  usage?: UsageSpec[];
}

export interface DatabaseSpec {
  cluster: LocalObjectReference;
  /** The name inside PostgreSQL; it cannot change. */
  name: string;
  owner: string;
  ensure?: EnsureOption;
  databaseReclaimPolicy?: ReclaimPolicy;
  allowConnections?: boolean;
  connectionLimit?: number;
  isTemplate?: boolean;
  tablespace?: string;
  // Creation parameters: PostgreSQL cannot change them afterwards.
  template?: string;
  encoding?: string;
  locale?: string;
  localeProvider?: string;
  localeCollate?: string;
  localeCType?: string;
  icuLocale?: string;
  icuRules?: string;
  builtinLocale?: string;
  collationVersion?: string;
  extensions?: ExtensionSpec[];
  schemas?: SchemaSpec[];
  fdws?: FdwSpec[];
  servers?: ServerSpec[];
}

export interface DatabaseStatus extends DeclarativeStatus {
  extensions?: ManagedObjectStatus[];
  schemas?: ManagedObjectStatus[];
  fdws?: ManagedObjectStatus[];
  servers?: ManagedObjectStatus[];
}

export class Database extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  DatabaseStatus,
  DatabaseSpec
> {
  static readonly kind = "Database";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/databases`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "databases",
    singular: "database",
    shortNames: [],
    title: "Databases",
  };

  static getClusterName(object: Database): string | undefined {
    return object.spec?.cluster?.name || undefined;
  }
}

export class DatabaseApi extends Renderer.K8sApi.KubeApi<Database> {}
export class DatabaseStore extends Renderer.K8sApi.KubeObjectStore<Database, DatabaseApi> {}
