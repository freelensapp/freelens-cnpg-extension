/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Types written from the `databaseroles.postgresql.cnpg.io` CRD schema of
// CloudNativePG v1.30.0 (SPEC-0014): a PostgreSQL role declared for a cluster.
// The extension knows the name of the password Secret and nothing of its
// content.

import { Renderer } from "@freelensapp/extensions";
import { CNPG_API_VERSION } from "./cluster-v1";

import type { CnpgKubeObjectCRD, KubeCondition } from "../types";
import type { LocalObjectReference } from "./cluster-v1";
import type { DeclarativeStatus, ReclaimPolicy } from "./database-v1";

/** The role attributes, the same shape the inline `managed.roles` of a cluster uses. */
export interface RoleConfiguration {
  name: string;
  comment?: string;
  login?: boolean;
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  replication?: boolean;
  bypassrls?: boolean;
  /** PostgreSQL default: true. */
  inherit?: boolean;
  /** PostgreSQL default: -1, no limit. */
  connectionLimit?: number;
  inRoles?: string[];
  passwordSecret?: LocalObjectReference;
  disablePassword?: boolean;
  validUntil?: string;
}

export interface DatabaseRoleSpec extends RoleConfiguration {
  cluster: LocalObjectReference;
  databaseRoleReclaimPolicy?: ReclaimPolicy;
  /** Present and not disabled: the operator issues a TLS client certificate for the role. */
  clientCertificate?: { enabled?: boolean };
}

export interface DatabaseRoleStatus extends DeclarativeStatus {
  conditions?: KubeCondition[];
  clientCertificate?: { expiration?: string; message?: string };
  secretResourceVersion?: string;
}

/** The Secret the operator writes the client certificate of a role to. */
export function clientCertificateSecretName(roleObjectName: string): string {
  return `${roleObjectName}-client-cert`;
}

export class DatabaseRole extends Renderer.K8sApi.LensExtensionKubeObject<
  Renderer.K8sApi.KubeObjectMetadata,
  DatabaseRoleStatus,
  DatabaseRoleSpec
> {
  static readonly kind = "DatabaseRole";
  static readonly namespaced = true;
  static readonly apiBase = `/apis/${CNPG_API_VERSION}/databaseroles`;

  static readonly crd: CnpgKubeObjectCRD = {
    apiVersions: [CNPG_API_VERSION],
    plural: "databaseroles",
    singular: "databaserole",
    shortNames: [],
    title: "Database Roles",
  };

  static getClusterName(object: DatabaseRole): string | undefined {
    return object.spec?.cluster?.name || undefined;
  }
}

export class DatabaseRoleApi extends Renderer.K8sApi.KubeApi<DatabaseRole> {}
export class DatabaseRoleStore extends Renderer.K8sApi.KubeObjectStore<DatabaseRole, DatabaseRoleApi> {}
