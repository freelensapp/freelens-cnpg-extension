/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the declarative objects of M4 (SPEC-0013): Database,
// DatabaseRole, Publication and Subscription share one status shape, written
// by the instance manager of the primary, and so one reading of it. The
// closed set of states below is what the lists show; the sentences say why,
// and what nobody could tell from `applied: false` alone.

import { Cluster } from "../api/cnpg/cluster-v1";

import type {
  Database,
  DatabaseObjectSpec,
  DeclarativeStatus,
  ManagedObjectStatus,
  ReclaimPolicy,
} from "../api/cnpg/database-v1";
import type { HostStatusClass } from "./cluster-health";

export type DeclarativeState =
  | "Applied"
  | "Absent"
  | "Updating"
  | "Failed"
  | "Waiting"
  | "Pending"
  | "Orphan"
  | "Deleting";

export interface DeclarativeHealth {
  state: DeclarativeState;
  label: DeclarativeState;
  className: HostStatusClass;
  reason: string;
}

const PRESENTATION: Record<DeclarativeState, HostStatusClass> = {
  Applied: "success",
  Absent: "info",
  Updating: "info",
  Failed: "error",
  Waiting: "info",
  Pending: "info",
  Orphan: "warning",
  Deleting: "warning",
};

export function declarativeHealth(state: DeclarativeState, reason: string): DeclarativeHealth {
  return { state, label: state, className: PRESENTATION[state], reason };
}

/** What the four kinds have in common, as far as this model reads them. */
export interface DeclarativeObject {
  metadata?: { name?: string; namespace?: string; generation?: number; deletionTimestamp?: string };
  spec?: { cluster?: { name?: string }; name?: string; dbname?: string };
  status?: DeclarativeStatus;
}

export interface DeclarativeWords {
  /** What the object declares, as the sentences name it: "database", "role", "publication", "subscription". */
  what: string;
  reclaimPolicy?: ReclaimPolicy;
}

export interface ClusterLookup {
  /** The cluster the object names, when it is there. */
  cluster?: Cluster;
  /** False while the Cluster store is still loading: a missing cluster means nothing yet. */
  known?: boolean;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0].trim();
}

/** The cluster an object names: same namespace, `spec.cluster.name`. */
export function clusterOf(object: DeclarativeObject, clusters: readonly Cluster[]): Cluster | undefined {
  const name = object.spec?.cluster?.name;
  if (!name) return undefined;
  return clusters.find(
    (cluster) => cluster.metadata?.name === name && cluster.metadata?.namespace === object.metadata?.namespace,
  );
}

/** The objects of the same kind that belong to a cluster, by name. */
export function objectsOfCluster<T extends DeclarativeObject>(cluster: Cluster, objects: readonly T[]): T[] {
  return objects
    .filter(
      (object) =>
        object.spec?.cluster?.name === cluster.metadata?.name &&
        object.metadata?.namespace === cluster.metadata?.namespace,
    )
    .sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
}

const ALREADY_MANAGED = /is already managed by (?:\w+ )?object "([^"]+)"/i;

/** The operator's failure message, with the conflict it words tersely told in full. */
export function failureWords(message: string | undefined, words: DeclarativeWords): string {
  const line = firstLine(message);
  if (!line) return `The ${words.what} could not be applied; the operator gave no reason`;
  const rival = ALREADY_MANAGED.exec(line)?.[1];
  if (rival) return `Ignored: the object "${rival}" already manages the same ${words.what}`;
  return line;
}

/** What deleting the Kubernetes object does to the thing in PostgreSQL. */
export function reclaimWords(policy: ReclaimPolicy | undefined, what: string): string {
  return policy === "delete"
    ? `delete: deleting this object drops the ${what} from PostgreSQL`
    : `retain: deleting this object leaves the ${what} in PostgreSQL`;
}

/** The generation that was declared and the one PostgreSQL has, for the drawer. */
export function generationWords(object: DeclarativeObject): string {
  const declared = object.metadata?.generation;
  const applied = object.status?.observedGeneration;
  if (declared === undefined) return "N/A";
  if (!applied) return `${declared} declared, none applied yet`;
  return applied >= declared ? `${declared}, applied` : `${declared} declared, ${applied} applied`;
}

function waitingForPrimary(cluster: Cluster): string | undefined {
  if (Cluster.getHibernation(cluster)) return "Waiting for a running primary: the cluster is hibernated";
  if (cluster.spec?.replica?.enabled) {
    return "Waiting for the cluster to become primary: a replica cluster is read-only";
  }
  if (!Cluster.getPrimary(cluster) || Cluster.getReadyInstances(cluster) === 0) {
    return "Waiting for a running primary: its instance manager is what applies this object";
  }
  return undefined;
}

export function classifyDeclarative(
  object: DeclarativeObject,
  { cluster, known = true }: ClusterLookup,
  words: DeclarativeWords,
): DeclarativeHealth {
  const status = object.status;
  const message = firstLine(status?.message);

  if (object.metadata?.deletionTimestamp) {
    const fate =
      words.reclaimPolicy === "delete"
        ? `the ${words.what} is dropped from PostgreSQL first`
        : `the ${words.what} stays in PostgreSQL`;
    return declarativeHealth(
      "Deleting",
      message ? `Being deleted, ${fate}. Last answer: ${message}` : `Being deleted: ${fate}`,
    );
  }

  if (status?.applied === false) return declarativeHealth("Failed", failureWords(status.message, words));

  if (status?.applied === true) {
    const declared = object.metadata?.generation ?? 0;
    const observed = status.observedGeneration ?? 0;
    return observed < declared
      ? declarativeHealth("Updating", `A change waits to be applied (generation ${declared}, applied ${observed})`)
      : declarativeHealth("Applied", "Applied to PostgreSQL");
  }

  // Nobody said anything about `applied`: either the operator is waiting on
  // purpose (it leaves a message), or no instance manager could try.
  if (message) {
    return declarativeHealth(
      "Waiting",
      /become primary/i.test(message)
        ? "Waiting for the cluster to become primary: a replica cluster is read-only"
        : message,
    );
  }
  if (!cluster) {
    if (!known) return declarativeHealth("Pending", "Not applied yet");
    const name = object.spec?.cluster?.name;
    return declarativeHealth(
      "Orphan",
      name ? `The Cluster ${name} is not there: nothing applies this object` : "It names no Cluster",
    );
  }
  const waiting = waitingForPrimary(cluster);
  if (waiting) return declarativeHealth(waiting.includes("replica") ? "Waiting" : "Pending", waiting);
  return declarativeHealth("Pending", "Not applied yet");
}

/** The other objects that target the same thing in PostgreSQL: same namespace, cluster, database and name. */
export function conflictingObjects<T extends DeclarativeObject>(object: T, all: readonly T[]): T[] {
  return all.filter(
    (other) =>
      other !== object &&
      other.metadata?.name !== object.metadata?.name &&
      other.metadata?.namespace === object.metadata?.namespace &&
      other.spec?.cluster?.name === object.spec?.cluster?.name &&
      (other.spec?.dbname ?? "") === (object.spec?.dbname ?? "") &&
      other.spec?.name === object.spec?.name,
  );
}

export interface DeclarativeCounts {
  total: number;
  applied: number;
  failed: number;
  /** Everything that is neither applied nor failed: updating, waiting, pending, orphan, deleting. */
  waiting: number;
}

export function countHealth(healths: readonly DeclarativeHealth[]): DeclarativeCounts {
  const counts: DeclarativeCounts = { total: healths.length, applied: 0, failed: 0, waiting: 0 };
  for (const health of healths) {
    if (health.state === "Applied" || health.state === "Absent") counts.applied += 1;
    else if (health.state === "Failed") counts.failed += 1;
    else counts.waiting += 1;
  }
  return counts;
}

/** "3 applied, 1 failed": only the buckets that have something. */
export function countWords(counts: DeclarativeCounts): string {
  const parts: string[] = [];
  if (counts.applied) parts.push(`${counts.applied} applied`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  return parts.join(", ") || "none";
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type ManagedObjectKind = "Extension" | "Schema" | "FDW" | "Server";

export interface ManagedObjectRow {
  kind: ManagedObjectKind;
  name: string;
  /** What the declaration adds to the name: version and schema, owner, handler, the wrapper of a server. */
  detail: string;
  ensure: "present" | "absent";
  /** Undefined while the operator has not reported on it. */
  applied?: boolean;
  message?: string;
}

function joinStatus<S extends DatabaseObjectSpec>(
  kind: ManagedObjectKind,
  specs: readonly S[] | undefined,
  statuses: readonly ManagedObjectStatus[] | undefined,
  detail: (spec: S) => string,
): ManagedObjectRow[] {
  return (specs ?? []).map((spec) => {
    const status = statuses?.find((entry) => entry.name === spec.name);
    return {
      kind,
      name: spec.name,
      detail: detail(spec),
      ensure: spec.ensure ?? "present",
      applied: status?.applied,
      message: firstLine(status?.message) || undefined,
    };
  });
}

function words(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(", ");
}

/** Every object the database declares inside itself, joined with what the operator reported on it. */
export function managedObjects(database: Database): ManagedObjectRow[] {
  const spec = database.spec;
  const status = database.status;
  return [
    ...joinStatus("Extension", spec?.extensions, status?.extensions, (item) =>
      words(item.version ? `version ${item.version}` : "default version", item.schema && `in schema ${item.schema}`),
    ),
    ...joinStatus("Schema", spec?.schemas, status?.schemas, (item) => words(item.owner && `owner ${item.owner}`)),
    ...joinStatus("FDW", spec?.fdws, status?.fdws, (item) =>
      words(item.handler && `handler ${item.handler}`, item.owner && `owner ${item.owner}`),
    ),
    ...joinStatus("Server", spec?.servers, status?.servers, (item) => words(item.fdw && `wrapper ${item.fdw}`)),
  ];
}

export function databaseHealth(database: Database, lookup: ClusterLookup): DeclarativeHealth {
  const base = classifyDeclarative(database, lookup, {
    what: "database",
    reclaimPolicy: database.spec?.databaseReclaimPolicy,
  });

  if (base.state === "Applied" && database.spec?.ensure === "absent") {
    return declarativeHealth("Absent", "Absent as declared: the database is not in PostgreSQL");
  }
  if (base.state === "Failed") {
    // A managed object that fails makes the whole database fail with a generic
    // message; the reason is in the entry of that object.
    const failed = managedObjects(database).filter((row) => row.applied === false);
    if (failed.length > 0) {
      const [first] = failed;
      const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
      return declarativeHealth(
        "Failed",
        `${first.kind} "${first.name}" failed${first.message ? `: ${first.message}` : ""}${more}`,
      );
    }
  }
  return base;
}

/** "-1" is PostgreSQL for no limit. */
export function connectionLimitWords(limit: number | undefined): string {
  return limit === undefined || limit < 0 ? "Unlimited" : String(limit);
}

/** The creation parameters that are set, in the order `CREATE DATABASE` lists them. */
export function creationParameters(database: Database): { name: string; value: string }[] {
  const spec = database.spec;
  const rows: [string, string | undefined][] = [
    ["Template", spec?.template],
    ["Encoding", spec?.encoding],
    ["Locale provider", spec?.localeProvider],
    ["Locale", spec?.locale],
    ["Collation (LC_COLLATE)", spec?.localeCollate],
    ["Character type (LC_CTYPE)", spec?.localeCType],
    ["ICU locale", spec?.icuLocale],
    ["ICU rules", spec?.icuRules],
    ["Builtin locale", spec?.builtinLocale],
    ["Collation version", spec?.collationVersion],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1])).map(([name, value]) => ({ name, value }));
}
