/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create Pooler form (SPEC-0026): the name rules the
// operator derives a Service and a Deployment from, the PgBouncer settings
// its webhook allows, which field is wrong and why, what the operator will
// create, and the exact body of the one `create`. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import {
  collisionWarning,
  createLine,
  dnsLabelError,
  duplicateKeys,
  firstError,
  integerError,
  keyValueObject,
} from "./create-forms";
import { subjectOf } from "./write-actions";

import type { KeyValue } from "./create-forms";
import type { ActionDialogFacts } from "./write-actions";

export type ReadState = "loading" | "ready" | "unavailable";

export interface PoolerClusterChoice {
  name: string;
  instances: number;
  hibernated: boolean;
}

export interface PoolerInputs {
  clusters: PoolerClusterChoice[];
  poolers: string[];
  /** The Services of the namespace: a pooler becomes one, and the API server refuses a name taken. */
  services: string[];
  secrets: string[];
  reads: Record<"clusters" | "poolers" | "services" | "secrets", ReadState>;
}

export function emptyPoolerInputs(): PoolerInputs {
  return {
    clusters: [],
    poolers: [],
    services: [],
    secrets: [],
    reads: { clusters: "loading", poolers: "loading", services: "loading", secrets: "loading" },
  };
}

export type PoolerType = "rw" | "ro" | "r";
export type PoolMode = "session" | "transaction";

export interface PoolerForm {
  namespace: string;
  name: string;
  /** True while the name still follows the cluster and the type (the default), false once typed. */
  nameFollows: boolean;
  cluster: string;
  type: PoolerType;
  instances: string;
  poolMode: PoolMode;
  parameters: KeyValue[];
  paused: boolean;
  authQuerySecret: string;
  authQuery: string;
}

export function defaultPoolerName(cluster: string, type: PoolerType): string {
  return cluster ? `${cluster}-pooler-${type}` : "";
}

export function defaultPoolerForm(namespace: string, cluster = ""): PoolerForm {
  return {
    namespace,
    name: defaultPoolerName(cluster, "rw"),
    nameFollows: true,
    cluster,
    type: "rw",
    instances: "1",
    poolMode: "session",
    parameters: [],
    paused: false,
    authQuerySecret: "",
    authQuery: "",
  };
}

/** The PgBouncer settings the operator's webhook accepts in `pgbouncer.parameters` (v1.30.0). */
export const PGBOUNCER_PARAMETERS: readonly string[] = [
  "application_name_add_host",
  "auth_type",
  "autodb_idle_timeout",
  "cancel_wait_timeout",
  "client_idle_timeout",
  "client_login_timeout",
  "client_tls_ciphers",
  "client_tls_sslmode",
  "client_tls13_ciphers",
  "default_pool_size",
  "disable_pqexec",
  "dns_max_ttl",
  "dns_nxdomain_ttl",
  "idle_transaction_timeout",
  "ignore_startup_parameters",
  "listen_backlog",
  "log_connections",
  "log_disconnections",
  "log_pooler_errors",
  "log_stats",
  "max_client_conn",
  "max_db_connections",
  "max_packet_size",
  "max_prepared_statements",
  "max_user_connections",
  "min_pool_size",
  "pkt_buf",
  "query_timeout",
  "query_wait_timeout",
  "reserve_pool_size",
  "reserve_pool_timeout",
  "sbuf_loopcnt",
  "server_check_delay",
  "server_check_query",
  "server_connect_timeout",
  "server_fast_close",
  "server_idle_timeout",
  "server_lifetime",
  "server_login_retry",
  "server_reset_query",
  "server_reset_query_always",
  "server_round_robin",
  "server_tls_ciphers",
  "server_tls13_ciphers",
  "server_tls_protocols",
  "server_tls_sslmode",
  "stats_period",
  "suspend_timeout",
  "tcp_defer_accept",
  "tcp_socket_buffer",
  "tcp_keepalive",
  "tcp_keepcnt",
  "tcp_keepidle",
  "tcp_keepintvl",
  "tcp_user_timeout",
  "track_extra_parameters",
  "verbose",
];

/** The settings offered first in the editor's hint. */
export const COMMON_PGBOUNCER_PARAMETERS: readonly string[] = [
  "max_client_conn",
  "default_pool_size",
  "max_db_connections",
  "query_wait_timeout",
];

export const POOLER_TYPE_SENTENCES: Record<PoolerType, string> = {
  rw: "Writes and reads go to the primary.",
  ro: "Reads go to the standbys only.",
  r: "Reads go to any instance, the primary included.",
};

export const POOL_MODE_SENTENCES: Record<PoolMode, string> = {
  session: "A server connection is held for the whole client session.",
  transaction:
    "A server connection is held for one transaction: more clients per server, but prepared statements, LISTEN and temporary tables do not survive between transactions.",
};

export function pickedPoolerCluster(inputs: PoolerInputs, form: PoolerForm): PoolerClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export function pgbouncerParameterError(key: string): string | undefined {
  if (key === "") return "A parameter needs a name";
  if (!PGBOUNCER_PARAMETERS.includes(key)) {
    return `${key} is not a setting the operator lets a pooler set (pool_mode, auth_user, auth_query, listen_addr, listen_port and the file paths belong to the operator)`;
  }
  return undefined;
}

export const POOLER_FIELD_ORDER: readonly string[] = [
  "namespace",
  "cluster",
  "name",
  "instances",
  "parameters",
  "authQuery",
  "authQuerySecret",
];

export function poolerErrors(inputs: PoolerInputs, form: PoolerForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  const nameError = dnsLabelError(form.name);
  if (nameError) errors.name = nameError;
  else if (form.cluster !== "") {
    const reserved = [
      form.cluster,
      `${form.cluster}-rw`,
      `${form.cluster}-ro`,
      `${form.cluster}-r`,
      `${form.cluster}-any`,
    ];
    if (reserved.includes(form.name))
      errors.name = `${form.name} is the name of the cluster or of one of its services: the pooler becomes a Service of its own`;
    else if (inputs.reads.services === "ready" && inputs.services.includes(form.name)) {
      errors.name = `A Service named ${form.name} already exists in the namespace: the pooler could not create its own`;
    }
  }
  const instancesError = integerError(form.instances, "Instances", 1);
  if (instancesError) errors.instances = instancesError;
  const duplicates = duplicateKeys(form.parameters);
  form.parameters.forEach((parameter, index) => {
    const key = parameter.key.trim();
    const keyError = pgbouncerParameterError(key) ?? (duplicates.has(key) ? `${key} is set twice` : undefined);
    if (keyError) errors[`parameters.${index}.key`] = keyError;
    else if (parameter.value.trim() === "") errors[`parameters.${index}.value`] = "A parameter needs a value";
  });
  if (Object.keys(errors).some((key) => key.startsWith("parameters."))) errors.parameters = "A parameter is wrong";
  const secret = form.authQuerySecret.trim() !== "";
  const query = form.authQuery.trim() !== "";
  if (secret && !query) errors.authQuery = "An auth query secret needs the auth query that uses it";
  if (query && !secret) errors.authQuerySecret = "An auth query needs the secret of the user that runs it";
  return errors;
}

export function poolerWarnings(inputs: PoolerInputs, form: PoolerForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning("pooler", form.name, inputs.poolers);
  if (collision) warnings.name = collision;
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !pickedPoolerCluster(inputs, form)) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: the pooler stays inactive until it exists`;
  }
  if (
    form.authQuerySecret !== "" &&
    inputs.reads.secrets === "ready" &&
    !inputs.secrets.includes(form.authQuerySecret)
  ) {
    warnings.authQuerySecret = `No secret named ${form.authQuerySecret} was found: the pooler stays inactive until it exists`;
  }
  return warnings;
}

/** Why a type is dimmed for the picked cluster, or undefined. */
export function poolerTypeReason(inputs: PoolerInputs, form: PoolerForm, type: PoolerType): string | undefined {
  const cluster = pickedPoolerCluster(inputs, form);
  if (cluster && cluster.instances < 2 && type !== "rw") return "nothing to read from: the cluster has one instance";
  return undefined;
}

export function poolerBody(form: PoolerForm): Record<string, unknown> {
  const pgbouncer: Record<string, unknown> = { poolMode: form.poolMode };
  const parameters = keyValueObject(form.parameters);
  if (parameters) pgbouncer.parameters = parameters;
  if (form.paused) pgbouncer.paused = true;
  if (form.authQuerySecret.trim() !== "") pgbouncer.authQuerySecret = { name: form.authQuerySecret.trim() };
  if (form.authQuery.trim() !== "") pgbouncer.authQuery = form.authQuery.trim();
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "Pooler",
    metadata: { name: form.name, namespace: form.namespace },
    spec: { cluster: { name: form.cluster }, type: form.type, instances: Number(form.instances), pgbouncer },
  };
}

export function poolerNotes(inputs: PoolerInputs, form: PoolerForm): string[] {
  const name = form.name || "<name>";
  const count = form.instances || "?";
  const notes = [
    `The operator creates a Deployment and a Service named ${name}: ${count} PgBouncer pod${count === "1" ? "" : "s"} in ${form.poolMode} mode in front of ${form.cluster || "<cluster>"}-${form.type}. ${POOLER_TYPE_SENTENCES[form.type]}`,
    form.authQuery.trim() !== ""
      ? `Clients are authenticated by the query given, run as the user of the secret ${form.authQuerySecret || "?"}: the operator does not manage this integration.`
      : "Clients are authenticated through the operator's own query and user (cnpg_pooler_pgbouncer), which it creates in the cluster.",
  ];
  if (form.paused)
    notes.push("Created paused: PgBouncer accepts connections and holds every query until the pooler is resumed.");
  const cluster = pickedPoolerCluster(inputs, form);
  if (cluster?.hibernated)
    notes.push("The cluster is hibernated: the pooler will have nothing to connect to until it is resumed.");
  return notes;
}

export function poolerSummaryWarnings(inputs: PoolerInputs, form: PoolerForm): string[] {
  const warnings: string[] = [];
  if (form.poolMode === "transaction") warnings.push(POOL_MODE_SENTENCES.transaction);
  const reason = poolerTypeReason(inputs, form, form.type);
  if (reason) warnings.push(`Type ${form.type} on a cluster with one instance: ${reason}.`);
  if (form.parameters.length > 0)
    warnings.push(
      "The operator does not check the values of the parameters: a wrong one crash loops every pod of the pooler.",
    );
  return warnings;
}

export function poolerFacts(inputs: PoolerInputs, form: PoolerForm): ActionDialogFacts {
  const parts = [
    `cluster ${form.cluster || "?"}`,
    `type ${form.type}`,
    `${form.instances || "?"} instance${form.instances === "1" ? "" : "s"}`,
    `${form.poolMode} mode`,
  ];
  return {
    subject: subjectOf("Pooler", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [{ verb: "create", text: createLine("Pooler", form.namespace, form.name, parts.join(", ")) }],
    notes: poolerNotes(inputs, form),
    warnings: poolerSummaryWarnings(inputs, form),
  };
}

export function poolerBlockReason(inputs: PoolerInputs, form: PoolerForm, accessReason?: string): string | undefined {
  return firstError(POOLER_FIELD_ORDER, poolerErrors(inputs, form)) ?? accessReason;
}

export function poolerSuccessMessage(namespace: string, name: string): string {
  return `Requested the pooler ${namespace}/${name}: the operator creates its Deployment and Service now`;
}
