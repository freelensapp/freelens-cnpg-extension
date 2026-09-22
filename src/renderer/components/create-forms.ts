/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The grammar every creation form shares (SPEC-0025, F5, F6, F11, F12): the
// names the API server accepts and the ones the operator derives things
// from, the quantities, the image references, the PostgreSQL parameters the
// operator fixes, the timestamps, and the YAML of the exact body a create
// sends. Pure: the dialogs render what these functions decide, and every
// refusal here carries the reason the field shows.

import { dump } from "js-yaml";

export const DNS_SUBDOMAIN_MAX = 253;
export const DNS_LABEL_MAX = 63;
/** The operator's own limit on a cluster name (validating webhook of v1.30.0). */
export const CLUSTER_NAME_MAX = 50;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/** A Kubernetes object name (a DNS subdomain), or why it is not one. */
export function objectNameError(name: string): string | undefined {
  if (name === "") return "A name is required";
  if (name !== name.trim()) return "A name has no blanks around it";
  if (name.length > DNS_SUBDOMAIN_MAX) return `A name has ${DNS_SUBDOMAIN_MAX} characters at most`;
  const labels = name.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label) && label.length <= DNS_LABEL_MAX)) {
    return "A name is lowercase letters, digits, dashes and dots, and starts and ends with a letter or a digit";
  }
  return undefined;
}

/**
 * A DNS label that starts with a letter (RFC 1035): what a name must be when
 * the operator makes Services out of it.
 */
export function dnsLabelError(name: string, max = DNS_LABEL_MAX): string | undefined {
  if (name === "") return "A name is required";
  if (name !== name.trim()) return "A name has no blanks around it";
  if (name.length > max) return `A name has ${max} characters at most`;
  if (!DNS_1035_LABEL.test(name)) {
    return "A name is lowercase letters, digits and dashes, starts with a letter and ends with a letter or a digit";
  }
  return undefined;
}

/** A PostgreSQL identifier the operator can use unquoted: what the forms accept for a database or a role. */
export function identifierError(value: string, what = "A name"): string | undefined {
  if (value === "") return `${what} is required`;
  if (value !== value.trim()) return `${what} has no blanks around it`;
  if (new TextEncoder().encode(value).length > 63) return `${what} has 63 bytes at most`;
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    return `${what} is lowercase letters, digits and underscores, and does not start with a digit`;
  }
  return undefined;
}

const QUANTITY = /^([0-9]+(?:\.[0-9]+)?)(?:[eE]([0-9]+))?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

const DECIMAL_UNITS: Record<string, number> = { m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const BINARY_UNITS: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** The number a Kubernetes quantity stands for (bytes, or cores), or undefined when it is not one. */
export function quantityValue(value: string): number | undefined {
  const match = QUANTITY.exec(value.trim());
  if (!match) return undefined;
  const [, digits, exponent, unit] = match;
  const base = Number(digits) * (exponent ? 10 ** Number(exponent) : 1);
  const factor = unit ? (DECIMAL_UNITS[unit] ?? BINARY_UNITS[unit]) : 1;
  return base * factor;
}

/** A Kubernetes quantity above zero, or why it is not one. Empty is fine when the field is optional. */
export function quantityError(value: string, what = "A quantity", example = "10Gi"): string | undefined {
  if (value.trim() === "") return `${what} is required`;
  const amount = quantityValue(value);
  if (amount === undefined) return `${what} is a Kubernetes quantity such as ${example}`;
  if (amount <= 0) return `${what} is above zero`;
  return undefined;
}

/** A whole number at or above `min`, or why it is not one. */
export function integerError(value: string, what: string, min: number): string | undefined {
  if (value.trim() === "") return `${what} is required`;
  if (!/^[0-9]+$/.test(value.trim())) return `${what} is a whole number`;
  if (Number(value) < min) return `${what} is ${min} or more`;
  return undefined;
}

export interface PostgresMemory {
  bytes: number;
  /** True when the value had no unit: PostgreSQL reads `shared_buffers` in blocks of 8 kB then, and the operator warns. */
  bare: boolean;
}

const PG_MEMORY = /^([0-9]+)\s*(B|kB|MB|GB|TB)?$/;
const PG_MEMORY_UNITS: Record<string, number> = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
/** `shared_buffers` and its kin count in blocks of 8 kB when no unit is given. */
const PG_BLOCK_BYTES = 8 * 1024;

/** A PostgreSQL memory setting (`128MB`, `1GB`, `16384`), or undefined when it is not one. */
export function postgresMemory(value: string): PostgresMemory | undefined {
  const match = PG_MEMORY.exec(value.trim());
  if (!match) return undefined;
  const [, digits, unit] = match;
  return unit
    ? { bytes: Number(digits) * PG_MEMORY_UNITS[unit], bare: false }
    : { bytes: Number(digits) * PG_BLOCK_BYTES, bare: true };
}

/**
 * A container image reference the operator accepts: with a tag that reads as
 * a PostgreSQL version, since the operator refuses `latest` and a digest
 * alone because it could not detect upgrades from them.
 */
export function imageReferenceError(reference: string): string | undefined {
  const value = reference.trim();
  if (value === "") return "An image is required";
  if (/\s/.test(value)) return "An image reference has no blanks";
  const [named, digest] = value.split("@");
  const lastSlash = named.lastIndexOf("/");
  const lastColon = named.lastIndexOf(":");
  const tag = lastColon > lastSlash ? named.slice(lastColon + 1) : undefined;
  if (tag === undefined) {
    return digest
      ? "The operator refuses an image given by its digest alone: it reads the PostgreSQL version from the tag"
      : "An image needs a tag: the operator reads the PostgreSQL version from it";
  }
  if (tag === "latest") return "The operator refuses the tag latest: it could not detect upgrades";
  if (!/^[0-9]+(\.[0-9]+)*([-.][0-9A-Za-z._-]*)?$/.test(tag)) {
    return "The tag must start with the PostgreSQL version, as in 17.2 or 18.4-system-trixie";
  }
  return undefined;
}

/** A timestamp in the layout the API server reads (RFC 3339), or why it is not one. */
export function rfc3339Error(value: string, what = "A time"): string | undefined {
  const text = value.trim();
  if (text === "") return `${what} is required`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return `${what} is written as 2026-09-22T10:30:00Z (RFC 3339)`;
  }
  if (Number.isNaN(Date.parse(text))) return `${what} is not a real date`;
  return undefined;
}

/** The settings the operator fixes itself: setting one is refused by its webhook. */
export const FIXED_POSTGRES_PARAMETERS: readonly string[] = [
  "archive_command",
  "archive_mode",
  "cluster_name",
  "hot_standby",
  "listen_addresses",
  "port",
  "restart_after_crash",
  "shared_preload_libraries",
  "synchronous_standby_names",
  "unix_socket_directories",
];

/** The settings the operator writes on its own into every cluster it defaults (mutating webhook of v1.30.0). */
export const OPERATOR_WRITTEN_PARAMETERS: readonly string[] = [
  "archive_timeout",
  "dynamic_shared_memory_type",
  "full_page_writes",
  "log_destination",
  "log_directory",
  "log_filename",
  "log_rotation_age",
  "log_rotation_size",
  "log_truncate_on_rotation",
  "logging_collector",
  "max_parallel_workers",
  "max_replication_slots",
  "max_worker_processes",
  "shared_memory_type",
  "ssl_max_protocol_version",
  "ssl_min_protocol_version",
  "wal_keep_size",
  "wal_level",
  "wal_log_hints",
  "wal_receiver_timeout",
  "wal_sender_timeout",
];

const PARAMETER_KEY = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

/** A PostgreSQL parameter name the operator lets a cluster set, or why not. */
export function parameterKeyError(key: string): string | undefined {
  if (key === "") return "A parameter needs a name";
  if (!PARAMETER_KEY.test(key)) return "A parameter name is letters, digits and underscores, with at most one dot";
  if (key.startsWith("ssl") || FIXED_POSTGRES_PARAMETERS.includes(key)) {
    return `${key} is fixed by the operator and cannot be set`;
  }
  return undefined;
}

const POSTGRES_BOOLEANS = ["on", "off", "true", "false", "yes", "no", "1", "0"];
const BOOLEAN_PARAMETERS = ["wal_log_hints", "hot_standby_feedback", "sync_replication_slots"];

/** A value the operator's webhook would refuse for this parameter, or undefined. Values it does not check pass. */
export function parameterValueError(key: string, value: string, instances = 1): string | undefined {
  const text = value.trim();
  if (text === "") return "A parameter needs a value";
  if (key === "wal_level") {
    if (!["logical", "replica", "minimal"].includes(text)) return "wal_level is logical, replica or minimal";
    if (text === "minimal" && instances > 1)
      return "wal_level minimal is refused on a cluster of more than one instance";
    return undefined;
  }
  if (key === "shared_buffers") {
    return postgresMemory(text) ? undefined : "shared_buffers is a memory setting such as 256MB";
  }
  if (BOOLEAN_PARAMETERS.includes(key) && !POSTGRES_BOOLEANS.includes(text.toLowerCase())) {
    return `${key} is on or off`;
  }
  if (key === "wal_log_hints" && instances > 1 && ["off", "false", "no", "0"].includes(text.toLowerCase())) {
    return "wal_log_hints must stay on with more than one instance";
  }
  return undefined;
}

export interface KeyValue {
  key: string;
  value: string;
}

/** The rows of a key value editor as the object the body carries; empty rows are dropped, order kept. */
export function keyValueObject(rows: readonly KeyValue[]): Record<string, string> | undefined {
  const entries = rows.filter((row) => row.key.trim() !== "").map((row) => [row.key.trim(), row.value] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The keys that appear more than once, for the error of each of them. */
export function duplicateKeys(rows: readonly KeyValue[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

/** A Kubernetes label or annotation key (`app`, `topology.kubernetes.io/zone`), or why not. */
export function labelKeyError(key: string): string | undefined {
  if (key === "") return "A key is required";
  const [prefix, name] = key.includes("/") ? key.split("/", 2) : [undefined, key];
  if (key.split("/").length > 2) return "A key has at most one slash";
  if (prefix !== undefined && (prefix === "" || objectNameError(prefix)))
    return "The prefix of a key is a DNS subdomain";
  if (!/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(name) || name.length > 63) {
    return "A key name is letters, digits, dashes, underscores and dots, 63 characters at most";
  }
  return undefined;
}

/** A Kubernetes label value, or why not. */
export function labelValueError(value: string): string | undefined {
  if (value === "") return undefined;
  if (!/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value) || value.length > 63) {
    return "A value is letters, digits, dashes, underscores and dots, 63 characters at most";
  }
  return undefined;
}

/** The YAML of the exact body a create sends, in the key order the body was built in. */
export function toYaml(body: unknown): string {
  return dump(body, { noRefs: true, lineWidth: -1, sortKeys: false });
}

/** The verb line of a creation (F2): `create Cluster ns/name`. */
export function createLine(kind: string, namespace: string, name: string, facts: string): string {
  return `create ${kind} ${namespace || "<namespace>"}/${name || "<name>"}${facts ? `: ${facts}` : ""}`;
}

/** The first error of a form, in the order its fields are rendered, for the reason under OK. */
export function firstError(
  order: readonly string[],
  errors: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const key of order) {
    const error = errors[key];
    if (error) return error;
  }
  return undefined;
}

/** The default namespace of a form opened from a page: the one the filter names when it names exactly one. */
export function defaultNamespace(selected: readonly string[]): string {
  return selected.length === 1 ? selected[0] : "";
}

/** A name already in the store warns and never blocks (F5): the store may be partial. */
export function collisionWarning(kind: string, name: string, existing: readonly string[]): string | undefined {
  return name !== "" && existing.includes(name)
    ? `A ${kind} named ${name} already exists in this namespace: the API server will refuse the create`
    : undefined;
}
