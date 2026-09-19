/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the logical replication objects (SPEC-0015): a Publication and
// a Subscription are the two ends of one flow, usually in two clusters. This
// module reads what a publication publishes, finds the publisher a
// subscription points to through the external cluster entry of its own
// cluster, pairs the two objects, names the replication slot, and says
// whether the pair survives a failover of the publisher.

import { classifyDeclarative } from "./declarative";

import type { Cluster, ExternalCluster } from "../api/cnpg/cluster-v1";
import type { Publication } from "../api/cnpg/publication-v1";
import type { Subscription } from "../api/cnpg/subscription-v1";
import type { ClusterLookup, DeclarativeHealth } from "./declarative";

export function publicationHealth(publication: Publication, lookup: ClusterLookup): DeclarativeHealth {
  return classifyDeclarative(publication, lookup, {
    what: "publication",
    reclaimPolicy: publication.spec?.publicationReclaimPolicy,
  });
}

export function subscriptionHealth(subscription: Subscription, lookup: ClusterLookup): DeclarativeHealth {
  return classifyDeclarative(subscription, lookup, {
    what: "subscription",
    reclaimPolicy: subscription.spec?.subscriptionReclaimPolicy,
  });
}

// ---------------------------------------------------------------------------
// What a publication publishes
// ---------------------------------------------------------------------------

export interface PublishedObject {
  kind: "Table" | "Schema";
  /** `schema.table`, or the schema whose tables are all published. */
  name: string;
  detail: string;
}

export interface PublicationTargetView {
  allTables: boolean;
  words: string;
  objects: PublishedObject[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function publicationTarget(publication: Publication): PublicationTargetView {
  const target = publication.spec?.target;
  if (target?.allTables) {
    return { allTables: true, words: "All tables", objects: [] };
  }
  const objects: PublishedObject[] = [];
  for (const object of target?.objects ?? []) {
    if (object.table?.name) {
      const { table } = object;
      const details: string[] = [];
      if (table.columns?.length) details.push(`columns ${table.columns.join(", ")}`);
      else details.push("all columns");
      if (table.only) details.push("the table only, not the ones that inherit from it");
      objects.push({
        kind: "Table",
        name: table.schema ? `${table.schema}.${table.name}` : table.name,
        detail: details.join("; "),
      });
    } else if (object.tablesInSchema) {
      objects.push({ kind: "Schema", name: object.tablesInSchema, detail: "every table, the future ones included" });
    }
  }
  const tables = objects.filter((object) => object.kind === "Table").length;
  const schemas = objects.length - tables;
  const parts: string[] = [];
  if (tables) parts.push(plural(tables, "table", "tables"));
  if (schemas) parts.push(plural(schemas, "schema", "schemas"));
  return { allTables: false, words: parts.join(", ") || "Nothing", objects };
}

// ---------------------------------------------------------------------------
// The publisher of a subscription
// ---------------------------------------------------------------------------

export type PublisherOutcome = "resolved" | "external" | "undefined";

export interface PublisherView {
  outcome: PublisherOutcome;
  /** The name the subscription gives to the publisher: an entry of `externalClusters`. */
  externalClusterName: string;
  host?: string;
  user?: string;
  /** The database that holds the publication. */
  database?: string;
  /** The cluster of this Kubernetes cluster the host is a service of. */
  cluster?: Cluster;
  /** Which service of that cluster the entry points to. */
  service?: "rw" | "ro" | "r";
  words: string;
}

const SERVICE_HOST = /^(?<cluster>[a-z0-9]([-a-z0-9]*[a-z0-9])?)-(?<service>rw|ro|r)$/;

/** The cluster and namespace a service host names: `<cluster>-rw[.<namespace>[.svc[.<domain>]]]`. */
export function parseServiceHost(
  host: string | undefined,
  defaultNamespace: string,
): { cluster: string; namespace: string; service: "rw" | "ro" | "r" } | undefined {
  const labels = (host ?? "").trim().toLowerCase().replace(/\.$/, "").split(".");
  if (!labels[0]) return undefined;
  if (labels.length > 2 && labels[2] !== "svc") return undefined;
  const match = SERVICE_HOST.exec(labels[0]);
  if (!match?.groups) return undefined;
  return {
    cluster: match.groups.cluster,
    namespace: labels[1] || defaultNamespace,
    service: match.groups.service as "rw" | "ro" | "r",
  };
}

export function externalClusterOf(
  subscription: Subscription,
  subscriber: Cluster | undefined,
): ExternalCluster | undefined {
  const name = subscription.spec?.externalClusterName;
  return subscriber?.spec?.externalClusters?.find((entry) => entry.name === name);
}

export function resolvePublisher(
  subscription: Subscription,
  subscriber: Cluster | undefined,
  clusters: readonly Cluster[],
): PublisherView {
  const externalClusterName = subscription.spec?.externalClusterName ?? "";
  const entry = externalClusterOf(subscription, subscriber);
  if (!entry) {
    return {
      outcome: "undefined",
      externalClusterName,
      words: subscriber
        ? `The cluster ${subscriber.metadata?.name} declares no external cluster named ${externalClusterName}`
        : `The external cluster ${externalClusterName} is an entry of the subscriber cluster, which is not there`,
    };
  }
  const parameters = entry.connectionParameters ?? {};
  const host = parameters.host;
  const database = subscription.spec?.publicationDBName || parameters.dbname || undefined;
  const base = { externalClusterName, host, user: parameters.user, database };
  const named = parseServiceHost(host, subscription.metadata?.namespace ?? "");
  const cluster = named
    ? clusters.find(
        (candidate) => candidate.metadata?.name === named.cluster && candidate.metadata?.namespace === named.namespace,
      )
    : undefined;
  if (!cluster || !named) {
    return {
      ...base,
      outcome: "external",
      words: host
        ? `${host}: not a cluster of this Kubernetes cluster, or not one you can see`
        : "The external cluster entry has no host",
    };
  }
  return {
    ...base,
    outcome: "resolved",
    cluster,
    service: named.service,
    words: `${cluster.metadata?.name} through its ${named.service} service`,
  };
}

/** The Publication objects a subscription consumes: on the resolved publisher, same database and PostgreSQL name. */
export function publicationsOfSubscription(
  subscription: Subscription,
  publisher: PublisherView,
  publications: readonly Publication[],
): Publication[] {
  if (publisher.outcome !== "resolved" || !publisher.cluster) return [];
  return publications.filter(
    (publication) =>
      publication.metadata?.namespace === publisher.cluster?.metadata?.namespace &&
      publication.spec?.cluster?.name === publisher.cluster?.metadata?.name &&
      publication.spec?.name === subscription.spec?.publicationName &&
      (!publisher.database || publication.spec?.dbname === publisher.database),
  );
}

/** The Subscription objects of this Kubernetes cluster that consume a publication. */
export function subscriptionsOfPublication(
  publication: Publication,
  subscriptions: readonly Subscription[],
  clusters: readonly Cluster[],
): Subscription[] {
  return subscriptions
    .filter((subscription) => {
      const subscriber = clusters.find(
        (cluster) =>
          cluster.metadata?.name === subscription.spec?.cluster?.name &&
          cluster.metadata?.namespace === subscription.metadata?.namespace,
      );
      const publisher = resolvePublisher(subscription, subscriber, clusters);
      return publicationsOfSubscription(subscription, publisher, [publication]).length > 0;
    })
    .sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
}

// ---------------------------------------------------------------------------
// The slot, the parameters that change what to expect, the failover
// ---------------------------------------------------------------------------

/** PostgreSQL names the slot after the subscription unless `slot_name` says otherwise. */
export function slotName(subscription: Subscription): string {
  return subscription.spec?.parameters?.slot_name?.trim() || subscription.spec?.name || "";
}

function isOff(value: string | undefined): boolean {
  return ["false", "off", "no", "0"].includes((value ?? "").trim().toLowerCase());
}

/** The `WITH` parameters that change what a reader should expect from the subscription. */
export function subscriptionNotes(subscription: Subscription): string[] {
  const parameters = subscription.spec?.parameters ?? {};
  const notes: string[] = [];
  if (isOff(parameters.enabled)) notes.push("enabled = false: the subscription is defined but does not replicate");
  if (isOff(parameters.connect)) {
    notes.push("connect = false: PostgreSQL never contacted the publisher, no slot was created");
  } else if (isOff(parameters.create_slot)) {
    notes.push("create_slot = false: the slot on the publisher must be created by hand");
  }
  if (isOff(parameters.copy_data)) notes.push("copy_data = false: the rows that were already there are not copied");
  return notes;
}

export interface FailoverSafety {
  /** Undefined when there is nothing to say: a publisher with one instance never fails over. */
  safe?: boolean;
  words: string;
}

/** Whether the logical slots of the publisher follow a failover (upstream "Resilience to Failovers"). */
export function failoverSafety(publisher: Cluster | undefined): FailoverSafety | undefined {
  if (!publisher) return undefined;
  const name = publisher.metadata?.name ?? "the publisher";
  if ((publisher.spec?.instances ?? 1) < 2) {
    return { words: `${name} has one instance: there is no failover to survive` };
  }
  const slots = publisher.spec?.replicationSlots as
    | { highAvailability?: { enabled?: boolean; synchronizeLogicalDecoding?: boolean } }
    | undefined;
  const synchronized =
    slots?.highAvailability?.enabled !== false && slots?.highAvailability?.synchronizeLogicalDecoding === true;
  return synchronized
    ? {
        safe: true,
        words: `${name} synchronizes its logical slots to the standbys: the subscription survives a failover`,
      }
    : {
        safe: false,
        words: `${name} does not synchronize its logical slots to the standbys (replicationSlots.highAvailability.synchronizeLogicalDecoding): after a failover the subscription stops until its slot is there again`,
      };
}

/** What logical replication never carries, whatever the objects say. */
export const LOGICAL_REPLICATION_LIMITS =
  "Logical replication carries row changes only: not the schema, not sequence values, not large objects";
