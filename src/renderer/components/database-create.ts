/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create Database form (SPEC-0027): the roles the
// picked cluster knows as owners, the objects inside the database, which
// field is wrong and why, the SQL the operator will run said in words, and
// the exact body of the one `create`. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import {
  collisionWarning,
  createLine,
  firstError,
  identifierError,
  integerError,
  objectNameError,
} from "./create-forms";
import { clusterStateReason, clusterStateWarning, databaseNameError, reclaimSentence } from "./declarative-create";
import { subjectOf } from "./write-actions";

import type { DeclarativeClusterChoice, ReadState, ReclaimChoice } from "./declarative-create";
import type { ActionDialogFacts } from "./write-actions";

export interface DatabaseClusterChoice extends DeclarativeClusterChoice {
  /** The roles the extension knows of the cluster: the bootstrap owner, `managed.roles`, the DatabaseRole objects, `postgres`. */
  owners: string[];
  tablespaces: string[];
}

export interface ExistingDatabase {
  objectName: string;
  cluster: string;
  name: string;
}

export interface DatabaseInputs {
  clusters: DatabaseClusterChoice[];
  databases: ExistingDatabase[];
  reads: Record<"clusters" | "databases", ReadState>;
}

export function emptyDatabaseInputs(): DatabaseInputs {
  return { clusters: [], databases: [], reads: { clusters: "loading", databases: "loading" } };
}

export interface ExtensionRow {
  name: string;
  version: string;
  schema: string;
}

export interface SchemaRow {
  name: string;
  owner: string;
}

export type LocaleProvider = "" | "libc" | "icu" | "builtin";

export interface DatabaseForm {
  namespace: string;
  name: string;
  cluster: string;
  dbName: string;
  owner: string;
  reclaim: ReclaimChoice;
  extensions: ExtensionRow[];
  schemas: SchemaRow[];
  template: string;
  encoding: string;
  localeProvider: LocaleProvider;
  locale: string;
  tablespace: string;
  connectionLimit: string;
  allowConnections: "" | "true" | "false";
  isTemplate: boolean;
}

export function defaultDatabaseForm(namespace: string, cluster = ""): DatabaseForm {
  return {
    namespace,
    name: "",
    cluster,
    dbName: "",
    owner: "",
    reclaim: "retain",
    extensions: [],
    schemas: [],
    template: "",
    encoding: "",
    localeProvider: "",
    locale: "",
    tablespace: "",
    connectionLimit: "",
    allowConnections: "",
    isTemplate: false,
  };
}

export function pickedDatabaseCluster(inputs: DatabaseInputs, form: DatabaseForm): DatabaseClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export const DATABASE_FIELD_ORDER: readonly string[] = [
  "namespace",
  "cluster",
  "name",
  "dbName",
  "owner",
  "extensions",
  "schemas",
  "template",
  "locale",
  "tablespace",
  "connectionLimit",
];

const EXTENSION_NAME = /^[a-z0-9_][a-z0-9_-]*$/;

export function databaseErrors(_inputs: DatabaseInputs, form: DatabaseForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  put("name", objectNameError(form.name));
  put("dbName", databaseNameError(form.dbName));
  put("owner", identifierError(form.owner, "An owner"));
  const seenExtensions = new Set<string>();
  form.extensions.forEach((row, index) => {
    const name = row.name.trim();
    if (name === "") errors[`extensions.${index}.name`] = "An extension needs a name";
    else if (!EXTENSION_NAME.test(name))
      errors[`extensions.${index}.name`] = "An extension name is lowercase letters, digits, underscores and dashes";
    else if (seenExtensions.has(name)) errors[`extensions.${index}.name`] = `${name} is listed twice`;
    seenExtensions.add(name);
    if (row.schema.trim() !== "") put(`extensions.${index}.schema`, identifierError(row.schema.trim(), "A schema"));
  });
  if (Object.keys(errors).some((key) => key.startsWith("extensions."))) errors.extensions = "An extension is wrong";
  const seenSchemas = new Set<string>();
  form.schemas.forEach((row, index) => {
    const name = row.name.trim();
    const error = identifierError(name, "A schema name");
    if (error) errors[`schemas.${index}.name`] = error;
    else if (seenSchemas.has(name)) errors[`schemas.${index}.name`] = `${name} is listed twice`;
    seenSchemas.add(name);
    if (row.owner.trim() !== "") put(`schemas.${index}.owner`, identifierError(row.owner.trim(), "An owner"));
  });
  if (Object.keys(errors).some((key) => key.startsWith("schemas."))) errors.schemas = "A schema is wrong";
  if (form.template.trim() !== "") put("template", identifierError(form.template.trim(), "A template"));
  if (form.localeProvider !== "" && form.localeProvider !== "libc" && form.locale.trim() === "") {
    errors.locale = `A locale is required with the ${form.localeProvider} provider`;
  }
  if (form.tablespace.trim() !== "") put("tablespace", identifierError(form.tablespace.trim(), "A tablespace"));
  if (
    form.connectionLimit.trim() !== "" &&
    form.connectionLimit.trim() !== "-1" &&
    integerError(form.connectionLimit, "x", 0)
  ) {
    errors.connectionLimit = "The connection limit is a whole number, -1 for no limit";
  }
  return errors;
}

export function databaseWarnings(inputs: DatabaseInputs, form: DatabaseForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning(
    "database object",
    form.name,
    inputs.databases.map((database) => database.objectName),
  );
  if (collision) warnings.name = collision;
  const cluster = pickedDatabaseCluster(inputs, form);
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !cluster) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: nothing reconciles the object until it runs`;
  }
  if (cluster && form.owner !== "" && !cluster.owners.includes(form.owner)) {
    warnings.owner = `No role named ${form.owner} is known for ${cluster.name}: the operator fails the object until the role exists`;
  }
  if (cluster && form.tablespace.trim() !== "" && !cluster.tablespaces.includes(form.tablespace.trim())) {
    warnings.tablespace = `${cluster.name} declares no tablespace named ${form.tablespace.trim()}`;
  }
  const rival = inputs.databases.find(
    (database) =>
      database.cluster === form.cluster && database.name === form.dbName && database.objectName !== form.name,
  );
  if (rival && form.dbName !== "") {
    warnings.dbName = `${rival.objectName} already declares the database ${form.dbName} on ${form.cluster}: the operator refuses a second object for it`;
  }
  return warnings;
}

export function databaseBody(form: DatabaseForm): Record<string, unknown> {
  const spec: Record<string, unknown> = { cluster: { name: form.cluster }, name: form.dbName, owner: form.owner };
  if (form.reclaim !== "retain") spec.databaseReclaimPolicy = form.reclaim;
  if (form.template.trim() !== "") spec.template = form.template.trim();
  if (form.encoding.trim() !== "") spec.encoding = form.encoding.trim();
  if (form.localeProvider !== "") spec.localeProvider = form.localeProvider;
  if (form.locale.trim() !== "") {
    const key =
      form.localeProvider === "icu" ? "icuLocale" : form.localeProvider === "builtin" ? "builtinLocale" : "locale";
    spec[key] = form.locale.trim();
  }
  if (form.tablespace.trim() !== "") spec.tablespace = form.tablespace.trim();
  if (form.connectionLimit.trim() !== "") spec.connectionLimit = Number(form.connectionLimit);
  if (form.allowConnections !== "") spec.allowConnections = form.allowConnections === "true";
  if (form.isTemplate) spec.isTemplate = true;
  const extensions = form.extensions
    .filter((row) => row.name.trim() !== "")
    .map((row) => ({
      name: row.name.trim(),
      ...(row.version.trim() ? { version: row.version.trim() } : {}),
      ...(row.schema.trim() ? { schema: row.schema.trim() } : {}),
    }));
  if (extensions.length > 0) spec.extensions = extensions;
  const schemas = form.schemas
    .filter((row) => row.name.trim() !== "")
    .map((row) => ({ name: row.name.trim(), ...(row.owner.trim() ? { owner: row.owner.trim() } : {}) }));
  if (schemas.length > 0) spec.schemas = schemas;
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "Database",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

function createDatabaseWords(form: DatabaseForm): string {
  const parts = [`CREATE DATABASE ${form.dbName || "<name>"} OWNER ${form.owner || "<owner>"}`];
  if (form.template.trim()) parts.push(`TEMPLATE ${form.template.trim()}`);
  if (form.encoding.trim()) parts.push(`ENCODING ${form.encoding.trim()}`);
  if (form.localeProvider) parts.push(`LOCALE_PROVIDER ${form.localeProvider}`);
  if (form.locale.trim()) parts.push(`LOCALE ${form.locale.trim()}`);
  if (form.tablespace.trim()) parts.push(`TABLESPACE ${form.tablespace.trim()}`);
  if (form.connectionLimit.trim()) parts.push(`CONNECTION LIMIT ${form.connectionLimit.trim()}`);
  if (form.allowConnections) parts.push(`ALLOW_CONNECTIONS ${form.allowConnections}`);
  if (form.isTemplate) parts.push("IS_TEMPLATE true");
  return parts.join(" ");
}

export function databaseNotes(_inputs: DatabaseInputs, form: DatabaseForm): string[] {
  const notes = [`The primary of ${form.cluster || "<cluster>"} runs ${createDatabaseWords(form)}.`];
  for (const row of form.extensions) {
    if (row.name.trim() === "") continue;
    notes.push(
      `Then CREATE EXTENSION ${row.name.trim()}${row.version.trim() ? ` VERSION ${row.version.trim()}` : ""}${row.schema.trim() ? ` SCHEMA ${row.schema.trim()}` : ""} in it.`,
    );
  }
  for (const row of form.schemas) {
    if (row.name.trim() === "") continue;
    notes.push(
      `Then CREATE SCHEMA ${row.name.trim()}${row.owner.trim() ? ` AUTHORIZATION ${row.owner.trim()}` : ""} in it.`,
    );
  }
  if (form.template.trim() || form.encoding.trim() || form.localeProvider || form.locale.trim()) {
    notes.push("The template, the encoding and the locale are read at creation and cannot change later.");
  }
  notes.push(reclaimSentence("Database", "database", form.reclaim));
  return notes;
}

export function databaseSummaryWarnings(inputs: DatabaseInputs, form: DatabaseForm): string[] {
  const warnings: string[] = [];
  const state = clusterStateWarning(pickedDatabaseCluster(inputs, form), form.cluster, inputs.reads.clusters);
  if (state) warnings.push(state);
  if (form.reclaim === "delete")
    warnings.push("With the delete policy the database and everything in it go when the object is deleted.");
  return warnings;
}

export function databaseFacts(inputs: DatabaseInputs, form: DatabaseForm): ActionDialogFacts {
  return {
    subject: subjectOf("Database", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [
      {
        verb: "create",
        text: createLine(
          "Database",
          form.namespace,
          form.name,
          `database ${form.dbName || "?"} owned by ${form.owner || "?"} on ${form.cluster || "?"}`,
        ),
      },
    ],
    notes: databaseNotes(inputs, form),
    warnings: databaseSummaryWarnings(inputs, form),
  };
}

export function databaseBlockReason(
  inputs: DatabaseInputs,
  form: DatabaseForm,
  accessReason?: string,
): string | undefined {
  return firstError(DATABASE_FIELD_ORDER, databaseErrors(inputs, form)) ?? accessReason;
}

export function databaseClusterReason(cluster: DeclarativeClusterChoice): string | undefined {
  return clusterStateReason(cluster);
}

export function databaseSuccessMessage(namespace: string, name: string): string {
  return `Requested the database object ${namespace}/${name}: the primary of its cluster applies it now`;
}
