/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The installation guide of SPEC-0036 and the words for the CNPG-I plugins.
// Pure: the detection of what the cluster runs is `api/operator/components.ts`;
// this module turns it into three steps (the operator, cert-manager, the Barman
// Cloud plugin) with their state and what to run, and tells what a plugin does.
// Nothing here runs a command: the guide shows them to copy.

import type { Cluster } from "../api/cnpg/cluster-v1";

/**
 * The releases this version of the extension was reviewed against: the pins of
 * the lab (`e2e/scripts/lib.sh`), which a unit test keeps equal.
 */
export const REVIEWED = {
  cnpg: "1.30.1",
  certManager: "v1.21.2",
  barmanCloud: "v0.15.1",
} as const;

export const BARMAN_CLOUD_PLUGIN = "barman-cloud.cloudnative-pg.io";
export const KLIO_PLUGIN = "klio.cnpg.io";

/** What a probe of the cluster found for one component. */
export interface ComponentProbe {
  /** Its CRD: there, not there, or the CRDs cannot be read. */
  crd: "present" | "absent" | "unknown";
  /** The version of its running workload, from the image tag, when one was seen. */
  version?: string;
  /** Where the workload runs. */
  namespace?: string;
}

export interface ClusterComponents {
  operator: ComponentProbe;
  certManager: ComponentProbe;
  barmanCloud: ComponentProbe;
  klio: ComponentProbe;
}

export type StepState = "installed" | "missing" | "not needed" | "unknown";

export interface GuideStep {
  id: "operator" | "cert-manager" | "barman-cloud";
  title: string;
  state: StepState;
  /** The state in one sentence: the version, or why it is needed, or why not. */
  words: string;
  /** Set when the installed version is older than the one this extension was reviewed with. */
  older?: string;
  /** What has to be there before this step makes sense. */
  after?: string;
  /** Commands to copy, in order; the first is the one to use. */
  commands: { label: string; text: string }[];
  /** The upstream documentation, opened in the browser. */
  docs: string;
  /** The Helm chart of the step, for the host's Helm Charts page once its repository is added. */
  chart?: { repository: string; url: string; name: string };
}

const MANIFESTS = {
  cnpg: `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v${REVIEWED.cnpg}/releases/cnpg-${REVIEWED.cnpg}.yaml`,
  certManager: `https://github.com/cert-manager/cert-manager/releases/download/${REVIEWED.certManager}/cert-manager.yaml`,
  barmanCloud: `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/${REVIEWED.barmanCloud}/manifest.yaml`,
};

/** `1.30.1` is older than `1.30.10`, `v0.15.0` than `v0.15.1`; undefined when either does not parse. */
export function olderThan(version: string | undefined, reference: string): boolean | undefined {
  const parse = (text: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  const a = version ? parse(version) : undefined;
  const b = parse(reference);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

function installedWords(name: string, probe: ComponentProbe): string {
  if (!probe.version) return `${name} is installed; its version is not visible with your permissions`;
  return `${name} ${probe.version} is installed${probe.namespace ? ` in ${probe.namespace}` : ""}`;
}

function olderWords(probe: ComponentProbe, reviewed: string): string | undefined {
  return olderThan(probe.version, reviewed)
    ? `This extension was reviewed with ${reviewed}: some views may miss what the newer release reports`
    : undefined;
}

export function guideSteps(components: ClusterComponents): GuideStep[] {
  const { operator, certManager, barmanCloud, klio } = components;

  const operatorStep: GuideStep = {
    id: "operator",
    title: "CloudNativePG operator",
    state:
      operator.version || operator.crd === "present" ? "installed" : operator.crd === "absent" ? "missing" : "unknown",
    words: operator.version
      ? installedWords("CloudNativePG", operator)
      : operator.crd === "present"
        ? "Its kinds are installed; the operator's deployment is not visible with your permissions"
        : operator.crd === "absent"
          ? "Not installed: no PostgreSQL cluster can be declared"
          : "Not known: the CRDs of this cluster cannot be read with your permissions",
    older: olderWords(operator, REVIEWED.cnpg),
    commands: [
      { label: "The release manifest", text: `kubectl apply --server-side -f ${MANIFESTS.cnpg}` },
      {
        label: "Or the Helm chart",
        text: "helm repo add cnpg https://cloudnative-pg.github.io/charts\nhelm upgrade --install cnpg --namespace cnpg-system --create-namespace cnpg/cloudnative-pg",
      },
    ],
    docs: "https://cloudnative-pg.io/documentation/current/installation_upgrade/",
    chart: { repository: "cnpg", url: "https://cloudnative-pg.github.io/charts", name: "cloudnative-pg" },
  };

  const barmanInstalled = Boolean(barmanCloud.version) || barmanCloud.crd === "present";
  const klioInstalled = Boolean(klio.version) || klio.crd === "present";

  const certManagerStep: GuideStep = {
    id: "cert-manager",
    title: "cert-manager",
    state:
      certManager.version || certManager.crd === "present"
        ? "installed"
        : !barmanInstalled && klioInstalled
          ? "not needed"
          : certManager.crd === "absent"
            ? "missing"
            : "unknown",
    words:
      certManager.version || certManager.crd === "present"
        ? installedWords("cert-manager", certManager)
        : !barmanInstalled && klioInstalled
          ? "Not needed: Klio backs the clusters up, and the Barman Cloud plugin is what needs cert-manager"
          : certManager.crd === "absent"
            ? "Not installed: the Barman Cloud plugin needs it for the certificates of its connection to the operator"
            : "Not known: the CRDs of this cluster cannot be read with your permissions",
    commands: [{ label: "The release manifest", text: `kubectl apply -f ${MANIFESTS.certManager}` }],
    docs: "https://cert-manager.io/docs/installation/",
  };

  const barmanStep: GuideStep = {
    id: "barman-cloud",
    title: "Barman Cloud plugin",
    state: barmanInstalled
      ? "installed"
      : klioInstalled
        ? "not needed"
        : barmanCloud.crd === "absent"
          ? "missing"
          : "unknown",
    words: barmanInstalled
      ? installedWords("The Barman Cloud plugin", barmanCloud)
      : klioInstalled
        ? "Not needed: Klio is installed and backs the clusters up"
        : barmanCloud.crd === "absent"
          ? "Not installed: without it, or another backup plugin, no cluster has WAL archiving or backups to an object store"
          : "Not known: the CRDs of this cluster cannot be read with your permissions",
    older: barmanInstalled ? olderWords(barmanCloud, REVIEWED.barmanCloud) : undefined,
    after:
      operatorStep.state !== "installed" || certManagerStep.state === "missing"
        ? "Install it after the operator and cert-manager: its manifest asks cert-manager for its certificates"
        : undefined,
    commands: [
      { label: "The release manifest, in the operator's namespace", text: `kubectl apply -f ${MANIFESTS.barmanCloud}` },
    ],
    docs: "https://cloudnative-pg.io/plugin-barman-cloud/",
  };

  return [operatorStep, certManagerStep, barmanStep];
}

/** True when every step is done: the guide then folds into one line. */
export function guideComplete(steps: readonly GuideStep[]): boolean {
  return steps.every((step) => step.state === "installed" || step.state === "not needed");
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** The plugins this extension knows by name. */
export const KNOWN_PLUGINS: Record<string, { title: string; docs: string }> = {
  [BARMAN_CLOUD_PLUGIN]: { title: "Barman Cloud", docs: "https://cloudnative-pg.io/plugin-barman-cloud/" },
  [KLIO_PLUGIN]: { title: "Klio", docs: "https://cloudnative-pg.io/klio/" },
};

export function pluginTitle(name: string): string {
  return KNOWN_PLUGINS[name]?.title ?? name;
}

/** The CNPG-I capability types (`identity.proto`), in words. */
const CAPABILITY_WORDS: Record<string, string> = {
  TYPE_OPERATOR_SERVICE: "operator: validates and defaults the cluster's settings for it",
  TYPE_WAL_SERVICE: "WAL: archives and restores the WAL files",
  TYPE_BACKUP_SERVICE: "backups: takes base backups",
  TYPE_LIFECYCLE_SERVICE: "lifecycle: changes the pods and jobs the operator creates",
  TYPE_RECONCILER_HOOKS: "reconciler hooks: acts before and after the operator reconciles a cluster",
  TYPE_RESTORE_JOB: "restore: brings a new cluster up from its backups",
  TYPE_POSTGRES: "PostgreSQL: adds to the configuration of PostgreSQL",
  TYPE_INSTANCE_SIDECAR_INJECTION: "sidecar: runs a container next to PostgreSQL in every instance",
  TYPE_INSTANCE_JOB_SIDECAR_INJECTION: "job sidecar: runs a container next to the jobs of the instances",
  TYPE_METRICS: "metrics: adds metrics to the instances",
};

export function capabilityWords(capability: string): string {
  return (
    CAPABILITY_WORDS[capability] ??
    capability
      .replace(/^TYPE_/, "")
      .replace(/_/g, " ")
      .toLowerCase()
  );
}

/** What the clusters use a plugin for, from their spec and their backups: what it does here. */
export interface PluginUse {
  walArchiving: string[];
  backups: string[];
  recovery: string[];
}

interface BackupLike {
  metadata?: { namespace?: string };
  spec?: { method?: string; cluster?: { name?: string }; pluginConfiguration?: { name?: string } };
}

export function pluginUse(name: string, clusters: readonly Cluster[], backupObjects: readonly BackupLike[]): PluginUse {
  const key = (namespace: string | undefined, cluster: string | undefined) => `${namespace ?? ""}/${cluster ?? ""}`;
  const walArchiving = clusters
    .filter((cluster) => cluster.spec?.plugins?.some((plugin) => plugin.name === name && plugin.isWALArchiver))
    .map((cluster) => key(cluster.getNs(), cluster.getName()));
  const recovery = clusters
    .filter((cluster) =>
      (cluster.spec?.externalClusters ?? []).some(
        (external) => (external.plugin as { name?: string } | undefined)?.name === name,
      ),
    )
    .map((cluster) => key(cluster.getNs(), cluster.getName()));
  const backups = [
    ...new Set(
      backupObjects
        .filter((backup) => backup.spec?.method === "plugin" && backup.spec.pluginConfiguration?.name === name)
        .map((backup) => key(backup.metadata?.namespace, backup.spec?.cluster?.name)),
    ),
  ];
  const sorted = (list: string[]) => [...new Set(list)].sort();
  return { walArchiving: sorted(walArchiving), backups: sorted(backups), recovery: sorted(recovery) };
}

/** The backup method of a cluster in words, for its drawer: names Klio and Barman Cloud. */
export function backupPluginWords(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const known = KNOWN_PLUGINS[name];
  return known ? `${known.title} (${name})` : name;
}
