/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create Database dialog (SPEC-0027): the host wiring around the pure
// decisions of `database-create.ts`. It reads on open the clusters, the
// Database and the DatabaseRole objects of the namespace, renders the fields
// and sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { Database } from "../api/cnpg/database-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import {
  CheckboxField,
  ChoiceField,
  CollapsibleSection,
  Field,
  Inline,
  openCreateDialog,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import { ObjectChoiceField } from "./create-pickers";
import {
  databaseBlockReason,
  databaseBody,
  databaseErrors,
  databaseFacts,
  databaseSuccessMessage,
  databaseWarnings,
  defaultDatabaseForm,
  emptyDatabaseInputs,
} from "./database-create";
import { listClusterFacts, NamespaceAndClusterFields, ReclaimField, readInto, runCreate } from "./declarative-dialog";

import type { ActionDialogModel } from "./action-dialog";
import type { DatabaseForm, DatabaseInputs, ExistingDatabase, ExtensionRow, SchemaRow } from "./database-create";
import type { DeclarativeClusterFacts } from "./declarative-facts";

const { observer } = MobxReact;
const {
  K8sApi: { namespaceStore },
} = Renderer;

const TITLE = "Create database";
const TEST_ID = "cnpg-create-database";

interface RoleObject {
  cluster: string;
  name: string;
}

interface DatabaseCreateModel extends ActionDialogModel {
  form: DatabaseForm;
  inputs: DatabaseInputs;
  /** The raw facts of the clusters and the role objects: the owners a cluster knows are derived from both. */
  clusterFacts: DeclarativeClusterFacts[];
  roleObjects: RoleObject[];
  open: { objects: boolean; options: boolean };
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function derive(model: DatabaseCreateModel): void {
  Mobx.runInAction(() => {
    model.inputs = {
      ...model.inputs,
      clusters: model.clusterFacts.map((facts) => ({
        ...facts,
        owners: [
          ...new Set([
            facts.bootstrapOwner,
            ...facts.managedRoles,
            ...model.roleObjects.filter((role) => role.cluster === facts.name).map((role) => role.name),
            "postgres",
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
): DatabaseCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultDatabaseForm(namespace, cluster ?? ""),
      inputs: emptyDatabaseInputs(),
      clusterFacts: [],
      roleObjects: [],
      open: { objects: false, options: false },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
      fixedCluster: cluster,
    },
    { inputs: Mobx.observable.ref, clusterFacts: Mobx.observable.ref, roleObjects: Mobx.observable.ref },
  );
}

function update(model: DatabaseCreateModel, patch: Partial<DatabaseForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function loadNamespaced(model: DatabaseCreateModel, namespace: string): void {
  if (namespace === "") return;
  void readInto<DeclarativeClusterFacts, DatabaseInputs>(
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
  void readInto<Database, DatabaseInputs>(
    model,
    "databases",
    () => Database.getStore<Database>().api.list({ namespace }),
    (items) => ({
      databases: items.map(
        (item): ExistingDatabase => ({
          objectName: item.getName(),
          cluster: item.spec?.cluster?.name ?? "",
          name: item.spec?.name ?? "",
        }),
      ),
    }),
  );
  DatabaseRole.getStore<DatabaseRole>()
    .api.list({ namespace })
    .then((items) => {
      Mobx.runInAction(() => {
        model.roleObjects = (items ?? []).map((item) => ({
          cluster: item.spec?.cluster?.name ?? "",
          name: item.spec?.name ?? "",
        }));
      });
      derive(model);
    })
    .catch(() => undefined);
}

function askAccess(model: DatabaseCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "databases", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function rows<T>(items: readonly T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, at) => (at === index ? { ...item, ...patch } : item));
}

const DatabaseCreateForm = observer(({ model }: { model: DatabaseCreateModel }) => {
  const { form, inputs } = model;
  const errors = databaseErrors(inputs, form);
  const warnings = databaseWarnings(inputs, form);
  const cluster = inputs.clusters.find((candidate) => candidate.name === form.cluster);
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
          placeholder={form.cluster && form.dbName ? `${form.cluster}-${form.dbName}` : "pg-orders"}
          inputTestId={`${TEST_ID}-name`}
          testId={`${TEST_ID}-name-field`}
          hint="The Kubernetes name of the Database object."
          error={errors.name}
          warning={warnings.name}
        />
        <TextField
          label="Database"
          value={form.dbName}
          onChange={(dbName) => update(model, { dbName })}
          placeholder="orders"
          inputTestId={`${TEST_ID}-dbname`}
          testId={`${TEST_ID}-dbname-field`}
          hint="The PostgreSQL name: lowercase, cannot change later. postgres, template0 and template1 are reserved."
          error={errors.dbName}
          warning={warnings.dbName}
        />
      </Inline>
      <ObjectChoiceField
        id={`${TEST_ID}-owner`}
        testId={`${TEST_ID}-owner`}
        label="Owner"
        value={form.owner}
        onChange={(owner) => update(model, { owner })}
        choices={(cluster?.owners ?? []).map((name) => ({ name }))}
        read={cluster ? "ready" : inputs.reads.clusters === "ready" ? "ready" : inputs.reads.clusters}
        typed={Boolean(model.typing.owner)}
        onTyped={(typing) => {
          Mobx.runInAction(() => {
            model.typing.owner = typing;
          });
        }}
        placeholder="Pick a role"
        hint="A role that already exists in PostgreSQL: the operator fails the object otherwise."
        unverifiedHint="The roles could not be listed: the name goes unverified."
        error={errors.owner}
        warning={warnings.owner}
      />
      <CollapsibleSection
        title="Objects inside the database"
        hint={`${form.extensions.length} extension${form.extensions.length === 1 ? "" : "s"}, ${form.schemas.length} schema${form.schemas.length === 1 ? "" : "s"}.`}
        open={model.open.objects}
        onToggle={() => {
          Mobx.runInAction(() => {
            model.open.objects = !model.open.objects;
          });
        }}
        testId={`${TEST_ID}-objects-section`}
      >
        <Field
          label="Extensions"
          hint="CREATE EXTENSION in the database, once it exists."
          error={errors.extensions ? undefined : undefined}
          testId={`${TEST_ID}-extensions-field`}
        >
          <div className={styles.rows} data-testid={`${TEST_ID}-extensions`}>
            {form.extensions.map((row, index) => (
              <div key={`extension-${index}`} className={styles.rows}>
                <Inline>
                  <TextField
                    label="Name"
                    value={row.name}
                    onChange={(name) => update(model, { extensions: rows(form.extensions, index, { name }) })}
                    inputTestId={`${TEST_ID}-extensions-${index}-name`}
                    placeholder="pg_stat_statements"
                    error={errors[`extensions.${index}.name`]}
                  />
                  <TextField
                    label="Version"
                    value={row.version}
                    onChange={(version) => update(model, { extensions: rows(form.extensions, index, { version }) })}
                    inputTestId={`${TEST_ID}-extensions-${index}-version`}
                    placeholder="(latest)"
                  />
                  <TextField
                    label="Schema"
                    value={row.schema}
                    onChange={(schema) => update(model, { extensions: rows(form.extensions, index, { schema }) })}
                    inputTestId={`${TEST_ID}-extensions-${index}-schema`}
                    placeholder="(default)"
                    error={errors[`extensions.${index}.schema`]}
                  />
                </Inline>
                <div>
                  <button
                    type="button"
                    className={styles.button}
                    data-testid={`${TEST_ID}-extensions-${index}-remove`}
                    onClick={() => update(model, { extensions: form.extensions.filter((_, at) => at !== index) })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <div>
              <button
                type="button"
                className={styles.button}
                data-testid={`${TEST_ID}-extensions-add`}
                onClick={() =>
                  update(model, {
                    extensions: [...form.extensions, { name: "", version: "", schema: "" } as ExtensionRow],
                  })
                }
              >
                Add an extension
              </button>
            </div>
          </div>
        </Field>
        <Field
          label="Schemas"
          hint="CREATE SCHEMA in the database, with an owner when given."
          testId={`${TEST_ID}-schemas-field`}
        >
          <div className={styles.rows} data-testid={`${TEST_ID}-schemas`}>
            {form.schemas.map((row, index) => (
              <div key={`schema-${index}`} className={styles.rows}>
                <Inline>
                  <TextField
                    label="Name"
                    value={row.name}
                    onChange={(name) => update(model, { schemas: rows(form.schemas, index, { name }) })}
                    inputTestId={`${TEST_ID}-schemas-${index}-name`}
                    placeholder="sales"
                    error={errors[`schemas.${index}.name`]}
                  />
                  <TextField
                    label="Owner"
                    value={row.owner}
                    onChange={(owner) => update(model, { schemas: rows(form.schemas, index, { owner }) })}
                    inputTestId={`${TEST_ID}-schemas-${index}-owner`}
                    placeholder="(the database owner)"
                    error={errors[`schemas.${index}.owner`]}
                  />
                </Inline>
                <div>
                  <button
                    type="button"
                    className={styles.button}
                    data-testid={`${TEST_ID}-schemas-${index}-remove`}
                    onClick={() => update(model, { schemas: form.schemas.filter((_, at) => at !== index) })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <div>
              <button
                type="button"
                className={styles.button}
                data-testid={`${TEST_ID}-schemas-add`}
                onClick={() => update(model, { schemas: [...form.schemas, { name: "", owner: "" } as SchemaRow] })}
              >
                Add a schema
              </button>
            </div>
          </div>
        </Field>
      </CollapsibleSection>
      <CollapsibleSection
        title="Creation options"
        hint="Template, encoding, locale, tablespace and limits: the first three cannot change later."
        open={model.open.options}
        onToggle={() => {
          Mobx.runInAction(() => {
            model.open.options = !model.open.options;
          });
        }}
        testId={`${TEST_ID}-options-section`}
      >
        <Inline>
          <TextField
            label="Template"
            value={form.template}
            onChange={(template) => update(model, { template })}
            inputTestId={`${TEST_ID}-template`}
            placeholder="template1"
            effective="template1"
            error={errors.template}
          />
          <TextField
            label="Encoding"
            value={form.encoding}
            onChange={(encoding) => update(model, { encoding })}
            inputTestId={`${TEST_ID}-encoding`}
            placeholder="UTF8"
            effective="the template's encoding"
          />
        </Inline>
        <Inline>
          <ChoiceField
            id={`${TEST_ID}-locale-provider`}
            label="Locale provider"
            value={form.localeProvider}
            options={[
              { value: "", label: "The template's" },
              { value: "libc", label: "libc" },
              { value: "icu", label: "icu (PostgreSQL 15 and newer)" },
              { value: "builtin", label: "builtin (PostgreSQL 17 and newer)" },
            ]}
            onChange={(localeProvider) => update(model, { localeProvider })}
          />
          <TextField
            label="Locale"
            value={form.locale}
            onChange={(locale) => update(model, { locale })}
            inputTestId={`${TEST_ID}-locale`}
            placeholder={form.localeProvider === "icu" ? "en-US" : "C"}
            error={errors.locale}
          />
          <ObjectChoiceField
            id={`${TEST_ID}-tablespace`}
            testId={`${TEST_ID}-tablespace`}
            label="Tablespace"
            value={form.tablespace}
            onChange={(tablespace) => update(model, { tablespace })}
            choices={(cluster?.tablespaces ?? []).map((name) => ({ name }))}
            read={inputs.reads.clusters}
            typed={Boolean(model.typing.tablespace)}
            onTyped={(typing) => {
              Mobx.runInAction(() => {
                model.typing.tablespace = typing;
              });
            }}
            placeholder="The default tablespace"
            unverifiedHint="The tablespaces could not be read: the name goes unverified."
            error={errors.tablespace}
            warning={warnings.tablespace}
          />
        </Inline>
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
          <ChoiceField
            id={`${TEST_ID}-allow-connections`}
            label="Allow connections"
            value={form.allowConnections}
            options={[
              { value: "", label: "PostgreSQL's default (yes)" },
              { value: "true", label: "yes" },
              { value: "false", label: "no" },
            ]}
            onChange={(allowConnections) => update(model, { allowConnections })}
          />
        </Inline>
        <CheckboxField
          label="Is a template"
          checked={form.isTemplate}
          onChange={(isTemplate) => update(model, { isTemplate })}
          testId={`${TEST_ID}-is-template`}
          hint="Other databases can be created from it."
        />
      </CollapsibleSection>
      <ReclaimField
        testId={TEST_ID}
        kind="Database"
        what="database"
        value={form.reclaim}
        onChange={(reclaim) => update(model, { reclaim })}
      />
    </>
  );
});

export interface OpenCreateDatabaseOptions {
  namespace?: string;
  cluster?: string;
}

function open(model: DatabaseCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => databaseFacts(model.inputs, model.form),
      form: () => <DatabaseCreateForm model={model} />,
      yaml: () => toYaml(databaseBody(model.form)),
      blockReason: () => databaseBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: () => {
        const { name, namespace } = model.form;
        return runCreate({
          kind: "Database",
          resource: "databases",
          namespace,
          name,
          body: databaseBody(model.form),
          create: () => Database.getStore<Database>().create({ name, namespace }, databaseBody(model.form) as never),
          successMessage: databaseSuccessMessage(namespace, name),
          reload: () => loadNamespaced(model, namespace),
          reopen: (notice) => open(model, true, notice),
        });
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create Database form from the floating button of the Databases page. */
export function openCreateDatabaseDialog(options: OpenCreateDatabaseOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
