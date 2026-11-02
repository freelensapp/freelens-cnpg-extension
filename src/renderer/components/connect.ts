/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Connect section of SPEC-0031: the services an application reaches a
// cluster or a pooler through, the application user and its Secret, and the
// psql command of a local forward. Pure; no credential passes through here:
// the Secret is read on a click, by `connect-section.tsx`, straight into the
// clipboard.

import { POSTGRES_PORT } from "../../common/ipc";

export type ServiceType = "rw" | "ro" | "r";

export interface ServiceRow {
  service: string;
  type: ServiceType;
  /** `<service>.<namespace>`: what an application of the Kubernetes cluster puts in its connection string. */
  host: string;
  fqdn: string;
  port: number;
  purpose: string;
  /** One of `spec.managed.services.additional`. */
  additional: boolean;
}

export const SERVICE_PURPOSES: Record<ServiceType, string> = {
  rw: "read and write: the primary only",
  ro: "read only: the replicas only",
  r: "read: any instance, the primary included",
};

interface ManagedServices {
  disabledDefaultServices?: string[];
  additional?: Array<{ selectorType?: string; serviceTemplate?: { metadata?: { name?: string } } }>;
}

export interface ConnectCluster {
  name: string;
  namespace: string;
  managed?: { services?: ManagedServices } | Record<string, unknown>;
  bootstrap?: {
    initdb?: { database?: string; owner?: string; secret?: { name?: string } };
    recovery?: { database?: string; owner?: string; secret?: { name?: string } };
    pg_basebackup?: { database?: string; owner?: string; secret?: { name?: string } };
  };
}

function row(name: string, namespace: string, type: ServiceType, additional: boolean): ServiceRow {
  return {
    service: name,
    type,
    host: `${name}.${namespace}`,
    fqdn: `${name}.${namespace}.svc.cluster.local`,
    port: POSTGRES_PORT,
    purpose: SERVICE_PURPOSES[type],
    additional,
  };
}

function isType(value: unknown): value is ServiceType {
  return value === "rw" || value === "ro" || value === "r";
}

/** The services of a cluster that exist: rw always, ro and r unless disabled, then the additional ones. */
export function clusterServiceRows(cluster: ConnectCluster): ServiceRow[] {
  const services = (cluster.managed as { services?: ManagedServices } | undefined)?.services;
  const disabled = new Set(services?.disabledDefaultServices ?? []);
  const defaults = (["rw", "ro", "r"] as const)
    .filter((type) => type === "rw" || !disabled.has(type))
    .map((type) => row(`${cluster.name}-${type}`, cluster.namespace, type, false));
  const additional = (services?.additional ?? []).flatMap((service) => {
    const name = service.serviceTemplate?.metadata?.name;
    return name && isType(service.selectorType) ? [row(name, cluster.namespace, service.selectorType, true)] : [];
  });
  return [...defaults, ...additional];
}

/** The service of a pooler: its own name, in front of the service of its type. */
export function poolerServiceRow(name: string, namespace: string, type: ServiceType): ServiceRow {
  return {
    ...row(name, namespace, type, false),
    purpose: `PgBouncer in front of ${SERVICE_PURPOSES[type]}`,
  };
}

export interface ApplicationUser {
  database: string;
  user: string;
  /** The Secret of the user: the operator's `<cluster>-app`, or the one the bootstrap names. */
  secret: string;
}

/** The application database and owner of the bootstrap, and their Secret; the operator's defaults are app and app. */
export function applicationUser(cluster: ConnectCluster): ApplicationUser {
  const bootstrap = cluster.bootstrap?.initdb ?? cluster.bootstrap?.recovery ?? cluster.bootstrap?.pg_basebackup;
  const database = bootstrap?.database || "app";
  return {
    database,
    user: bootstrap?.owner || database,
    secret: bootstrap?.secret?.name || `${cluster.name}-app`,
  };
}

/** The keys of the operator's application Secret (v1.30.1) the section copies. */
export type SecretKey = "password" | "uri" | "jdbc-uri" | "fqdn-uri" | "fqdn-jdbc-uri";

export const SECRET_KEY_WORDS: Record<SecretKey, string> = {
  password: "the password",
  uri: "the URI",
  "jdbc-uri": "the JDBC URI",
  "fqdn-uri": "the URI with the full host name",
  "fqdn-jdbc-uri": "the JDBC URI with the full host name",
};

/** The value of a key of a Secret's `data`, decoded; undefined when the key is not there. */
export function secretValue(
  data: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  const encoded = data?.[key];
  if (encoded === undefined) return undefined;
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function quoted(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The psql command of a local forward: no password, psql asks for it (or reads ~/.pgpass). */
export function psqlCommand(port: number, database: string, user: string): string {
  return `psql "host=127.0.0.1 port=${port} dbname=${quoted(database)} user=${quoted(user)}"`;
}
