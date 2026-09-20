/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What every write action of the extension shares, as pure functions and
// types (SPEC-0020, W1 to W12): the guard whose disabled branch cannot be
// mute, the facts a confirmation dialog is built from, the two timestamp
// formats of the upstream tooling, what a failed API call means for the
// user, and the comparison that decides whether a conflict may be retried.
//
// Nothing here emits JSX, reads a store or talks to the cluster.

/**
 * The outcome of a guard (W2). A union on purpose: a disabled control always
 * carries its reason, and this shape makes a mute one a compile error.
 */
export type ActionGuard = { enabled: true; reason?: undefined } | { enabled: false; reason: string };

export const enabledGuard: ActionGuard = { enabled: true };

export function disabledGuard(reason: string): ActionGuard {
  return { enabled: false, reason };
}

/** The first refusal among the guards, or enabled when none refuses. */
export function firstRefusal(...guards: Array<ActionGuard | undefined>): ActionGuard {
  return guards.find((guard) => guard && !guard.enabled) ?? enabledGuard;
}

/** One API call an action will make, in the order it makes them (W4). */
export interface ActionWrite {
  verb: "create" | "patch" | "delete";
  /** The object, the field or annotation and the value transition, as the dialog spells it. */
  text: string;
}

/** The facts a confirmation dialog is built from. The component owns the JSX. */
export interface ActionDialogFacts {
  /** The kind and `namespace/name` the action is about. */
  subject: string;
  /** One line per API call, in order. A write that would change nothing is not here. */
  writes: ActionWrite[];
  /** What the write means for this cluster. */
  notes: string[];
  /** What it costs. */
  warnings: string[];
  /** The name the user must type before OK is enabled (W5), when the action asks for it. */
  typedName?: string;
}

/** W6: a conflict is retried only while the write the user read is still the write that would be sent. */
export function sameWrites(a: readonly ActionWrite[], b: readonly ActionWrite[]): boolean {
  return (
    a.length === b.length && a.every((write, index) => write.verb === b[index].verb && write.text === b[index].text)
  );
}

/** How many times a conflict is retried before the dialog reopens (W6). */
export const CONFLICT_ATTEMPTS = 3;

/**
 * How long to wait before reopening a dialog the host has just closed: inside
 * the leave window of the host's dialog animation a reopened dialog stays
 * invisible and still intercepts every click.
 */
export const DIALOG_REOPEN_DELAY_MS = 250;

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function utcDateTime(now: Date): string {
  return (
    `${pad(now.getUTCFullYear(), 4)}-${pad(now.getUTCMonth() + 1, 2)}-${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}:${pad(now.getUTCMinutes(), 2)}:${pad(now.getUTCSeconds(), 2)}`
  );
}

/** RFC 3339 to the second, in UTC: the value of `kubectl.kubernetes.io/restartedAt`. */
export function rfc3339Seconds(now: Date): string {
  return `${utcDateTime(now)}Z`;
}

/**
 * RFC 3339 with exactly six fractional digits, in UTC: the layout the
 * upstream tooling writes and parses for `targetPrimaryTimestamp` and
 * `cnpg.io/reloadedAt`. A `Date` knows milliseconds: the last three are zeros.
 */
export function rfc3339Micro(now: Date): string {
  return `${utcDateTime(now)}.${pad(now.getUTCMilliseconds(), 3)}000Z`;
}

/** `20260920171500`: the suffix of a backup name, in UTC. */
export function compactTimestamp(now: Date): string {
  return utcDateTime(now).replace(/[-:T]/g, "");
}

interface ReplicaFacts {
  name: string;
  spec?: { replica?: { enabled?: boolean; primary?: string; self?: string } };
}

/**
 * W11: a cluster that follows another one. Either the standalone form
 * (`enabled`), or the distributed topology where `primary` names another
 * cluster than this one.
 */
export function isReplicaCluster(cluster: ReplicaFacts): boolean {
  const replica = cluster.spec?.replica;
  if (!replica) return false;
  if (replica.enabled === true) return true;
  if (replica.enabled === false) return false;
  const self = replica.self?.trim() || cluster.name;
  const primary = replica.primary?.trim();
  return Boolean(primary) && primary !== self;
}

export const REPLICA_CLUSTER_REASON =
  "This cluster follows another one: here the same write would only move the designated primary";

/** What a failed API call was, as far as the error tells. */
export interface ApiFailureFacts {
  /** HTTP status, when there was an answer. */
  code?: number;
  /** The message of the API server, as it came. */
  message?: string;
  /** Kubernetes `reason` of the Status object (`AlreadyExists`, `Conflict`, ...). */
  reason?: string;
  /**
   * True when the host has already shown this error: it toasts every 403 of
   * its Kubernetes API client itself and marks the error, so a second
   * notification from the extension would be a duplicate.
   */
  alreadyNotified?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Reads a caught error without assuming its class. The host's Kubernetes
 * client rejects with an object that is not an `Error`: it carries the parsed
 * `Status` of the API server in `error`, its `toString()` is the message, and
 * `isUsedForNotification` says the host has toasted it. The status write
 * module of the extension throws `ApiFailureFacts` itself. Anything else
 * reports what it can instead of throwing in the error path.
 */
export function apiFailureFacts(error: unknown): ApiFailureFacts {
  if (typeof error === "string") return { message: error };
  const record = asRecord(error);
  if (!record) return {};
  const status = asRecord(record.error) ?? asRecord(record.data) ?? asRecord(record.body);
  const printed = String(error);
  return {
    code: firstNumber(status?.code, record.code, record.status, record.statusCode),
    message: firstString(status?.message, record.message, printed.startsWith("[object") ? undefined : printed),
    reason: firstString(status?.reason, record.reason),
    alreadyNotified: record.isUsedForNotification === true || record.alreadyNotified === true,
  };
}

export function isConflict(failure: ApiFailureFacts): boolean {
  return failure.code === 409 && failure.reason !== "AlreadyExists";
}

export function isAlreadyExists(failure: ApiFailureFacts): boolean {
  return failure.code === 409 && failure.reason === "AlreadyExists";
}

/** What the write was, for the sentence of a refusal. */
export interface AttemptedWrite {
  verb: "create" | "patch" | "delete";
  /** `clusters`, `clusters/status`, `backups`, `pods`, ... */
  resource: string;
  namespace: string;
}

const WEBHOOK_HINTS = ["failed calling webhook", "failed to call webhook", "no endpoints available for service"];

/** True when the API server could not reach an admission webhook (`failurePolicy: Fail`). */
export function isWebhookUnreachable(failure: ApiFailureFacts): boolean {
  const message = failure.message?.toLowerCase() ?? "";
  return WEBHOOK_HINTS.some((hint) => message.includes(hint));
}

/**
 * W9: the sentences around the API server's own message. The message itself
 * always follows as it came, because the webhook names the offending field.
 */
export function failureSentence(failure: ApiFailureFacts, attempted: AttemptedWrite): string {
  const said = failure.message ? ` The API server said: ${failure.message}` : "";
  if (failure.code === 403) {
    return `Your account may not ${attempted.verb} ${attempted.resource} in ${attempted.namespace}.${said}`;
  }
  if (failure.code === 404) {
    return `The object is gone: nothing was written.${said}`;
  }
  if (isWebhookUnreachable(failure)) {
    return `The admission webhook of the operator did not answer, so the API server refused the write. The operator may be down: see the Operator page.${said}`;
  }
  if (isConflict(failure)) {
    return `The object kept changing while the write was sent: nothing was written. Try again.${said}`;
  }
  if (failure.code === 422) {
    return `The API server refused the write as invalid.${said}`;
  }
  if (failure.code === undefined) {
    return `The request did not reach the API server.${said}`;
  }
  return `The API server answered ${failure.code}.${said}`;
}

/** `Cluster cnpg-e2e/e2e-main`: the subject line of every dialog (W4). */
export function subjectOf(kind: string, namespace: string, name: string): string {
  return `${kind} ${namespace}/${name}`;
}

/** True when the typed text confirms the action (W5). Surrounding blanks are forgiven, case is not. */
export function typedNameMatches(typed: string, expected: string | undefined): boolean {
  return expected === undefined || typed.trim() === expected;
}
