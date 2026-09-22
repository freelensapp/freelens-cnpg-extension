/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create DatabaseRole dialog (SPEC-0027): the host wiring around the
// pure decisions of `database-role-create.ts`. It reads on open the
// clusters, the DatabaseRole objects and the basic-auth secrets of the
// namespace, renders the fields and sends the one `create` whose YAML the
// user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import {
  CheckboxField,
  CollapsibleSection,
  Field,
  Inline,
  ObjectPicker,
  openCreateDialog,
  RadioField,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import {
  BUILTIN_ROLES,
  databaseRoleBlockReason,
  databaseRoleBody,
  databaseRoleErrors,
  databaseRoleFacts,
  databaseRoleSuccessMessage,
  databaseRoleWarnings,
  defaultDatabaseRoleForm,
  emptyDatabaseRoleInputs,
} from "./database-role-create";
import { listClusterFacts, NamespaceAndClusterFields, ReclaimField, readInto, runCreate } from "./declarative-dialog";

import type { ActionDialogModel } from "./action-dialog";
import type { DatabaseRoleForm, DatabaseRoleInputs, ExistingRole, RoleSecretChoice } from "./database-role-create";
import type { DeclarativeClusterFacts } from "./declarative-facts";

const { observer } = MobxReact;
const {
  Component: { EditableList },
  K8sApi: { namespaceStore, secretsApi },
} = Renderer;

const TITLE = "Create database role";
const TEST_ID = "cnpg-create-role";
const BASIC_AUTH = "kubernetes.io/basic-auth";

interface RoleCreateModel extends ActionDialogModel {
  form: DatabaseRoleForm;
  inputs: DatabaseRoleInputs;
  clusterFacts: DeclarativeClusterFacts[];
  open: { privileges: boolean };
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function derive(model: RoleCreateModel): void {
  Mobx.runInAction(() => {
    model.inputs = {
      ...model.inputs,
      clusters: model.clusterFacts.map((facts) => ({
        ...facts,
        roles: [
          ...new Set([
            facts.bootstrapOwner,
            ...facts.managedRoles,
            ...model.inputs.roles.filter((role) => role.cluster === facts.name).map((role) => role.name),
          ]),
        ],
      })),
    };
  });
}

function createModel(
  namespace: string,
  cluster: string | undefined,
  fixedNamespace: string | undefined,
): RoleCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultDatabaseRoleForm(namespace, cluster ?? ""),
      inputs: emptyDatabaseRoleInputs(),
      clusterFacts: [],
      open: { privileges: false },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
      fixedCluster: cluster,
    },
    { inputs: Mobx.observable.ref, clusterFacts: Mobx.observable.ref },
  );
}

function update(model: RoleCreateModel, patch: Partial<DatabaseRoleForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

interface SecretLike {
  getName(): string;
  type?: string;
  data?: Record<string, string>;
}

function decode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return atob(value);
  } catch {
    return undefined;
  }
}

function loadNamespaced(model: RoleCreateModel, namespace: string): void {
  if (namespace === "") return;
  void readInto<DeclarativeClusterFacts, DatabaseRoleInputs>(
    model,
    "clusters",
    () => listClusterFacts(namespace),
    (facts) => {
      Mobx.runInAction(() => {
        model.clusterFacts = facts;
      });
      return {};
    },
  ).then(() => derive(model));
  void readInto<DatabaseRole, DatabaseRoleInputs>(
    model,
    "roles",
    () => DatabaseRole.getStore<DatabaseRole>().api.list({ namespace }),
    (items) => ({
      roles: items.map(
        (item): ExistingRole => ({
          objectName: item.getName(),
          cluster: item.spec?.cluster?.name ?? "",
          name: item.spec?.name ?? "",
        }),
      ),
    }),
  ).then(() => derive(model));
  void readInto<SecretLike, DatabaseRoleInputs>(
    model,
    "secrets",
    () => secretsApi.list({ namespace }) as unknown as Promise<SecretLike[] | null>,
    (items) => ({
      secrets: items
        .filter((item) => item.type === BASIC_AUTH)
        .map(
          (item): RoleSecretChoice => ({
            name: item.getName(),
            type: item.type,
            username: decode(item.data?.username),
          }),
        ),
    }),
  );
}

function askAccess(model: RoleCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "databaseroles", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

const RoleCreateForm = observer(({ model }: { model: RoleCreateModel }) => {
  const { form, inputs } = model;
  const errors = databaseRoleErrors(inputs, form);
  const warnings = databaseRoleWarnings(inputs, form);
  const cluster = inputs.clusters.find((candidate) => candidate.name === form.cluster);
  const knownRoles = [...(cluster?.roles ?? []), ...BUILTIN_ROLES];
  const privileges: Array<
    [
      keyof Pick<DatabaseRoleForm, "superuser" | "createdb" | "createrole" | "replication" | "bypassrls" | "inherit">,
      string,
      string,
    ]
  > = [
    ["superuser", "Superuser", "Bypasses every permission check."],
    ["createdb", "Can create databases", ""],
    ["createrole", "Can create roles", ""],
    [
      "replication",
      "Replication",
      "Can stream the whole cluster and manage slots: what a logical replication publisher needs.",
    ],
    ["bypassrls", "Bypasses row level security", ""],
    ["inherit", "Inherits the privileges of its groups", "Off, the role must SET ROLE to use them."],
  ];
  return (
    <>
      <NamespaceAndClusterFields
        testId={TEST_ID}
        namespace={form.namespace}
        cluster={form.cluster}
        fixedNamespace={model.fixedNamespace}
        fixedCluster={model.fixedCluster}
        clusters={model.clusterFacts}
        clustersRead={inputs.reads.clusters}
        typing={Boolean(model.typing.cluster)}
        onTyping={(typing) => {
          Mobx.runInAction(() => {
            model.typing.cluster = typing;
          });
        }}
        onNamespace={(namespace) => {
          update(model, { namespace, cluster: "" });
          loadNamespaced(model, namespace);
          askAccess(model, namespace);
        }}
        onCluster={(picked) => update(model, { cluster: picked })}
        errors={errors}
        warnings={warnings}
      />
      <Inline>
        <TextField
          label="Object name"
          value={form.name}
          onChange={(name) => update(model, { name })}
          placeholder={form.cluster && form.roleName ? `${form.cluster}-${form.roleName}` : "pg-reporting"}
          inputTestId={`${TEST_ID}-name`}
          testId={`${TEST_ID}-name-field`}
          hint="The Kubernetes name of the DatabaseRole object."
          error={errors.name}
          warning={warnings.name}
        />
        <TextField
          label="Role"
          value={form.roleName}
          onChange={(roleName) => update(model, { roleName })}
          placeholder="reporting"
          inputTestId={`${TEST_ID}-role-name`}
          testId={`${TEST_ID}-role-name-field`}
          hint="The PostgreSQL name: lowercase, cannot change later. postgres, streaming_replica, pg_ and cnpg_ are reserved."
          error={errors.roleName}
          warning={warnings.roleName}
        />
      </Inline>
      <RadioField
        label="Authentication"
        name={`${TEST_ID}-auth`}
        value={form.auth}
        onChange={(auth) => update(model, { auth })}
        testId={`${TEST_ID}-auth`}
        choices={[
          {
            value: "secret",
            label: "A password from a secret",
            hint: "A kubernetes.io/basic-auth secret whose username is the role; the operator keeps the password in step with it.",
          },
          {
            value: "none",
            label: "No password",
            hint: "The role connects with a certificate, or through a trust or peer rule of pg_hba.",
          },
          {
            value: "untouched",
            label: "Leave the password alone",
            hint: "The operator never touches it: a new role gets none, an adopted role keeps its own.",
          },
        ]}
      />
      {form.auth === "secret" ? (
        <ObjectPicker
          id={`${TEST_ID}-password-secret`}
          inputTestId={`${TEST_ID}-password-secret-input`}
          label="Password secret"
          value={form.passwordSecret}
          onChange={(passwordSecret) => update(model, { passwordSecret })}
          names={inputs.secrets.map((secret) => secret.name)}
          read={inputs.reads.secrets}
          typed={Boolean(model.typing.passwordSecret)}
          onTyped={(typing) => {
            Mobx.runInAction(() => {
              model.typing.passwordSecret = typing;
            });
          }}
          placeholder="Pick a basic-auth secret"
          hint="Type kubernetes.io/basic-auth, keys username (equal to the role) and password. The host creates secrets from the Secrets page."
          unverifiedHint="The secrets could not be listed: the name goes unverified."
          error={errors.passwordSecret}
          warning={warnings.passwordSecret}
        />
      ) : null}
      <CheckboxField
        label="Can log in"
        checked={form.login}
        onChange={(login) => update(model, { login })}
        testId={`${TEST_ID}-login`}
        hint="Off, the role is a group: it holds privileges for its members."
      />
      <CheckboxField
        label="Client certificate managed by the operator"
        checked={form.clientCertificate}
        onChange={(clientCertificate) => update(model, { clientCertificate })}
        testId={`${TEST_ID}-client-certificate`}
        hint="Issued in the secret <object>-client-cert and renewed; pg_hba needs a hostssl cert rule."
        disabledReason={form.login ? undefined : "Needs a role that can log in."}
      />
      {errors.clientCertificate ? <div className={styles.error}>{errors.clientCertificate}</div> : null}
      <CollapsibleSection
        title="Privileges and limits"
        hint={`${
          privileges
            .filter(([key]) => (key === "inherit" ? !form.inherit : form[key]))
            .map(([, label]) => label)
            .join(", ") || "No special privilege"
        }${form.connectionLimit ? `; ${form.connectionLimit} connections` : ""}${form.validUntil ? `; valid until ${form.validUntil}` : ""}.`}
        open={model.open.privileges}
        onToggle={() => {
          Mobx.runInAction(() => {
            model.open.privileges = !model.open.privileges;
          });
        }}
        testId={`${TEST_ID}-privileges-section`}
      >
        {privileges.map(([key, label, hint]) => (
          <CheckboxField
            key={key}
            label={label}
            checked={form[key]}
            onChange={(checked) => update(model, { [key]: checked } as Partial<DatabaseRoleForm>)}
            testId={`${TEST_ID}-${key}`}
            hint={hint || undefined}
          />
        ))}
        <Inline>
          <TextField
            label="Connection limit"
            value={form.connectionLimit}
            onChange={(connectionLimit) => update(model, { connectionLimit })}
            inputTestId={`${TEST_ID}-connection-limit`}
            placeholder="-1"
            effective="no limit"
            error={errors.connectionLimit}
          />
          <TextField
            label="Valid until"
            value={form.validUntil}
            onChange={(validUntil) => update(model, { validUntil })}
            inputTestId={`${TEST_ID}-valid-until`}
            placeholder="2030-01-01T00:00:00Z (optional)"
            effective="never expires"
            error={errors.validUntil}
          />
        </Inline>
      </CollapsibleSection>
      <Field
        label="Member of"
        hint={`Type a group and press Enter. Known here: ${knownRoles.slice(0, 8).join(", ")}${knownRoles.length > 8 ? ", ..." : ""}.`}
        error={errors.inRoles ? Object.entries(errors).find(([key]) => key.startsWith("inRoles."))?.[1] : undefined}
        warning={warnings.inRoles}
        testId={`${TEST_ID}-in-roles-field`}
      >
        <div data-testid={`${TEST_ID}-in-roles`}>
          <EditableList
            items={form.inRoles}
            placeholder="pg_read_all_data"
            add={(role: string) => update(model, { inRoles: [...form.inRoles, role.trim()] })}
            remove={({ index }: { index: number }) =>
              update(model, { inRoles: form.inRoles.filter((_, at) => at !== index) })
            }
          />
        </div>
      </Field>
      <TextField
        label="Comment"
        value={form.comment}
        onChange={(comment) => update(model, { comment })}
        inputTestId={`${TEST_ID}-comment`}
        placeholder="What the role is for (optional)"
      />
      <ReclaimField
        testId={TEST_ID}
        kind="DatabaseRole"
        what="role"
        value={form.reclaim}
        onChange={(reclaim) => update(model, { reclaim })}
      />
    </>
  );
});

export interface OpenCreateDatabaseRoleOptions {
  namespace?: string;
  cluster?: string;
}

function open(model: RoleCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => databaseRoleFacts(model.inputs, model.form),
      form: () => <RoleCreateForm model={model} />,
      yaml: () => toYaml(databaseRoleBody(model.form)),
      blockReason: () => databaseRoleBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: () => {
        const { name, namespace } = model.form;
        return runCreate({
          kind: "DatabaseRole",
          resource: "databaseroles",
          namespace,
          name,
          body: databaseRoleBody(model.form),
          create: () =>
            DatabaseRole.getStore<DatabaseRole>().create({ name, namespace }, databaseRoleBody(model.form) as never),
          successMessage: databaseRoleSuccessMessage(namespace, name),
          reload: () => loadNamespaced(model, namespace),
          reopen: (notice) => open(model, true, notice),
        });
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create DatabaseRole form from the floating button of the Database Roles page. */
export function openCreateDatabaseRoleDialog(options: OpenCreateDatabaseRoleOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
