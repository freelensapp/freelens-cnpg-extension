/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The server check of every creation form (SPEC-0032): the body the form shows,
// sent with `dryRun=All`, so the API server and the admission webhooks of the
// operator answer before anything exists. Pure: the request is
// `api/writes/dry-run.ts`, the dialog `create-dialog.tsx`.

export type ServerCheckState = "idle" | "checking" | "valid" | "refused" | "unchecked";

export interface ServerCheckCause {
  /** The path the API server names (`spec.postgresql.parameters.min_wal_size`), when it names one. */
  path?: string;
  /** The field of the form that path belongs to, in the words of the form. */
  field?: string;
  message: string;
}

export interface ServerCheck {
  state: ServerCheckState;
  /** The YAML the answer is about: an answer about another YAML is stale. */
  yaml?: string;
  /** The API server's own words. */
  message?: string;
  causes: ServerCheckCause[];
}

export const IDLE_CHECK: ServerCheck = { state: "idle", causes: [] };

interface StatusShape {
  kind?: string;
  code?: number;
  reason?: string;
  message?: string;
  details?: { causes?: Array<{ field?: string; message?: string; reason?: string }> };
}

/** Maps a path of the body to the field of a form; undefined when the form has no field for it. */
export type FieldOf = (path: string) => string | undefined;

/**
 * The answer of a dry run. 2xx is valid; 400, 409 (the name exists) and 422 are a refusal in the API
 * server's words, one cause per path it names; a refused permission, a network failure or another code
 * leaves the form "not checked", which does not block the submit and says so.
 */
export function readServerAnswer(
  status: number,
  body: unknown,
  yaml: string,
  fieldOf: FieldOf = () => undefined,
): ServerCheck {
  if (status >= 200 && status < 300) return { state: "valid", yaml, causes: [] };
  const answer = (body && typeof body === "object" ? body : {}) as StatusShape;
  const message = answer.message?.trim() || undefined;
  if (status === 400 || status === 409 || status === 422) {
    // A name taken (409) comes without causes: it is about the name.
    const taken = status === 409 && !answer.details?.causes?.length;
    const causes = (answer.details?.causes ?? [])
      .filter((cause) => cause.message)
      .map((cause) => {
        const path = cause.field || undefined;
        return { path, field: path ? fieldOf(path) : undefined, message: cause.message ?? "" };
      });
    return {
      state: "refused",
      yaml,
      message: message ?? `The API server answered ${status}`,
      causes:
        causes.length > 0
          ? causes
          : [
              {
                ...(taken ? { path: "metadata.name", field: fieldOf("metadata.name") } : {}),
                message: message ?? `The API server answered ${status}`,
              },
            ],
    };
  }
  const why =
    status === 401 || status === 403
      ? "your account may not ask the API server to check it"
      : status === 0
        ? "the API server did not answer"
        : `the API server answered ${status}`;
  return {
    state: "unchecked",
    yaml,
    message: `Not checked by the API server: ${why}. The create itself will say.`,
    causes: [],
  };
}

/** Why OK waits, or undefined: a form whose YAML the API server has not answered for yet, or refused. */
export function serverCheckBlockReason(check: ServerCheck, yaml: string): string | undefined {
  if (check.state === "idle") return undefined;
  if (check.yaml !== yaml || check.state === "checking") return "Checking the form with the API server";
  if (check.state === "refused") {
    const first = check.causes[0];
    const where = first?.field ?? first?.path;
    return `The API server refuses it${where ? ` (${where})` : ""}: ${first?.message ?? check.message}`;
  }
  return undefined;
}

/** A field map from the first matching prefix of a path: the longest prefixes first. */
export function prefixFieldOf(map: ReadonlyArray<[prefix: string, field: string]>): FieldOf {
  const sorted = [...map].sort((a, b) => b[0].length - a[0].length);
  return (path) =>
    sorted.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))?.[1];
}

/** The fields every creation form has. */
export const COMMON_FIELDS: ReadonlyArray<[prefix: string, field: string]> = [
  ["metadata.name", "Name"],
  ["metadata.namespace", "Namespace"],
  ["spec.cluster", "Cluster"],
];

/** The fields of Create Cluster (SPEC-0025), for the paths the operator's webhook names. */
export const CLUSTER_FIELDS: ReadonlyArray<[prefix: string, field: string]> = [
  ...COMMON_FIELDS,
  ["spec.instances", "Instances"],
  ["spec.imageName", "Image"],
  ["spec.imageCatalogRef", "Image catalog"],
  ["spec.storage", "Storage"],
  ["spec.walStorage", "WAL volume"],
  ["spec.tablespaces", "Tablespaces"],
  ["spec.bootstrap", "Bootstrap"],
  ["spec.externalClusters", "Recovery source"],
  ["spec.plugins", "WAL archiving and backups"],
  ["spec.backup", "Backups"],
  ["spec.superuserSecret", "Superuser"],
  ["spec.enableSuperuserAccess", "Superuser"],
  ["spec.minSyncReplicas", "Synchronous replication"],
  ["spec.maxSyncReplicas", "Synchronous replication"],
  ["spec.postgresql.synchronous", "Synchronous replication"],
  ["spec.postgresql.parameters", "PostgreSQL parameters"],
  ["spec.resources", "Resources"],
  ["spec.primaryUpdateStrategy", "Primary update strategy"],
  ["spec.primaryUpdateMethod", "Primary update method"],
  ["spec.affinity", "Scheduling"],
];
