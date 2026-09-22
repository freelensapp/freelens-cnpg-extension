/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create Publication dialog (SPEC-0027): the host wiring around the
// pure decisions of `publication-create.ts`. It reads on open the clusters,
// the Database and the Publication objects of the namespace, renders the
// fields and sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Database } from "../api/cnpg/database-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import {
  CheckboxField,
  Field,
  Inline,
  openCreateDialog,
  RadioField,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import { ObjectChoiceField } from "./create-pickers";
import {
  listClusterFacts,
  NamespaceAndClusterFields,
  ParametersField,
  ReclaimField,
  readInto,
  runCreate,
} from "./declarative-dialog";
import {
  defaultPublicationForm,
  emptyObjectRow,
  emptyPublicationInputs,
  PUBLICATION_PARAMETERS,
  publicationBlockReason,
  publicationBody,
  publicationErrors,
  publicationFacts,
  publicationSuccessMessage,
  publicationWarnings,
} from "./publication-create";

import type { ActionDialogModel } from "./action-dialog";
import type { KeyValue } from "./create-forms";
import type { DeclarativeClusterFacts } from "./declarative-facts";
import type {
  ExistingPublication,
  PublicationForm,
  PublicationInputs,
  PublicationObjectRow,
} from "./publication-create";

const { observer } = MobxReact;
const {
  K8sApi: { namespaceStore },
} = Renderer;

const TITLE = "Create publication";
const TEST_ID = "cnpg-create-publication";

interface DatabaseObject {
  cluster: string;
  name: string;
}

interface PublicationCreateModel extends ActionDialogModel {
  form: PublicationForm;
  inputs: PublicationInputs;
  clusterFacts: DeclarativeClusterFacts[];
  databaseObjects: DatabaseObject[];
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function derive(model: PublicationCreateModel): void {
  Mobx.runInAction(() => {
    model.inputs = {
      ...model.inputs,
      clusters: model.clusterFacts.map((facts) => ({
        ...facts,
        databases: [
          ...new Set([
            facts.bootstrapDatabase,
            ...model.databaseObjects
              .filter((database) => database.cluster === facts.name)
              .map((database) => database.name),
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
): PublicationCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultPublicationForm(namespace, cluster ?? ""),
      inputs: emptyPublicationInputs(),
      clusterFacts: [],
      databaseObjects: [],
      typing: {},
      accessReason: undefined,
      fixedNamespace,
      fixedCluster: cluster,
    },
    { inputs: Mobx.observable.ref, clusterFacts: Mobx.observable.ref, databaseObjects: Mobx.observable.ref },
  );
}

function update(model: PublicationCreateModel, patch: Partial<PublicationForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function loadNamespaced(model: PublicationCreateModel, namespace: string): void {
  if (namespace === "") return;
  void readInto<DeclarativeClusterFacts, PublicationInputs>(
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
  void readInto<Publication, PublicationInputs>(
    model,
    "publications",
    () => Publication.getStore<Publication>().api.list({ namespace }),
    (items) => ({
      publications: items.map(
        (item): ExistingPublication => ({
          objectName: item.getName(),
          cluster: item.spec?.cluster?.name ?? "",
          dbname: item.spec?.dbname ?? "",
          name: item.spec?.name ?? "",
        }),
      ),
    }),
  );
  Database.getStore<Database>()
    .api.list({ namespace })
    .then((items) => {
      Mobx.runInAction(() => {
        model.databaseObjects = (items ?? []).map((item) => ({
          cluster: item.spec?.cluster?.name ?? "",
          name: item.spec?.name ?? "",
        }));
      });
      derive(model);
    })
    .catch(() => undefined);
}

function askAccess(model: PublicationCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "publications", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function rows(
  items: readonly PublicationObjectRow[],
  index: number,
  patch: Partial<PublicationObjectRow>,
): PublicationObjectRow[] {
  return items.map((item, at) => (at === index ? { ...item, ...patch } : item));
}

const PublicationCreateForm = observer(({ model }: { model: PublicationCreateModel }) => {
  const { form, inputs } = model;
  const errors = publicationErrors(inputs, form);
  const warnings = publicationWarnings(inputs, form);
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
          placeholder={
            form.cluster && form.pubName ? `${form.cluster}-${form.pubName.replace(/_/g, "-")}` : "pg-orders-pub"
          }
          inputTestId={`${TEST_ID}-name`}
          testId={`${TEST_ID}-name-field`}
          hint="The Kubernetes name of the Publication object."
          error={errors.name}
          warning={warnings.name}
        />
        <TextField
          label="Publication"
          value={form.pubName}
          onChange={(pubName) => update(model, { pubName })}
          placeholder="orders_pub"
          inputTestId={`${TEST_ID}-pub-name`}
          testId={`${TEST_ID}-pub-name-field`}
          hint="The PostgreSQL name: lowercase, cannot change later."
          error={errors.pubName}
          warning={warnings.pubName}
        />
      </Inline>
      <ObjectChoiceField
        id={`${TEST_ID}-dbname`}
        testId={`${TEST_ID}-dbname`}
        label="Database"
        value={form.dbname}
        onChange={(dbname) => update(model, { dbname })}
        choices={(cluster?.databases ?? []).map((name) => ({ name }))}
        read={inputs.reads.clusters}
        typed={Boolean(model.typing.dbname)}
        onTyped={(typing) => {
          Mobx.runInAction(() => {
            model.typing.dbname = typing;
          });
        }}
        placeholder="Pick a database"
        hint="The database of the cluster the publication lives in; cannot change later."
        unverifiedHint="The databases could not be listed: the name goes unverified."
        error={errors.dbname}
        warning={warnings.dbname}
      />
      <RadioField
        label="What it publishes"
        name={`${TEST_ID}-target`}
        value={form.target}
        onChange={(target) =>
          update(model, {
            target,
            ...(target === "objects" && form.objects.length === 0 ? { objects: [emptyObjectRow("table")] } : {}),
          })
        }
        testId={`${TEST_ID}-target`}
        choices={[
          {
            value: "allTables",
            label: "All tables",
            hint: "Present and future, with every column. Cannot change later.",
          },
          {
            value: "objects",
            label: "Schemas and tables",
            hint: "Whole schemas, or tables with an optional column list.",
          },
        ]}
      />
      {form.target === "objects" ? (
        <Field
          label="Entries"
          hint="A column list cannot go together with a schema entry."
          error={errors.objects && !errors.objects.startsWith("An entry") ? errors.objects : undefined}
          testId={`${TEST_ID}-objects-field`}
        >
          <div className={styles.rows} data-testid={`${TEST_ID}-objects`}>
            {form.objects.map((row, index) => (
              <div key={`object-${index}`} className={styles.rows}>
                <RadioField
                  label={`Entry ${index + 1}`}
                  name={`${TEST_ID}-object-${index}-kind`}
                  value={row.kind}
                  onChange={(kind) => update(model, { objects: rows(form.objects, index, { kind }) })}
                  choices={[
                    { value: "table", label: "A table" },
                    { value: "schema", label: "Every table of a schema" },
                  ]}
                />
                {row.kind === "schema" ? (
                  <TextField
                    label="Schema"
                    value={row.name}
                    onChange={(name) => update(model, { objects: rows(form.objects, index, { name }) })}
                    inputTestId={`${TEST_ID}-objects-${index}-name`}
                    placeholder="sales"
                    error={errors[`objects.${index}.name`]}
                  />
                ) : (
                  <>
                    <Inline>
                      <TextField
                        label="Schema (optional)"
                        value={row.schema}
                        onChange={(schema) => update(model, { objects: rows(form.objects, index, { schema }) })}
                        inputTestId={`${TEST_ID}-objects-${index}-schema`}
                        placeholder="public"
                        error={errors[`objects.${index}.schema`]}
                      />
                      <TextField
                        label="Table"
                        value={row.name}
                        onChange={(name) => update(model, { objects: rows(form.objects, index, { name }) })}
                        inputTestId={`${TEST_ID}-objects-${index}-name`}
                        placeholder="orders"
                        error={errors[`objects.${index}.name`]}
                      />
                    </Inline>
                    <TextField
                      label="Columns (optional, comma separated)"
                      value={row.columns}
                      onChange={(columns) => update(model, { objects: rows(form.objects, index, { columns }) })}
                      inputTestId={`${TEST_ID}-objects-${index}-columns`}
                      placeholder="id, total"
                      error={errors[`objects.${index}.columns`]}
                    />
                    <CheckboxField
                      label="Only this table, not the ones that inherit from it"
                      checked={row.only}
                      onChange={(only) => update(model, { objects: rows(form.objects, index, { only }) })}
                      testId={`${TEST_ID}-objects-${index}-only`}
                    />
                  </>
                )}
                <div>
                  <button
                    type="button"
                    className={styles.button}
                    data-testid={`${TEST_ID}-objects-${index}-remove`}
                    onClick={() => update(model, { objects: form.objects.filter((_, at) => at !== index) })}
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
                data-testid={`${TEST_ID}-objects-add`}
                onClick={() => update(model, { objects: [...form.objects, emptyObjectRow("table")] })}
              >
                Add an entry
              </button>
            </div>
          </div>
        </Field>
      ) : null}
      <ParametersField
        testId={TEST_ID}
        rows={form.parameters}
        onChange={(parameters: KeyValue[]) => update(model, { parameters })}
        errors={errors}
        known={PUBLICATION_PARAMETERS}
        hint="Which operations are published, and how partitions appear."
      />
      <ReclaimField
        testId={TEST_ID}
        kind="Publication"
        what="publication"
        value={form.reclaim}
        onChange={(reclaim) => update(model, { reclaim })}
      />
    </>
  );
});

export interface OpenCreatePublicationOptions {
  namespace?: string;
  cluster?: string;
}

function open(model: PublicationCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => publicationFacts(model.inputs, model.form),
      form: () => <PublicationCreateForm model={model} />,
      yaml: () => toYaml(publicationBody(model.form)),
      blockReason: () => publicationBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: () => {
        const { name, namespace } = model.form;
        return runCreate({
          kind: "Publication",
          resource: "publications",
          namespace,
          name,
          body: publicationBody(model.form),
          create: () =>
            Publication.getStore<Publication>().create({ name, namespace }, publicationBody(model.form) as never),
          successMessage: publicationSuccessMessage(namespace, name),
          reload: () => loadNamespaced(model, namespace),
          reopen: (notice) => open(model, true, notice),
        });
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create Publication form from the floating button of the Publications page. */
export function openCreatePublicationDialog(options: OpenCreatePublicationOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
