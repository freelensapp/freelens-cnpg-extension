/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Pure model of the declared roles (SPEC-0014): what a role may do, how it
// authenticates and until when, the role of the cluster spec that wins over
// it, and the inline roles of a cluster as the operator reports them. The
// extension knows the names of the Secrets involved and nothing of their
// content.

import { clientCertificateSecretName } from "../api/cnpg/database-role-v1";
import { humanizeRelative } from "./backup-health";
import { classifyDeclarative, declarativeHealth } from "./declarative";
import { parseGoTime } from "./go-time";

import type { Cluster } from "../api/cnpg/cluster-v1";
import type { DatabaseRole, RoleConfiguration } from "../api/cnpg/database-role-v1";
import type { HostStatusClass } from "./cluster-health";
import type { ClusterLookup, DeclarativeHealth } from "./declarative";

export interface RoleAttribute {
  label: string;
  /** Attributes that override every restriction are shown in the warning class. */
  className?: HostStatusClass;
  tooltip: string;
}

/** The attributes the role is granted, in a fixed order; "No inherit" only when inheritance is off. */
export function roleAttributes(role: RoleConfiguration | undefined): RoleAttribute[] {
  const attributes: RoleAttribute[] = [];
  if (role?.login) attributes.push({ label: "Login", tooltip: "The role can log in: it is a user" });
  if (role?.superuser) {
    attributes.push({
      label: "Superuser",
      className: "warning",
      tooltip: "Overrides every access restriction in the database",
    });
  }
  if (role?.createdb) attributes.push({ label: "Create database", tooltip: "May create new databases" });
  if (role?.createrole) {
    attributes.push({ label: "Create role", tooltip: "May create, alter and drop other roles" });
  }
  if (role?.replication) {
    attributes.push({ label: "Replication", tooltip: "May open replication connections, physical and logical" });
  }
  if (role?.bypassrls) {
    attributes.push({
      label: "Bypass RLS",
      className: "warning",
      tooltip: "Bypasses every row-level security policy",
    });
  }
  if (role?.inherit === false) {
    attributes.push({ label: "No inherit", tooltip: "Does not inherit the privileges of the roles it is a member of" });
  }
  return attributes;
}

export function roleAttributeWords(role: RoleConfiguration | undefined): string {
  const attributes = roleAttributes(role);
  return attributes.length === 0 ? "None (a group role)" : attributes.map((attribute) => attribute.label).join(", ");
}

export type PasswordSource = "secret" | "disabled" | "unmanaged";

export interface PasswordFacts {
  source: PasswordSource;
  secretName?: string;
  /** The source with the name of the Secret, for tooltips and the search. */
  words: string;
  validUntil?: Date;
  expired: boolean;
}

export function passwordFacts(role: RoleConfiguration | undefined, now: Date = new Date()): PasswordFacts {
  const validUntil = parseGoTime(role?.validUntil);
  const expired = Boolean(validUntil && validUntil.getTime() <= now.getTime());
  if (role?.disablePassword) {
    return { source: "disabled", words: "Disabled", validUntil, expired: false };
  }
  const secretName = role?.passwordSecret?.name || undefined;
  if (secretName) {
    return { source: "secret", secretName, words: `Secret ${secretName}`, validUntil, expired };
  }
  return { source: "unmanaged", words: "Not managed", validUntil, expired };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A distance in time at the grain a person reads an expiry at: years beyond
 * two, months beyond one year, whole days beyond two days, then as precise as
 * the rest of the extension.
 */
export function coarseRelative(target: Date, now: Date): string {
  const delta = target.getTime() - now.getTime();
  const days = Math.abs(delta) / DAY_MS;
  let span: string;
  if (days >= 730) span = `${Math.floor(days / 365.25)} years`;
  else if (days >= 365) span = `${Math.floor(days / 30.44)} months`;
  else if (days >= 2) span = `${Math.floor(days)}d`;
  else return humanizeRelative(target, now);
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

/** "in 8 years", "20 months ago", "Never" for a password without `validUntil`. */
export function expiryWords(facts: PasswordFacts, now: Date = new Date()): string {
  return facts.validUntil ? coarseRelative(facts.validUntil, now) : "Never";
}

/** The operator renews a client certificate once it is this close to its expiry (its default). */
export const CLIENT_CERTIFICATE_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ClientCertificateState = "off" | "pending" | "ok" | "renewing" | "expired";

export interface ClientCertificateFacts {
  state: ClientCertificateState;
  secretName?: string;
  expiresAt?: Date;
  message?: string;
  words: string;
}

export function certificateFacts(role: DatabaseRole, now: Date = new Date()): ClientCertificateFacts {
  const declared = role.spec?.clientCertificate;
  const message = role.status?.clientCertificate?.message?.trim() || undefined;
  if (!declared || declared.enabled === false) {
    return { state: "off", message, words: "Not issued: the role declares no client certificate" };
  }
  const secretName = clientCertificateSecretName(role.metadata?.name ?? "");
  const expiresAt = parseGoTime(role.status?.clientCertificate?.expiration);
  if (!expiresAt) {
    return { state: "pending", secretName, message, words: message ?? "Not issued yet" };
  }
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) {
    return {
      state: "expired",
      secretName,
      expiresAt,
      message,
      words: `Expired ${coarseRelative(expiresAt, now)}: the operator should have renewed it`,
    };
  }
  return {
    state: remaining < CLIENT_CERTIFICATE_RENEWAL_WINDOW_MS ? "renewing" : "ok",
    secretName,
    expiresAt,
    message,
    words:
      remaining < CLIENT_CERTIFICATE_RENEWAL_WINDOW_MS
        ? `Expires ${coarseRelative(expiresAt, now)}: the operator renews it in its last 7 days`
        : `Expires ${coarseRelative(expiresAt, now)}`,
  };
}

/** The roles a cluster declares inline, in `spec.managed.roles`. */
export function inlineRoleSpecs(cluster: Cluster | undefined): RoleConfiguration[] {
  const roles = (cluster?.spec?.managed as { roles?: unknown } | undefined)?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is RoleConfiguration => typeof role?.name === "string" && role.name !== "");
}

/** The inline role with the same PostgreSQL name: the cluster spec wins over a DatabaseRole. */
export function inlineRival(role: DatabaseRole, cluster: Cluster | undefined): RoleConfiguration | undefined {
  return inlineRoleSpecs(cluster).find((inline) => inline.name === role.spec?.name);
}

export function roleHealth(role: DatabaseRole, lookup: ClusterLookup, now: Date = new Date()): DeclarativeHealth {
  const policy = role.spec?.databaseRoleReclaimPolicy;
  const base = classifyDeclarative(role, lookup, { what: "role", reclaimPolicy: policy });

  if (
    base.state === "Failed" &&
    (inlineRival(role, lookup.cluster) || /managed by the CNPG cluster/i.test(base.reason))
  ) {
    return declarativeHealth(
      "Failed",
      "Ignored: the cluster spec declares the same role in managed.roles, and the cluster spec wins",
    );
  }
  if (base.state === "Deleting" && policy === "delete") {
    return declarativeHealth(
      "Deleting",
      `${base.reason}. A role that owns objects cannot be dropped until they are reassigned or dropped`,
    );
  }
  if (base.state === "Applied") {
    const password = passwordFacts(role.spec, now);
    if (password.expired && password.validUntil && role.spec?.login) {
      return {
        ...declarativeHealth(
          "Applied",
          `Applied, but the password expired ${coarseRelative(password.validUntil, now)}: the role cannot log in with it`,
        ),
        className: "warning",
      };
    }
    const certificate = certificateFacts(role, now);
    if (certificate.state === "expired") {
      return {
        ...declarativeHealth("Applied", `Applied, but the client certificate: ${certificate.words}`),
        className: "warning",
      };
    }
  }
  return base;
}

export type InlineRoleState = "reconciled" | "pending-reconciliation" | "not-managed" | "reserved" | string;

export interface InlineRole {
  name: string;
  status: InlineRoleState;
  /** Why the operator cannot reconcile it, when it says so. */
  reasons: string[];
  className: HostStatusClass;
}

const INLINE_ORDER: readonly string[] = ["pending-reconciliation", "reconciled", "not-managed", "reserved"];

/**
 * The roles of `status.managedRolesStatus`, the ones PostgreSQL has and the
 * cluster spec does not declare included: stuck ones first, the platform's
 * own last.
 */
export function inlineRoles(cluster: Cluster | undefined): InlineRole[] {
  const status = cluster?.status?.managedRolesStatus;
  const cannot = status?.cannotReconcile ?? {};
  const roles: InlineRole[] = [];
  for (const [state, names] of Object.entries(status?.byStatus ?? {})) {
    for (const name of names ?? []) {
      const reasons = cannot[name] ?? [];
      roles.push({
        name,
        status: state,
        reasons,
        className: reasons.length > 0 ? "error" : state === "reconciled" ? "success" : "info",
      });
    }
  }
  for (const [name, reasons] of Object.entries(cannot)) {
    if (!roles.some((role) => role.name === name)) {
      roles.push({ name, status: "pending-reconciliation", reasons: reasons ?? [], className: "error" });
    }
  }
  const rank = (state: string) => {
    const index = INLINE_ORDER.indexOf(state);
    return index === -1 ? INLINE_ORDER.length : index;
  };
  return roles.sort(
    (a, b) =>
      Number(b.reasons.length > 0) - Number(a.reasons.length > 0) ||
      rank(a.status) - rank(b.status) ||
      a.name.localeCompare(b.name),
  );
}

/** The inline roles that are declared in the cluster spec, not the ones PostgreSQL merely has. */
export function declaredInlineRoles(cluster: Cluster | undefined): InlineRole[] {
  const declared = new Set(inlineRoleSpecs(cluster).map((role) => role.name));
  return inlineRoles(cluster).filter((role) => declared.has(role.name));
}

const INLINE_WORDS: Record<string, string> = {
  reconciled: "reconciled",
  "pending-reconciliation": "waiting to be reconciled",
  "not-managed": "in PostgreSQL, not declared",
  reserved: "reserved for the operator",
};

export function inlineStatusWords(role: InlineRole): string {
  if (role.reasons.length > 0) return `cannot be reconciled: ${role.reasons[0]}`;
  return INLINE_WORDS[role.status] ?? role.status;
}
