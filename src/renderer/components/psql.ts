/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The psql terminal (SPEC-0007): which instance to open it on, whether it can
// be opened at all, and the one command line the extension hands to the host's
// terminal. Pure, so every decision is tested without a terminal. The
// extension issues no API call here and never composes SQL: it writes the same
// `kubectl exec ... psql -U postgres` the upstream plugin runs (SPEC-0001 R7)
// and the user's own kubectl does the rest, under the user's own RBAC.

export interface PsqlInstanceFacts {
  name: string;
  role: "primary" | "replica" | "unknown";
  fenced: boolean;
}

export interface PsqlClusterFacts {
  name: string;
  namespace: string;
  hibernated: boolean;
  /** `status.currentPrimary`. */
  currentPrimary?: string;
  instances: readonly PsqlInstanceFacts[];
}

export interface PsqlTarget {
  pod: string;
  namespace: string;
  role: PsqlInstanceFacts["role"];
  fenced: boolean;
}

export type PsqlGuard = { enabled: true } | { enabled: false; reason: string };

export const POSTGRES_CONTAINER = "postgres";

/** RFC 1123 label and subdomain, as the API server enforces for namespaces and pods. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function isNamespaceName(value: string | undefined): value is string {
  return typeof value === "string" && DNS_LABEL.test(value);
}

export function isPodName(value: string | undefined): value is string {
  return typeof value === "string" && value.length <= 253 && DNS_SUBDOMAIN.test(value);
}

/**
 * The instance psql opens on: the named one when given, else the primary the
 * cluster status names, else the instance the health model calls primary. The
 * pod is never guessed from a name pattern.
 */
export function psqlTarget(cluster: PsqlClusterFacts, instanceName?: string): PsqlTarget | undefined {
  const wanted =
    instanceName ?? cluster.currentPrimary ?? cluster.instances.find((instance) => instance.role === "primary")?.name;
  if (!wanted) return undefined;

  const known = cluster.instances.find((instance) => instance.name === wanted);
  // A named instance has to be one of the cluster's; the current primary is
  // trusted even before the instance lists catch up with a switchover.
  if (!known && instanceName) return undefined;
  const isPrimary = wanted === cluster.currentPrimary || known?.role === "primary";
  return {
    pod: wanted,
    namespace: cluster.namespace,
    role: isPrimary ? "primary" : (known?.role ?? "unknown"),
    fenced: known?.fenced ?? false,
  };
}

/** Whether psql can be opened, with the sentence the tooltip shows when it cannot. */
export function canOpenPsql(cluster: PsqlClusterFacts, target: PsqlTarget | undefined): PsqlGuard {
  if (cluster.hibernated) {
    return { enabled: false, reason: "The cluster is hibernated: there is no instance to connect to" };
  }
  if (!target) {
    return { enabled: false, reason: "The cluster status names no primary yet" };
  }
  if (target.fenced) {
    return { enabled: false, reason: `${target.pod} is fenced: PostgreSQL is stopped on it` };
  }
  if (!isNamespaceName(target.namespace) || !isPodName(target.pod)) {
    return { enabled: false, reason: "The namespace or the pod name is not a valid Kubernetes name" };
  }
  return { enabled: true };
}

function quote(value: string): string {
  // The values are DNS names (no quote can be in them); the quotes keep the
  // line readable as one argument each on every shell the host may start.
  return `'${value}'`;
}

/**
 * The command line for the host's terminal. Throws on a name that is not a
 * Kubernetes name: the guard refuses those first, and nothing unvalidated must
 * ever reach a shell.
 */
export function psqlCommand(target: PsqlTarget, kubectlPath?: string): string {
  if (!isNamespaceName(target.namespace) || !isPodName(target.pod)) {
    throw new Error("psql: refusing to compose a command from an invalid namespace or pod name");
  }
  const kubectl = kubectlPath?.trim() ? quote(kubectlPath.trim()) : "kubectl";
  return [
    kubectl,
    "exec",
    "-i",
    "-t",
    "-n",
    quote(target.namespace),
    quote(target.pod),
    "-c",
    POSTGRES_CONTAINER,
    "--",
    "psql",
    "-U",
    "postgres",
  ].join(" ");
}

export function psqlTabTitle(target: PsqlTarget): string {
  return `psql: ${target.pod}`;
}

export function psqlTabId(target: PsqlTarget): string {
  return `cnpg-psql-${target.namespace}-${target.pod}`;
}

/** What the session is, in plain words: the tooltip of every psql control. */
export function psqlTooltip(target: PsqlTarget | undefined, guard: PsqlGuard): string {
  if (!guard.enabled) return `Open psql: ${guard.reason}`;
  const where =
    target?.role === "primary" ? `on the primary ${target.pod}` : `on the standby ${target?.pod} (a read-only session)`;
  return `Opens psql ${where} as the postgres superuser, through kubectl exec with your own credentials (needs pods/exec)`;
}
