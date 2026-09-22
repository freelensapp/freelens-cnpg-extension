/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The decisions of the Create DatabaseRole form (SPEC-0027): the reserved
// and the taken names, how the role authenticates, its attributes and its
// memberships, the SQL the operator will run said in words, and the exact
// body of the one `create`. Pure.

import { CNPG_API_VERSION } from "../api/cnpg/cluster-v1";
import {
  collisionWarning,
  createLine,
  firstError,
  identifierError,
  objectNameError,
  rfc3339Error,
} from "./create-forms";
import { clusterStateWarning, reclaimSentence, roleNameError } from "./declarative-create";
import { subjectOf } from "./write-actions";

import type { DeclarativeClusterChoice, ReadState, ReclaimChoice } from "./declarative-create";
import type { ActionDialogFacts } from "./write-actions";

export interface RoleClusterChoice extends DeclarativeClusterChoice {
  /** The names of `spec.managed.roles`: the inline entry always wins on the same name. */
  managedRoles: string[];
  /** The roles the extension knows of the cluster, for the memberships. */
  roles: string[];
}

export interface ExistingRole {
  objectName: string;
  cluster: string;
  name: string;
}

export interface RoleSecretChoice {
  name: string;
  type?: string;
  username?: string;
}

export interface DatabaseRoleInputs {
  clusters: RoleClusterChoice[];
  roles: ExistingRole[];
  secrets: RoleSecretChoice[];
  reads: Record<"clusters" | "roles" | "secrets", ReadState>;
}

export function emptyDatabaseRoleInputs(): DatabaseRoleInputs {
  return { clusters: [], roles: [], secrets: [], reads: { clusters: "loading", roles: "loading", secrets: "loading" } };
}

export type RoleAuth = "secret" | "none" | "untouched";

export interface DatabaseRoleForm {
  namespace: string;
  name: string;
  cluster: string;
  roleName: string;
  auth: RoleAuth;
  passwordSecret: string;
  login: boolean;
  clientCertificate: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  inherit: boolean;
  connectionLimit: string;
  validUntil: string;
  inRoles: string[];
  comment: string;
  reclaim: ReclaimChoice;
}

export function defaultDatabaseRoleForm(namespace: string, cluster = ""): DatabaseRoleForm {
  return {
    namespace,
    name: "",
    cluster,
    roleName: "",
    auth: "secret",
    passwordSecret: "",
    login: true,
    clientCertificate: false,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    inherit: true,
    connectionLimit: "",
    validUntil: "",
    inRoles: [],
    comment: "",
    reclaim: "retain",
  };
}

/** The PostgreSQL built in roles a membership can name. */
export const BUILTIN_ROLES: readonly string[] = [
  "pg_read_all_data",
  "pg_write_all_data",
  "pg_read_all_settings",
  "pg_read_all_stats",
  "pg_stat_scan_tables",
  "pg_monitor",
  "pg_database_owner",
  "pg_signal_backend",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "pg_checkpoint",
  "pg_maintain",
  "pg_use_reserved_connections",
  "pg_create_subscription",
];

export function pickedRoleCluster(inputs: DatabaseRoleInputs, form: DatabaseRoleForm): RoleClusterChoice | undefined {
  return inputs.clusters.find((cluster) => cluster.name === form.cluster);
}

export const ROLE_FIELD_ORDER: readonly string[] = [
  "namespace",
  "cluster",
  "name",
  "roleName",
  "passwordSecret",
  "clientCertificate",
  "connectionLimit",
  "validUntil",
  "inRoles",
];

export function databaseRoleErrors(inputs: DatabaseRoleInputs, form: DatabaseRoleForm): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, error: string | undefined) => {
    if (error) errors[key] = error;
  };
  if (form.namespace === "") errors.namespace = "A namespace is required";
  if (form.cluster === "") errors.cluster = "Pick a cluster";
  put("name", objectNameError(form.name));
  put("roleName", roleNameError(form.roleName));
  const cluster = pickedRoleCluster(inputs, form);
  if (!errors.roleName && cluster && cluster.managedRoles.includes(form.roleName)) {
    errors.roleName = `${form.roleName} is declared in the managed roles of ${cluster.name}: the inline entry always wins, and this object would never be applied`;
  }
  if (form.auth === "secret" && form.passwordSecret.trim() === "")
    errors.passwordSecret = "Pick the secret that holds the password";
  if (form.clientCertificate && !form.login)
    errors.clientCertificate = "A client certificate needs a role that can log in";
  if (form.connectionLimit.trim() !== "" && form.connectionLimit.trim() !== "-1") {
    if (!/^[0-9]+$/.test(form.connectionLimit.trim()))
      errors.connectionLimit = "The connection limit is a whole number, -1 for no limit";
  }
  if (form.validUntil.trim() !== "") put("validUntil", rfc3339Error(form.validUntil, "The validity"));
  const seen = new Set<string>();
  form.inRoles.forEach((role, index) => {
    const error = identifierError(role.trim(), "A role");
    if (error) errors[`inRoles.${index}`] = error;
    else if (seen.has(role.trim())) errors[`inRoles.${index}`] = `${role.trim()} is listed twice`;
    else if (role.trim() === form.roleName) errors[`inRoles.${index}`] = "A role cannot be a member of itself";
    seen.add(role.trim());
  });
  if (Object.keys(errors).some((key) => key.startsWith("inRoles."))) errors.inRoles = "A membership is wrong";
  return errors;
}

export function databaseRoleWarnings(inputs: DatabaseRoleInputs, form: DatabaseRoleForm): Record<string, string> {
  const warnings: Record<string, string> = {};
  const collision = collisionWarning(
    "role object",
    form.name,
    inputs.roles.map((role) => role.objectName),
  );
  if (collision) warnings.name = collision;
  const cluster = pickedRoleCluster(inputs, form);
  if (form.cluster !== "" && inputs.reads.clusters === "ready" && !cluster) {
    warnings.cluster = `No cluster named ${form.cluster} was found in the namespace: nothing reconciles the object until it runs`;
  }
  const rival = inputs.roles.find(
    (role) => role.cluster === form.cluster && role.name === form.roleName && role.objectName !== form.name,
  );
  if (rival && form.roleName !== "") {
    warnings.roleName = `${rival.objectName} already declares the role ${form.roleName} on ${form.cluster}: the operator applies the first and fails the second`;
  }
  if (form.auth === "secret" && form.passwordSecret.trim() !== "" && inputs.reads.secrets === "ready") {
    const secret = inputs.secrets.find((candidate) => candidate.name === form.passwordSecret.trim());
    if (!secret)
      warnings.passwordSecret = `No secret named ${form.passwordSecret.trim()} was found: the role gets no password until it exists`;
    else if (secret.type && secret.type !== "kubernetes.io/basic-auth") {
      warnings.passwordSecret = `${secret.name} is a ${secret.type} secret: the operator expects kubernetes.io/basic-auth`;
    } else if (secret.username !== undefined && form.roleName !== "" && secret.username !== form.roleName) {
      warnings.passwordSecret = `${secret.name} carries the username ${secret.username}, not ${form.roleName}: the operator wants them equal`;
    }
  }
  if (cluster) {
    const known = [...cluster.roles, ...BUILTIN_ROLES];
    const unknown = form.inRoles.map((role) => role.trim()).filter((role) => role !== "" && !known.includes(role));
    if (unknown.length > 0)
      warnings.inRoles = `No role named ${unknown.join(", ")} is known for ${cluster.name}: a missing group fails the object`;
  }
  return warnings;
}

export function databaseRoleBody(form: DatabaseRoleForm): Record<string, unknown> {
  const spec: Record<string, unknown> = { cluster: { name: form.cluster }, name: form.roleName };
  if (form.comment.trim() !== "") spec.comment = form.comment.trim();
  if (form.login) spec.login = true;
  if (form.superuser) spec.superuser = true;
  if (form.createdb) spec.createdb = true;
  if (form.createrole) spec.createrole = true;
  if (form.replication) spec.replication = true;
  if (form.bypassrls) spec.bypassrls = true;
  if (!form.inherit) spec.inherit = false;
  if (form.connectionLimit.trim() !== "") spec.connectionLimit = Number(form.connectionLimit);
  if (form.validUntil.trim() !== "") spec.validUntil = form.validUntil.trim();
  const inRoles = form.inRoles.map((role) => role.trim()).filter((role) => role !== "");
  if (inRoles.length > 0) spec.inRoles = inRoles;
  if (form.auth === "secret" && form.passwordSecret.trim() !== "")
    spec.passwordSecret = { name: form.passwordSecret.trim() };
  if (form.auth === "none") spec.disablePassword = true;
  if (form.clientCertificate) spec.clientCertificate = { enabled: true };
  if (form.reclaim !== "retain") spec.databaseRoleReclaimPolicy = form.reclaim;
  return {
    apiVersion: CNPG_API_VERSION,
    kind: "DatabaseRole",
    metadata: { name: form.name, namespace: form.namespace },
    spec,
  };
}

function attributeWords(form: DatabaseRoleForm): string {
  const words: string[] = [];
  words.push(form.login ? "LOGIN" : "NOLOGIN");
  if (form.superuser) words.push("SUPERUSER");
  if (form.createdb) words.push("CREATEDB");
  if (form.createrole) words.push("CREATEROLE");
  if (form.replication) words.push("REPLICATION");
  if (form.bypassrls) words.push("BYPASSRLS");
  if (!form.inherit) words.push("NOINHERIT");
  if (form.connectionLimit.trim() !== "") words.push(`CONNECTION LIMIT ${form.connectionLimit.trim()}`);
  if (form.validUntil.trim() !== "") words.push(`VALID UNTIL '${form.validUntil.trim()}'`);
  const inRoles = form.inRoles.map((role) => role.trim()).filter((role) => role !== "");
  if (inRoles.length > 0) words.push(`IN ROLE ${inRoles.join(", ")}`);
  return words.join(" ");
}

export function databaseRoleNotes(form: DatabaseRoleForm): string[] {
  const notes = [
    `The primary of ${form.cluster || "<cluster>"} runs CREATE ROLE ${form.roleName || "<name>"} WITH ${attributeWords(form)}.`,
  ];
  if (form.auth === "secret") {
    notes.push(
      `The password comes from the secret ${form.passwordSecret || "<secret>"} (kubernetes.io/basic-auth, username equal to the role); the operator keeps the role's password in step with it.`,
    );
  } else if (form.auth === "none") {
    notes.push("The role has no password: it connects with a certificate, or through a trust or peer rule of pg_hba.");
  } else {
    notes.push("The operator never touches the password: a new role gets none, an adopted role keeps its own.");
  }
  if (form.clientCertificate) {
    notes.push(
      `The operator issues a client certificate in the secret ${form.name || "<name>"}-client-cert and renews it; pg_hba needs a hostssl cert rule for it.`,
    );
  }
  if (form.comment.trim() !== "") notes.push(`COMMENT ON ROLE: ${form.comment.trim()}`);
  notes.push(reclaimSentence("DatabaseRole", "role", form.reclaim));
  return notes;
}

export function databaseRoleSummaryWarnings(inputs: DatabaseRoleInputs, form: DatabaseRoleForm): string[] {
  const warnings: string[] = [];
  const state = clusterStateWarning(pickedRoleCluster(inputs, form), form.cluster, inputs.reads.clusters);
  if (state) warnings.push(state);
  if (form.superuser) warnings.push("A superuser bypasses every permission check.");
  if (form.replication) warnings.push("REPLICATION lets the role stream the whole cluster.");
  if (form.login && form.auth !== "secret" && !form.clientCertificate) {
    warnings.push("The role can log in but has no password and no certificate: it cannot connect by password.");
  }
  if (
    form.validUntil.trim() !== "" &&
    !rfc3339Error(form.validUntil) &&
    Date.parse(form.validUntil.trim()) < Date.now()
  ) {
    warnings.push("The validity is already past: the role cannot log in.");
  }
  if (form.reclaim === "delete")
    warnings.push(
      "With the delete policy the role is dropped when the object is deleted, which fails while it owns objects.",
    );
  return warnings;
}

export function databaseRoleFacts(inputs: DatabaseRoleInputs, form: DatabaseRoleForm): ActionDialogFacts {
  return {
    subject: subjectOf("DatabaseRole", form.namespace || "<namespace>", form.name || "<name>"),
    writes: [
      {
        verb: "create",
        text: createLine(
          "DatabaseRole",
          form.namespace,
          form.name,
          `role ${form.roleName || "?"} on ${form.cluster || "?"}, ${form.login ? "can log in" : "cannot log in"}`,
        ),
      },
    ],
    notes: databaseRoleNotes(form),
    warnings: databaseRoleSummaryWarnings(inputs, form),
  };
}

export function databaseRoleBlockReason(
  inputs: DatabaseRoleInputs,
  form: DatabaseRoleForm,
  accessReason?: string,
): string | undefined {
  return firstError(ROLE_FIELD_ORDER, databaseRoleErrors(inputs, form)) ?? accessReason;
}

export function databaseRoleSuccessMessage(namespace: string, name: string): string {
  return `Requested the role object ${namespace}/${name}: the primary of its cluster applies it now`;
}
