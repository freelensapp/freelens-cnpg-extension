/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The diagnostic report of a cluster (SPEC-0038), after `kubectl cnpg report
// cluster` of v1.30.1: which objects belong to the cluster, how each is
// cleaned (no managedFields, no last-applied annotation) and redacted (no
// Secret is ever read; a value under a key named like a password, a token or a
// key is replaced), and the layout of the archive with its README. Pure: the
// collection is `menus/cluster-report-menu-item.tsx`, the archive main's.

import { toYaml } from "./create-forms";

import type { ReportFile } from "../../common/ipc";

export interface ReportObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string | undefined>;
    annotations?: Record<string, string | undefined>;
    managedFields?: unknown;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  data?: Record<string, unknown>;
  involvedObject?: { kind?: string; name?: string };
  [key: string]: unknown;
}

export const CLUSTER_LABEL = "cnpg.io/cluster";

/** The kinds of the report, their folder, and how an object of the kind is tied to the cluster. */
export const REPORT_KINDS = [
  { folder: "pods", kind: "Pod", by: "label" },
  { folder: "jobs", kind: "Job", by: "label" },
  { folder: "pvcs", kind: "PersistentVolumeClaim", by: "label" },
  { folder: "services", kind: "Service", by: "label" },
  { folder: "pdbs", kind: "PodDisruptionBudget", by: "label" },
  { folder: "backups", kind: "Backup", by: "spec" },
  { folder: "scheduledbackups", kind: "ScheduledBackup", by: "spec" },
  { folder: "poolers", kind: "Pooler", by: "spec" },
  { folder: "databases", kind: "Database", by: "spec" },
  { folder: "roles", kind: "DatabaseRole", by: "spec" },
  { folder: "publications", kind: "Publication", by: "spec" },
  { folder: "subscriptions", kind: "Subscription", by: "spec" },
  { folder: "failoverquorums", kind: "FailoverQuorum", by: "name" },
  { folder: "objectstores", kind: "ObjectStore", by: "reference" },
] as const;

export type ReportFolder = (typeof REPORT_KINDS)[number]["folder"];

/** The ObjectStores a cluster refers to: its plugins and the plugins of its external clusters. */
export function referencedObjectStores(cluster: ReportObject): string[] {
  const spec = (cluster.spec ?? {}) as {
    plugins?: Array<{ parameters?: Record<string, string> }>;
    externalClusters?: Array<{ plugin?: { parameters?: Record<string, string> } }>;
  };
  const names = [
    ...(spec.plugins ?? []).map((plugin) => plugin.parameters?.barmanObjectName),
    ...(spec.externalClusters ?? []).map((external) => external.plugin?.parameters?.barmanObjectName),
  ];
  return [...new Set(names.filter((name): name is string => Boolean(name)))].sort();
}

/** Whether an object of a folder belongs to the cluster. */
export function belongsTo(folder: ReportFolder, object: ReportObject, cluster: ReportObject): boolean {
  const name = cluster.metadata?.name;
  const entry = REPORT_KINDS.find((kind) => kind.folder === folder);
  if (!entry || !name) return false;
  switch (entry.by) {
    case "label":
      return object.metadata?.labels?.[CLUSTER_LABEL] === name;
    case "spec":
      return (object.spec as { cluster?: { name?: string } } | undefined)?.cluster?.name === name;
    case "name":
      return object.metadata?.name === name;
    default:
      return referencedObjectStores(cluster).includes(object.metadata?.name ?? "");
  }
}

export const REDACTED = "<redacted>";
const SENSITIVE = /pass(word)?|secret|token|(^|[_.-])key$|private|credential/i;

function redactEnv(env: unknown): unknown {
  if (!Array.isArray(env)) return env;
  return env.map((entry: { name?: string; value?: unknown }) =>
    entry && typeof entry === "object" && "value" in entry && SENSITIVE.test(entry.name ?? "")
      ? { ...entry, value: REDACTED }
      : entry,
  );
}

/** A deep copy whose `env` values with a sensitive name are replaced. */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === "env" ? redactEnv(redactDeep(inner)) : redactDeep(inner),
    ]),
  );
}

/**
 * The object as it goes into the report: without managedFields and the last-applied annotation (which may hold
 * anything), the data of a ConfigMap under a sensitive key replaced, env values with a sensitive name replaced.
 * A Secret never reaches here: it is not read.
 */
export function cleanObject(object: ReportObject): ReportObject {
  const copy = redactDeep(object) as ReportObject;
  if (copy.metadata) {
    const { managedFields: _managed, ...metadata } = copy.metadata;
    const annotations = { ...(metadata.annotations ?? {}) };
    delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
    copy.metadata = { ...metadata, ...(metadata.annotations ? { annotations } : {}) };
  }
  if (copy.kind === "ConfigMap" && copy.data) {
    copy.data = Object.fromEntries(
      Object.entries(copy.data).map(([key, value]) => [key, SENSITIVE.test(key) ? REDACTED : value]),
    );
  }
  return copy;
}

/** The events of the namespace about the cluster and the objects of the report. */
export function reportEvents(events: readonly ReportObject[], objects: readonly ReportObject[]): ReportObject[] {
  const ids = new Set(objects.map((object) => `${object.kind}/${object.metadata?.name}`));
  return events.filter((event) => ids.has(`${event.involvedObject?.kind}/${event.involvedObject?.name}`));
}

export interface InstanceStatus {
  instance: string;
  status?: unknown;
  error?: string;
}

export interface InstanceLogs {
  pod: string;
  text?: string;
  error?: string;
}

export interface ReportInput {
  cluster: ReportObject;
  objects: Partial<Record<ReportFolder, ReportObject[]>>;
  events: ReportObject[];
  statuses: InstanceStatus[];
  /** Undefined when the user left the logs out. */
  logs?: InstanceLogs[];
  logLines?: number;
  /** What could not be read, in words, per folder or part. */
  unreadable: string[];
  generatedAt: Date;
  context?: string;
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}`;
}

/** `<cluster>-<namespace>-<timestamp>.zip`, as the spec names it. */
export function reportFileName(namespace: string, name: string, date: Date): string {
  return `${name}-${namespace}-${stamp(date)}.zip`;
}

function yamlFile(path: string, object: ReportObject): ReportFile {
  return { path, content: toYaml(cleanObject(object)) };
}

/** The files of the archive, README first. */
export function reportFiles(input: ReportInput): ReportFile[] {
  const name = input.cluster.metadata?.name ?? "cluster";
  const namespace = input.cluster.metadata?.namespace ?? "";
  const files: ReportFile[] = [yamlFile("cluster.yaml", input.cluster)];
  const counts: string[] = [];
  const all: ReportObject[] = [input.cluster];
  for (const { folder } of REPORT_KINDS) {
    const items = [...(input.objects[folder] ?? [])].sort((a, b) =>
      (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
    );
    for (const item of items) files.push(yamlFile(`${folder}/${item.metadata?.name ?? "unnamed"}.yaml`, item));
    all.push(...items);
    counts.push(`  ${folder}: ${items.length}`);
  }
  const events = reportEvents(input.events, all);
  files.push({ path: "events.yaml", content: toYaml(events.map(cleanObject)) });
  for (const status of input.statuses) {
    files.push({
      path: `status/${status.instance}.json`,
      content: `${JSON.stringify(status.error ? { error: status.error } : status.status, null, 2)}\n`,
    });
  }
  for (const log of input.logs ?? []) {
    files.push({ path: `logs/${log.pod}.log`, content: log.error ? `${log.error}\n` : (log.text ?? "") });
  }
  const readme = [
    `Diagnostic report of the CloudNativePG cluster ${namespace}/${name}`,
    `Made by the CloudNativePG extension of Freelens on ${input.generatedAt.toISOString()}${
      input.context ? `, Kubernetes context ${input.context}` : ""
    }.`,
    "",
    "What is in it:",
    "  cluster.yaml: the Cluster",
    ...counts,
    `  events.yaml: the ${events.length} events of the namespace about these objects`,
    `  status/: the instance manager status of each instance (${input.statuses.length})`,
    input.logs
      ? `  logs/: the last ${input.logLines ?? "?"} lines of the postgres container of each instance (${input.logs.length})`
      : "  logs/: not included (left out in the dialog)",
    "",
    "What is left out:",
    "  No Secret was read: the objects name their Secrets, never a value.",
    "  managedFields and the kubectl last-applied annotation are removed from every object.",
    `  A value under a key named like a password, a token or a key (environment variables, ConfigMap data) reads ${REDACTED}.`,
    "  The report of the operator itself is not included.",
    ...(input.unreadable.length > 0
      ? ["", "What could not be read:", ...input.unreadable.map((line) => `  ${line}`)]
      : []),
    "",
  ].join("\n");
  return [{ path: "README.txt", content: readme }, ...files];
}
