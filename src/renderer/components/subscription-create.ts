/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create Subscription form (SPEC-0027): the external
// cluster the subscriber must declare, the publication it follows, the
// `WITH` clause, which field is wrong and why, the SQL said in words, and
// the exact body. Pure.

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

export interface ExternalClusterChoice {
  name: string;
  host?: string;
  dbname?: string;
  user?: string;
  /** True when the entry carries `connectionParameters`: the only entries a subscription can use. */
  connectable: boolean;
  hasPassword: boolean;
}

export interface SubscriberClusterChoice extends DeclarativeClusterChoice {
  databases: string[];
  externalClusters: ExternalClusterChoice[];
}

export interface ExistingSubscription {
  objectName: string;
  cluster: string;
  dbname: string;
  name: string;
}

/** A publication the extension knows, with the cluster it lives on, to offer for an external entry that points at that cluster. */
export interface KnownPublication {
  cluster: string;
  namespace: string;
  dbname: string;
  name: string;
}

export interface SubscriptionInputs {
  clusters: SubscriberClusterChoice[];
  subscriptions: ExistingSubscription[];
  publications: KnownPublication[];
  reads: Record<"clusters" | "subscriptions" | "publications", ReadState>;
}

export function emptySubscriptionInputs(): SubscriptionInputs {
  return {
    clusters: [],
    subscriptions: [],
    publications: [],
    reads: { clusters: "loading", subscriptions: "loading", publications: "loading" },
  };
}

export interface SubscriptionForm {
  namespace: string;
  name: string;
  cluster: string;
  dbname: string;
  subName: string;
  externalCluster: string;
  publicationName: string;
  publicationDBName: string;
  parameters: KeyValue[];
  reclaim: ReclaimChoice;
}

export function defaultSubscriptionForm(namespace: string, cluster = ""): SubscriptionForm {
  return {
    namespace,
    name: "",
    cluster,
    dbname: "",
    subName: "",
    externalCluster: "",
    publicationName: "",
    publicationDBName: "",
    parameters: [],
    reclaim: "retain",
  };
}

/** The keys of the `WITH` clause PostgreSQL knows on a subscription. */
export const SUBSCRIPTION_PARAMETERS: readonly string[] = [
  "connect",
  "create_slot",
  "enabled",
  "slot_name",
  "binary",
  "copy_data",
  "streaming",
  "synchronous_commit",
  "two_phase",
  "disable_on_error",
  "password_required",
  "run_as_owner",
  "origin",
  "failover",
];

export function pickedSubscriberCluster(
  inputs: SubscriptionInputs,
  form: SubscriptionForm,
): SubscriberClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export function pickedExternalCluster(
  inputs: SubscriptionInputs,
  form: SubscriptionForm,
): ExternalClusterChoice | undefined {
  return pickedSubscriberCluster(inputs, form)?.externalClusters.find((entry) => entry.name === form.externalCluster);
}

/** The publications known on the cluster an external entry points at (its host is `<cluster>-rw` of a cluster the extension knows). */
export function publicationsBehind(
  inputs: SubscriptionInputs,
  entry: ExternalClusterChoice | undefined,
): KnownPublication[] {
  if (!entry?.host) return [];
  const [service, namespace] = entry.host.split(".");
  if (!service.endsWith("-rw")) return [];
  const cluster = service.slice(0, -3);
  return inputs.publications.filter(
    (publication) =>
      publication.cluster === cluster && (namespace === undefined || publication.namespace === namespace),
  );
}

export const NO_EXTERNAL_CLUSTER_REASON =
  "The cluster declares no external cluster with connection parameters: add one to its YAML (a host, a user, a database and a password secret) before subscribing";

export const SUBSCRIPTION_FIELD_ORDER: readonly string[] = [
  "namespace",
  "cluster",
  "name",
  "dbname",
  "subName",
  "externalCluster",
  "publicationName",
  "publicationDBName",
  "parameters",
];

export function subscriptionErrors(inputs: SubscriptionInputs, form: SubscriptionForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  put("name", objectNameError(form.name));
  put("dbname", identifierError(form.dbname, "A database"));
  put("subName", identifierError(form.subName, "A subscription name"));
  const cluster = pickedSubscriberCluster(inputs, form);
  if (cluster) {
    const connectable = cluster.externalClusters.filter((entry) => entry.connectable);
    if (connectable.length === 0) errors.externalCluster = NO_EXTERNAL_CLUSTER_REASON;
    else if (form.externalCluster === "") errors.externalCluster = "Pick the external cluster to subscribe to";
    else if (!connectable.some((entry) => entry.name === form.externalCluster)) {
      errors.externalCluster = `${form.externalCluster} is not an external cluster with connection parameters of ${cluster.name}`;
    }
  } else if (form.externalCluster === "") {
    errors.externalCluster = "Name the external cluster to subscribe to";
  }
  put("publicationName", identifierError(form.publicationName, "A publication name"));
  if (form.publicationDBName.trim() !== "")
    put("publicationDBName", identifierError(form.publicationDBName.trim(), "A database"));
  const parameters = parameterRowErrors(form.parameters, SUBSCRIPTION_PARAMETERS);
  for (const [key, error] of Object.entries(parameters)) errors[`parameters.${key}`] = error;
  if (Object.keys(parameters).length > 0) errors.parameters = "A parameter is wrong";
  return errors;
}

export function subscriptionWarnings(inputs: SubscriptionInputs, form: SubscriptionForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning(
    "subscription object",
    form.name,
    inputs.subscriptions.map((subscription) => subscription.objectName),
  );
  if (collision) warnings.name = collision;
  const cluster = pickedSubscriberCluster(inputs, form);
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !cluster) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: nothing reconciles the object until it runs`;
  }
  if (cluster && form.dbname !== "" && !cluster.databases.includes(form.dbname)) {
    warnings.dbname = `No database named ${form.dbname} is known for ${cluster.name}: the operator fails the object until it exists`;
  }
  const entry = pickedExternalCluster(inputs, form);
  if (entry && !entry.hasPassword)
    warnings.externalCluster = `The entry ${entry.name} names no password secret: the connection may be refused`;
  if (entry && form.publicationName !== "") {
    const behind = publicationsBehind(inputs, entry);
    if (behind.length > 0 && !behind.some((publication) => publication.name === form.publicationName)) {
      warnings.publicationName = `No publication named ${form.publicationName} is known on the cluster behind ${entry.name}`;
    }
  }
  const rival = inputs.subscriptions.find(
    (subscription) =>
      subscription.cluster === form.cluster &&
      subscription.dbname === form.dbname &&
      subscription.name === form.subName &&
      subscription.objectName !== form.name,
  );
  if (rival && form.subName !== "") {
    warnings.subName = `${rival.objectName} already declares the subscription ${form.subName} in ${form.dbname} on ${form.cluster}`;
  }
  return warnings;
}

export function subscriptionBody(form: SubscriptionForm): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    cluster: { name: form.cluster },
    dbname: form.dbname,
    name: form.subName,
    externalClusterName: form.externalCluster,
    publicationName: form.publicationName,
  };
  if (form.publicationDBName.trim() !== "") spec.publicationDBName = form.publicationDBName.trim();
  const parameters = keyValueObject(form.parameters);
  if (parameters) spec.parameters = parameters;
  if (form.reclaim !== "retain") spec.subscriptionReclaimPolicy = form.reclaim;
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "Subscription",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

export function subscriptionNotes(inputs: SubscriptionInputs, form: SubscriptionForm): string[] {
  const entry = pickedExternalCluster(inputs, form);
  const where = entry?.host
    ? `${entry.host}${entry.dbname || form.publicationDBName ? `, database ${form.publicationDBName.trim() || entry.dbname}` : ""}`
    : form.externalCluster || "<external cluster>";
  const copyOff = form.parameters.some(
    (row) => row.key.trim() === "copy_data" && ["false", "off", "0"].includes(row.value.trim().toLowerCase()),
  );
  return [
    `The primary of ${form.cluster || "<cluster>"} runs CREATE SUBSCRIPTION ${form.subName || "<name>"} CONNECTION '<${where}>' PUBLICATION ${form.publicationName || "<publication>"}${withClause(form.parameters)} in the database ${form.dbname || "<database>"}.`,
    "The tables the publication publishes must already exist in the subscriber's database, with the same columns.",
    copyOff
      ? "No initial copy: only the changes from now on arrive."
      : "The initial copy of the published tables runs first, then the changes stream.",
    reclaimSentence("Subscription", "subscription", form.reclaim),
  ];
}

export function subscriptionSummaryWarnings(inputs: SubscriptionInputs, form: SubscriptionForm): string[] {
  const warnings: string[] = [];
  const state = clusterStateWarning(pickedSubscriberCluster(inputs, form), form.cluster, inputs.reads.clusters);
  if (state) warnings.push(state);
  const entry = pickedExternalCluster(inputs, form);
  if (entry && publicationsBehind(inputs, entry).length === 0) {
    warnings.push(
      "The publication cannot be checked from here: a wrong name fails the object with the PostgreSQL error.",
    );
  }
  if (form.reclaim === "delete")
    warnings.push(
      "With the delete policy the subscription is dropped when the object is deleted, and its slot on the publisher with it.",
    );
  return warnings;
}

export function subscriptionFacts(inputs: SubscriptionInputs, form: SubscriptionForm): ActionDialogFacts {
  return {
    subject: subjectOf("Subscription", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [
      {
        verb: "create",
        text: createLine(
          "Subscription",
          form.namespace,
          form.name,
          `subscription ${form.subName || "?"} in ${form.dbname || "?"} on ${form.cluster || "?"}, from ${form.externalCluster || "?"} publication ${form.publicationName || "?"}`,
        ),
      },
    ],
    notes: subscriptionNotes(inputs, form),
    warnings: subscriptionSummaryWarnings(inputs, form),
  };
}

export function subscriptionBlockReason(
  inputs: SubscriptionInputs,
  form: SubscriptionForm,
  accessReason?: string,
): string | undefined {
  return firstError(SUBSCRIPTION_FIELD_ORDER, subscriptionErrors(inputs, form)) ?? accessReason;
}

export function subscriptionSuccessMessage(namespace: string, name: string): string {
  return `Requested the subscription object ${namespace}/${name}: the primary of its cluster applies it now`;
}
