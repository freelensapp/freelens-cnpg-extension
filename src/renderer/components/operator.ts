/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the Operator page (SPEC-0016): what the deployment that runs
// CloudNativePG says about itself (version, replicas, leader, what it watches,
// how it is configured), the CNPG-I plugins it discovered with the clusters
// that loaded them, the kinds the cluster serves, and the reconciles per
// controller between two readings of its metrics.

import { selectSamples, singleValue } from "../api/instance/prometheus-text";
import { holderPod, leaseFacts } from "./leases";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { LeaseLike } from "../api/core/lease";
import type { MetricSample } from "../api/instance/prometheus-text";
import type { HostStatusClass } from "./cluster-health";
import type { LeaseFacts } from "./leases";

export const OPERATOR_NAME_LABEL = "app.kubernetes.io/name";
export const OPERATOR_NAME = "cloudnative-pg";
export const OPERATOR_DEFAULT_DEPLOYMENT = "cnpg-controller-manager";
export const PLUGIN_NAME_LABEL = "cnpg.io/pluginName";
export const PLUGIN_PORT_ANNOTATION = "cnpg.io/pluginPort";

interface ContainerLike {
  name?: string;
  image?: string;
  args?: string[];
  command?: string[];
  env?: { name?: string; value?: string }[];
  ports?: { name?: string; containerPort?: number }[];
}

export interface DeploymentLike {
  metadata?: { name?: string; namespace?: string; labels?: Partial<Record<string, string>> };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Partial<Record<string, string>> };
    template?: {
      metadata?: { labels?: Partial<Record<string, string>> };
      spec?: { containers?: ContainerLike[] };
    };
  };
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number };
}

export interface PodLike {
  metadata?: { name?: string; namespace?: string; labels?: Partial<Record<string, string>> };
}

export interface ServiceLike {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Partial<Record<string, string>>;
    annotations?: Partial<Record<string, string>>;
  };
  spec?: { selector?: Partial<Record<string, string>> };
}

export interface ConfigMapLike {
  metadata?: { name?: string; namespace?: string };
  data?: Partial<Record<string, string>>;
}

function operatorContainer(deployment: DeploymentLike): ContainerLike | undefined {
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  return containers.find((container) => (container.image ?? "").includes("cloudnative-pg")) ?? containers[0];
}

/** Whether a deployment is a CloudNativePG operator: by its label, else by its image or its well-known name. */
export function isOperator(deployment: DeploymentLike): boolean {
  if (deployment.metadata?.labels?.[OPERATOR_NAME_LABEL] === OPERATOR_NAME) return true;
  if (deployment.metadata?.name === OPERATOR_DEFAULT_DEPLOYMENT) return true;
  return (deployment.spec?.template?.spec?.containers ?? []).some((container) =>
    /(^|\/)cloudnative-pg(:|@|$)/.test(container.image ?? ""),
  );
}

export function findOperators<T extends DeploymentLike>(deployments: readonly T[]): T[] {
  return deployments
    .filter(isOperator)
    .sort(
      (a, b) =>
        (a.metadata?.namespace ?? "").localeCompare(b.metadata?.namespace ?? "") ||
        (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
    );
}

/** `1.30.0` from `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:...`; undefined for a bare digest. */
export function imageVersion(image: string | undefined): string | undefined {
  if (!image) return undefined;
  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", lastSlash + 1);
  return colon === -1 ? undefined : withoutDigest.slice(colon + 1) || undefined;
}

function flag(container: ContainerLike | undefined, name: string): string | undefined {
  const words = [...(container?.command ?? []), ...(container?.args ?? [])];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === `--${name}`) return words[index + 1];
    if (word.startsWith(`--${name}=`)) return word.slice(name.length + 3);
  }
  return undefined;
}

function matches(
  labels: Partial<Record<string, string>> | undefined,
  selector: Partial<Record<string, string>>,
): boolean {
  const wanted = Object.entries(selector);
  return wanted.length > 0 && wanted.every(([key, value]) => labels?.[key] === value);
}

/** The pods of a deployment: same namespace, labels that satisfy its selector. */
export function podsOfDeployment<T extends PodLike>(deployment: DeploymentLike, pods: readonly T[]): T[] {
  const selector =
    deployment.spec?.selector?.matchLabels ?? deployment.spec?.template?.metadata?.labels ?? ({} as const);
  return pods
    .filter(
      (pod) => pod.metadata?.namespace === deployment.metadata?.namespace && matches(pod.metadata?.labels, selector),
    )
    .sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
}

export type OperatorState = "Running" | "Progressing" | "Down";

export interface OperatorFacts {
  name: string;
  namespace: string;
  state: OperatorState;
  className: HostStatusClass;
  reason: string;
  version?: string;
  image?: string;
  ready: number;
  declared: number;
  pods: string[];
  /** The pod that holds the leader election lease. */
  leader?: string;
  lease?: LeaseFacts;
  leaseName?: string;
  /** The port of the metrics endpoint, from the container. */
  metricsPort?: number;
  leaderElection: boolean;
  maxConcurrentReconciles?: string;
  configMapName?: string;
  secretName?: string;
  /** "All namespaces", or the namespaces of `WATCH_NAMESPACE`. */
  watchScope: string;
  watchedNamespaces: string[];
  /** The configuration keys that are set, without the watch scope. */
  configuration: { name: string; value: string }[];
}

export interface OperatorInput {
  deployment: DeploymentLike;
  pods?: readonly PodLike[];
  leases?: readonly LeaseLike[];
  configMaps?: readonly ConfigMapLike[];
  now?: Date;
}

export function operatorFacts({
  deployment,
  pods = [],
  leases = [],
  configMaps = [],
  now,
}: OperatorInput): OperatorFacts {
  const container = operatorContainer(deployment);
  const namespace = deployment.metadata?.namespace ?? "";
  const declared = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas ?? 0;
  const podNames = podsOfDeployment(deployment, pods).map((pod) => pod.metadata?.name ?? "");

  // The leader election lease is the one of the namespace held by one of the operator's own pods.
  const lease = leases.find(
    (candidate) =>
      candidate.metadata?.namespace === namespace && podNames.includes(holderPod(candidate.spec?.holderIdentity ?? "")),
  );
  const facts = lease ? leaseFacts(lease, now) : undefined;

  const configMapName = flag(container, "config-map-name");
  const configMap = configMaps.find(
    (candidate) => candidate.metadata?.name === configMapName && candidate.metadata?.namespace === namespace,
  );
  const settings: Partial<Record<string, string>> = {};
  for (const item of container?.env ?? []) {
    if (item.name && item.value !== undefined) settings[item.name] = item.value;
  }
  Object.assign(settings, configMap?.data ?? {});
  const watched = (settings.WATCH_NAMESPACE ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const state: OperatorState = ready >= declared && declared > 0 ? "Running" : ready > 0 ? "Progressing" : "Down";
  const reason =
    state === "Running"
      ? `${ready} of ${declared} replicas ready`
      : state === "Progressing"
        ? `${ready} of ${declared} replicas ready`
        : declared === 0
          ? "Scaled to zero: nothing reconciles the clusters"
          : "No replica is ready: nothing reconciles the clusters";

  return {
    name: deployment.metadata?.name ?? "",
    namespace,
    state,
    className: state === "Running" ? "success" : state === "Progressing" ? "warning" : "error",
    reason,
    version: imageVersion(container?.image),
    image: container?.image,
    ready,
    declared,
    pods: podNames,
    leader: facts?.holder ? holderPod(facts.holder) : undefined,
    lease: facts,
    leaseName: lease?.metadata?.name,
    metricsPort: container?.ports?.find((port) => port.name === "metrics")?.containerPort,
    leaderElection: [...(container?.command ?? []), ...(container?.args ?? [])].some((word) =>
      word.startsWith("--leader-elect"),
    ),
    maxConcurrentReconciles: flag(container, "max-concurrent-reconciles"),
    configMapName,
    secretName: flag(container, "secret-name"),
    watchScope: watched.length === 0 ? "All namespaces" : watched.join(", "),
    watchedNamespaces: watched,
    configuration: Object.entries(configMap?.data ?? {})
      .filter((entry): entry is [string, string] => entry[0] !== "WATCH_NAMESPACE" && typeof entry[1] === "string")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value })),
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginFacts {
  /** The CNPG-I name clusters refer to. */
  name: string;
  service: string;
  namespace: string;
  port?: string;
  /** The deployment behind the service, when one matches its selector. */
  deployment?: string;
  ready?: number;
  declared?: number;
  className: HostStatusClass;
  /** The clusters that report the plugin as loaded, with the version they see. */
  clusters: { name: string; namespace: string; version?: string }[];
  capabilities: string[];
}

export function pluginFacts(
  services: readonly ServiceLike[],
  deployments: readonly DeploymentLike[],
  clusters: readonly Cluster[],
): PluginFacts[] {
  const plugins: PluginFacts[] = [];
  for (const service of services) {
    const name = service.metadata?.labels?.[PLUGIN_NAME_LABEL];
    if (!name) continue;
    const namespace = service.metadata?.namespace ?? "";
    const selector = service.spec?.selector ?? {};
    const deployment = deployments.find(
      (candidate) =>
        candidate.metadata?.namespace === namespace && matches(candidate.spec?.template?.metadata?.labels, selector),
    );
    const users: PluginFacts["clusters"] = [];
    const capabilities = new Set<string>();
    for (const cluster of clusters) {
      const status = cluster.status?.pluginStatus?.find((plugin) => plugin.name === name);
      if (!status) continue;
      users.push({
        name: cluster.metadata?.name ?? "",
        namespace: cluster.metadata?.namespace ?? "",
        version: status.version,
      });
      for (const capability of status.capabilities ?? []) capabilities.add(capability);
    }
    const ready = deployment?.status?.readyReplicas ?? (deployment ? 0 : undefined);
    const declared = deployment?.spec?.replicas ?? (deployment ? 1 : undefined);
    plugins.push({
      name,
      service: service.metadata?.name ?? "",
      namespace,
      port: service.metadata?.annotations?.[PLUGIN_PORT_ANNOTATION],
      deployment: deployment?.metadata?.name,
      ready,
      declared,
      className:
        ready === undefined || declared === undefined
          ? "info"
          : ready >= declared && declared > 0
            ? "success"
            : "error",
      clusters: users.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)),
      capabilities: [...capabilities].sort(),
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const CNPG_GROUPS: readonly string[] = ["postgresql.cnpg.io", "barmancloud.cnpg.io"];

/** The kinds this extension has a list and a drawer for. */
export const KINDS_WITH_A_VIEW: readonly string[] = [
  "Backup",
  "Cluster",
  "ClusterImageCatalog",
  "Database",
  "DatabaseRole",
  "FailoverQuorum",
  "ImageCatalog",
  "ObjectStore",
  "Pooler",
  "Publication",
  "ScheduledBackup",
  "Subscription",
];

export interface CrdLike {
  metadata?: { name?: string };
  spec?: {
    group?: string;
    scope?: string;
    names?: { kind?: string; plural?: string };
    versions?: { name?: string; served?: boolean; storage?: boolean }[];
  };
}

export interface KindFacts {
  kind: string;
  group: string;
  scope: string;
  served: string[];
  stored?: string;
  hasView: boolean;
}

export function kindFacts(crds: readonly CrdLike[]): KindFacts[] {
  return crds
    .filter((crd) => CNPG_GROUPS.includes(crd.spec?.group ?? ""))
    .map((crd) => {
      const versions = crd.spec?.versions ?? [];
      const kind = crd.spec?.names?.kind ?? crd.metadata?.name ?? "";
      return {
        kind,
        group: crd.spec?.group ?? "",
        scope: crd.spec?.scope ?? "Namespaced",
        served: versions.filter((version) => version.served !== false).map((version) => version.name ?? ""),
        stored: versions.find((version) => version.storage)?.name,
        hasView: KINDS_WITH_A_VIEW.includes(kind),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) * -1 || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Reconciles
// ---------------------------------------------------------------------------

export interface ReconcileRow {
  controller: string;
  total: number;
  errors: number;
  /** Between two readings; undefined on the first one. */
  perMinute?: number;
  errorsPerMinute?: number;
  activeWorkers?: number;
  maxWorkers?: number;
  queueDepth?: number;
  level: "ok" | "error";
}

function sumBy(samples: readonly MetricSample[], name: string, label: string): Map<string, number> {
  const sums = new Map<string, number>();
  for (const sample of selectSamples(samples, name)) {
    const key = sample.labels[label];
    if (!key || Number.isNaN(sample.value)) continue;
    sums.set(key, (sums.get(key) ?? 0) + sample.value);
  }
  return sums;
}

/** Per controller: reconciles and errors so far, their pace between two readings, workers and queue. */
export function reconcileFacts(
  current: readonly MetricSample[],
  previous?: readonly MetricSample[],
  elapsedSeconds?: number,
): ReconcileRow[] {
  const totals = sumBy(current, "controller_runtime_reconcile_total", "controller");
  const errors = sumBy(current, "controller_runtime_reconcile_errors_total", "controller");
  const before = previous ? sumBy(previous, "controller_runtime_reconcile_total", "controller") : undefined;
  const errorsBefore = previous
    ? sumBy(previous, "controller_runtime_reconcile_errors_total", "controller")
    : undefined;
  const paced = Boolean(before && errorsBefore && elapsedSeconds && elapsedSeconds > 0);
  const perMinute = (now: number, then: number | undefined) =>
    paced && then !== undefined && now >= then ? ((now - then) / (elapsedSeconds as number)) * 60 : undefined;

  return [...totals.keys()].sort().map((controller) => {
    const total = totals.get(controller) ?? 0;
    const failed = errors.get(controller) ?? 0;
    const errorsPace = perMinute(failed, errorsBefore?.get(controller));
    return {
      controller,
      total,
      errors: failed,
      perMinute: perMinute(total, before?.get(controller)),
      errorsPerMinute: errorsPace,
      activeWorkers: singleValue(current, "controller_runtime_active_workers", { controller }),
      maxWorkers: singleValue(current, "controller_runtime_max_concurrent_reconciles", { controller }),
      queueDepth: singleValue(current, "workqueue_depth", { name: controller }),
      level: errorsPace !== undefined && errorsPace > 0 ? "error" : "ok",
    } satisfies ReconcileRow;
  });
}

/** Whether the pod that answered says it is the leader. */
export function isLeaderByMetrics(samples: readonly MetricSample[]): boolean | undefined {
  const value = selectSamples(samples, "leader_election_master_status")[0]?.value;
  return value === undefined || Number.isNaN(value) ? undefined : value === 1;
}
