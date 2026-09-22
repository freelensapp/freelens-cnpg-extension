/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the four creation forms of SPEC-0027 share: the state of the cluster
// that will apply the object (its primary runs the SQL), the reclaim policy
// sentences, the reserved names of the CRDs, and the rows of a `WITH` clause.
// Pure.

import { duplicateKeys, identifierError, keyValueObject } from "./create-forms";

import type { KeyValue } from "./create-forms";

export type ReadState = "loading" | "ready" | "unavailable";
export type ReclaimChoice = "retain" | "delete";

/** A cluster of the namespace as the declarative forms need it. */
export interface DeclarativeClusterChoice {
  name: string;
  hibernated: boolean;
  /** True when `status.currentPrimary` is set and an instance is ready: the primary applies the object. */
  primaryRunning: boolean;
  /** A replica cluster never applies a declarative object. */
  replica: boolean;
}

/** Why a cluster is dimmed in the picker, or undefined. */
export function clusterStateReason(cluster: DeclarativeClusterChoice): string | undefined {
  if (cluster.replica) return "a replica cluster: the object would never be applied";
  if (cluster.hibernated) return "hibernated: the object waits until it is resumed";
  if (!cluster.primaryRunning) return "no running primary: the object waits";
  return undefined;
}

/** The warning of the summary for the picked cluster, or undefined. */
export function clusterStateWarning(
  cluster: DeclarativeClusterChoice | undefined,
  typed: string,
  read: ReadState,
): string | undefined {
  if (!cluster) {
    return typed !== "" && read === "ready"
      ? `No cluster named ${typed} was found in the namespace: nothing reconciles the object until such a cluster runs.`
      : undefined;
  }
  if (cluster.replica)
    return `${cluster.name} is a replica cluster: the object stays unapplied until the cluster is promoted.`;
  if (cluster.hibernated) return `${cluster.name} is hibernated: the object waits until the cluster is resumed.`;
  if (!cluster.primaryRunning) return `${cluster.name} has no running primary: the object waits until it does.`;
  return undefined;
}

export function reclaimSentence(kind: string, what: string, choice: ReclaimChoice): string {
  return choice === "delete"
    ? `Deleting the ${kind} object drops the ${what} in PostgreSQL.`
    : `Deleting the ${kind} object leaves the ${what} in PostgreSQL.`;
}

const RESERVED_DATABASES: readonly string[] = ["postgres", "template0", "template1"];
const RESERVED_ROLES: readonly string[] = ["postgres", "streaming_replica"];

/** A database name the CRD accepts, or why not. */
export function databaseNameError(name: string): string | undefined {
  const error = identifierError(name, "A database name");
  if (error) return error;
  if (RESERVED_DATABASES.includes(name)) return `The name ${name} is reserved`;
  return undefined;
}

/** A role name the CRD accepts, or why not. */
export function roleNameError(name: string): string | undefined {
  const error = identifierError(name, "A role name");
  if (error) return error;
  if (RESERVED_ROLES.includes(name)) return `The role name ${name} is reserved`;
  if (name.startsWith("pg_")) return "Role names starting with pg_ are reserved by PostgreSQL";
  if (name.startsWith("cnpg_")) return "Role names starting with cnpg_ are reserved by the operator";
  return undefined;
}

/** The errors of the rows of a `WITH` clause, by row. */
export function parameterRowErrors(rows: readonly KeyValue[], allowed?: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const duplicates = duplicateKeys(rows);
  rows.forEach((row, index) => {
    const key = row.key.trim();
    if (key === "") errors[`${index}.key`] = "A parameter needs a name";
    else if (!/^[a-z_][a-z0-9_]*$/.test(key))
      errors[`${index}.key`] = "A parameter name is lowercase letters, digits and underscores";
    else if (allowed && !allowed.includes(key))
      errors[`${index}.key`] = `${key} is not a parameter PostgreSQL knows here (${allowed.join(", ")})`;
    else if (duplicates.has(key)) errors[`${index}.key`] = `${key} is set twice`;
    else if (row.value.trim() === "") errors[`${index}.value`] = "A parameter needs a value";
  });
  return errors;
}

/** The `WITH (k = v, ...)` words of a summary, or empty. */
export function withClause(rows: readonly KeyValue[]): string {
  const object = keyValueObject(rows);
  if (!object) return "";
  return ` WITH (${Object.entries(object)
    .map(([key, value]) => `${key} = ${value}`)
    .join(", ")})`;
}
