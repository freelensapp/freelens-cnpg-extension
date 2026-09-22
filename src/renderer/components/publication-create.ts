/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create Publication form (SPEC-0027): what it
// publishes with the rules of the CRD, the `WITH` clause, which field is
// wrong and why, the SQL said in words, and the exact body. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import {
  collisionWarning,
  createLine,
  firstError,
  identifierError,
  keyValueObject,
  objectNameError,
} from "./create-forms";
import { clusterStateWarning, parameterRowErrors, reclaimSentence, withClause } from "./declarative-create";
import { subjectOf } from "./write-actions";

import type { KeyValue } from "./create-forms";
import type { DeclarativeClusterChoice, ReadState, ReclaimChoice } from "./declarative-create";
import type { ActionDialogFacts } from "./write-actions";

export interface ReplicationClusterChoice extends DeclarativeClusterChoice {
  /** The databases the extension knows of the cluster: the bootstrap one and the Database objects. */
  databases: string[];
}

export interface ExistingPublication {
  objectName: string;
  cluster: string;
  dbname: string;
  name: string;
}

export interface PublicationInputs {
  clusters: ReplicationClusterChoice[];
  publications: ExistingPublication[];
  reads: Record<"clusters" | "publications", ReadState>;
}

export function emptyPublicationInputs(): PublicationInputs {
  return { clusters: [], publications: [], reads: { clusters: "loading", publications: "loading" } };
}

export type PublicationTarget = "allTables" | "objects";

export interface PublicationObjectRow {
  kind: "schema" | "table";
  schema: string;
  name: string;
  only: boolean;
  /** A comma separated list, as typed. */
  columns: string;
}

export interface PublicationForm {
  namespace: string;
  name: string;
  cluster: string;
  dbname: string;
  pubName: string;
  target: PublicationTarget;
  objects: PublicationObjectRow[];
  parameters: KeyValue[];
  reclaim: ReclaimChoice;
}

export function defaultPublicationForm(namespace: string, cluster = ""): PublicationForm {
  return {
    namespace,
    name: "",
    cluster,
    dbname: "",
    pubName: "",
    target: "allTables",
    objects: [],
    parameters: [],
    reclaim: "retain",
  };
}

export function emptyObjectRow(kind: "schema" | "table" = "table"): PublicationObjectRow {
  return { kind, schema: "", name: "", only: false, columns: "" };
}

/** The keys of the `WITH` clause PostgreSQL knows on a publication. */
export const PUBLICATION_PARAMETERS: readonly string[] = [
  "publish",
  "publish_via_partition_root",
  "publish_generated_columns",
];

export function pickedPublicationCluster(
  inputs: PublicationInputs,
  form: PublicationForm,
): ReplicationClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export const PUBLICATION_FIELD_ORDER: readonly string[] = [
  "namespace",
  "cluster",
  "name",
  "dbname",
  "pubName",
  "objects",
  "parameters",
];

function columnsOf(row: PublicationObjectRow): string[] {
  return row.columns
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "");
}

export function publicationErrors(_inputs: PublicationInputs, form: PublicationForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  put("name", objectNameError(form.name));
  put("dbname", identifierError(form.dbname, "A database"));
  put("pubName", identifierError(form.pubName, "A publication name"));
  if (form.target === "objects") {
    if (form.objects.length === 0) errors.objects = "List at least one schema or table, or publish all tables";
    const schemaRows = form.objects.some((row) => row.kind === "schema");
    form.objects.forEach((row, index) => {
      if (row.kind === "schema") {
        put(`objects.${index}.name`, identifierError(row.name.trim(), "A schema"));
      } else {
        put(`objects.${index}.name`, identifierError(row.name.trim(), "A table"));
        if (row.schema.trim() !== "") put(`objects.${index}.schema`, identifierError(row.schema.trim(), "A schema"));
        const columns = columnsOf(row);
        const bad = columns.find((column) => identifierError(column, "A column"));
        if (bad) errors[`objects.${index}.columns`] = `${bad} is not a column name PostgreSQL accepts unquoted`;
        else if (columns.length > 0 && schemaRows) {
          errors[`objects.${index}.columns`] = "A column list cannot go with a schema entry in the same publication";
        }
      }
    });
    if (Object.keys(errors).some((key) => key.startsWith("objects."))) errors.objects = "An entry is wrong";
  }
  const parameters = parameterRowErrors(form.parameters, PUBLICATION_PARAMETERS);
  for (const [key, error] of Object.entries(parameters)) errors[`parameters.${key}`] = error;
  if (Object.keys(parameters).length > 0) errors.parameters = "A parameter is wrong";
  return errors;
}

export function publicationWarnings(inputs: PublicationInputs, form: PublicationForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning(
    "publication object",
    form.name,
    inputs.publications.map((publication) => publication.objectName),
  );
  if (collision) warnings.name = collision;
  const cluster = pickedPublicationCluster(inputs, form);
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !cluster) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: nothing reconciles the object until it runs`;
  }
  if (cluster && form.dbname !== "" && !cluster.databases.includes(form.dbname)) {
    warnings.dbname = `No database named ${form.dbname} is known for ${cluster.name}: the operator fails the object until it exists`;
  }
  const rival = inputs.publications.find(
    (publication) =>
      publication.cluster === form.cluster &&
      publication.dbname === form.dbname &&
      publication.name === form.pubName &&
      publication.objectName !== form.name,
  );
  if (rival && form.pubName !== "") {
    warnings.pubName = `${rival.objectName} already declares the publication ${form.pubName} in ${form.dbname} on ${form.cluster}`;
  }
  return warnings;
}

function objectEntries(form: PublicationForm): Array<Record<string, unknown>> {
  return form.objects
    .filter((row) => row.name.trim() !== "")
    .map((row) => {
      if (row.kind === "schema") return { tablesInSchema: row.name.trim() };
      const table: Record<string, unknown> = { name: row.name.trim() };
      if (row.schema.trim() !== "") table.schema = row.schema.trim();
      if (row.only) table.only = true;
      const columns = columnsOf(row);
      if (columns.length > 0) table.columns = columns;
      return { table };
    });
}

export function publicationBody(form: PublicationForm): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    cluster: { name: form.cluster },
    dbname: form.dbname,
    name: form.pubName,
    target: form.target === "allTables" ? { allTables: true } : { objects: objectEntries(form) },
  };
  const parameters = keyValueObject(form.parameters);
  if (parameters) spec.parameters = parameters;
  if (form.reclaim !== "retain") spec.publicationReclaimPolicy = form.reclaim;
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "Publication",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

function targetWords(form: PublicationForm): string {
  if (form.target === "allTables") return "FOR ALL TABLES";
  const words = form.objects
    .filter((row) => row.name.trim() !== "")
    .map((row) => {
      if (row.kind === "schema") return `TABLES IN SCHEMA ${row.name.trim()}`;
      const columns = columnsOf(row);
      return `TABLE ${row.only ? "ONLY " : ""}${row.schema.trim() ? `${row.schema.trim()}.` : ""}${row.name.trim()}${columns.length > 0 ? ` (${columns.join(", ")})` : ""}`;
    });
  return words.length > 0 ? `FOR ${words.join(", ")}` : "FOR <nothing yet>";
}

export function publicationNotes(form: PublicationForm): string[] {
  return [
    `The primary of ${form.cluster || "<cluster>"} runs CREATE PUBLICATION ${form.pubName || "<name>"} ${targetWords(form)}${withClause(form.parameters)} in the database ${form.dbname || "<database>"}.`,
    "A subscriber needs a role with REPLICATION and LOGIN on this cluster, and an entry for this cluster in its own externalClusters.",
    reclaimSentence("Publication", "publication", form.reclaim),
  ];
}

export function publicationSummaryWarnings(inputs: PublicationInputs, form: PublicationForm): string[] {
  const warnings: string[] = [];
  const state = clusterStateWarning(pickedPublicationCluster(inputs, form), form.cluster, inputs.reads.clusters);
  if (state) warnings.push(state);
  if (form.target === "objects" && form.objects.some((row) => row.kind === "table" && row.name.trim() !== "")) {
    warnings.push(
      "A table that does not exist in the database fails the object with the PostgreSQL error: the form cannot check tables.",
    );
  }
  if (form.target === "allTables")
    warnings.push("All tables, present and future, of the database are published, with every column.");
  return warnings;
}

export function publicationFacts(inputs: PublicationInputs, form: PublicationForm): ActionDialogFacts {
  return {
    subject: subjectOf("Publication", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [
      {
        verb: "create",
        text: createLine(
          "Publication",
          form.namespace,
          form.name,
          `publication ${form.pubName || "?"} in ${form.dbname || "?"} on ${form.cluster || "?"}, ${form.target === "allTables" ? "all tables" : `${form.objects.length} entr${form.objects.length === 1 ? "y" : "ies"}`}`,
        ),
      },
    ],
    notes: publicationNotes(form),
    warnings: publicationSummaryWarnings(inputs, form),
  };
}

export function publicationBlockReason(
  inputs: PublicationInputs,
  form: PublicationForm,
  accessReason?: string,
): string | undefined {
  return firstError(PUBLICATION_FIELD_ORDER, publicationErrors(inputs, form)) ?? accessReason;
}

export function publicationSuccessMessage(namespace: string, name: string): string {
  return `Requested the publication object ${namespace}/${name}: the primary of its cluster applies it now`;
}
