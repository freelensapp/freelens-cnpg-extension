/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create Subscription dialog (SPEC-0027): the host wiring around the
// pure decisions of `subscription-create.ts`. It reads on open the clusters
// (with their external clusters), the Database and the Subscription objects
// of the namespace and the Publication objects the extension can see, renders
// the fields and sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Database } from "../api/cnpg/database-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import { ChoiceField, Inline, openCreateDialog, TextField } from "./create-dialog";
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
  defaultSubscriptionForm,
  emptySubscriptionInputs,
  pickedExternalCluster,
  publicationsBehind,
  SUBSCRIPTION_PARAMETERS,
  subscriptionBlockReason,
  subscriptionBody,
  subscriptionErrors,
  subscriptionFacts,
  subscriptionSuccessMessage,
  subscriptionWarnings,
} from "./subscription-create";

import type { ActionDialogModel } from "./action-dialog";
import type { KeyValue } from "./create-forms";
import type { DeclarativeClusterFacts } from "./declarative-facts";
import type {
  ExistingSubscription,
  KnownPublication,
  SubscriptionForm,
  SubscriptionInputs,
} from "./subscription-create";

const { observer } = MobxReact;
const {
  K8sApi: { namespaceStore },
} = Renderer;

const TITLE = "Create subscription";
const TEST_ID = "cnpg-create-subscription";

interface DatabaseObject {
  cluster: string;
  name: string;
}

interface SubscriptionCreateModel extends ActionDialogModel {
  form: SubscriptionForm;
  inputs: SubscriptionInputs;
  clusterFacts: DeclarativeClusterFacts[];
  databaseObjects: DatabaseObject[];
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function derive(model: SubscriptionCreateModel): void {
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
): SubscriptionCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultSubscriptionForm(namespace, cluster ?? ""),
      inputs: emptySubscriptionInputs(),
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

function update(model: SubscriptionCreateModel, patch: Partial<SubscriptionForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function loadNamespaced(model: SubscriptionCreateModel, namespace: string): void {
  if (namespace === "") return;
  void readInto<DeclarativeClusterFacts, SubscriptionInputs>(
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
  void readInto<Subscription, SubscriptionInputs>(
    model,
    "subscriptions",
    () => Subscription.getStore<Subscription>().api.list({ namespace }),
    (items) => ({
      subscriptions: items.map(
        (item): ExistingSubscription => ({
          objectName: item.getName(),
          cluster: item.spec?.cluster?.name ?? "",
          dbname: item.spec?.dbname ?? "",
          name: item.spec?.name ?? "",
        }),
      ),
    }),
  );
  // The publications live where their publisher does, which may be another namespace: every namespace when the account may, this one otherwise.
  void readInto<Publication, SubscriptionInputs>(
    model,
    "publications",
    () =>
      Publication.getStore<Publication>()
        .api.list()
        .catch(() => Publication.getStore<Publication>().api.list({ namespace })),
    (items) => ({
      publications: items.map(
        (item): KnownPublication => ({
          cluster: item.spec?.cluster?.name ?? "",
          namespace: item.getNs() ?? "",
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

function askAccess(model: SubscriptionCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "subscriptions", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

const SubscriptionCreateForm = observer(({ model }: { model: SubscriptionCreateModel }) => {
  const { form, inputs } = model;
  const errors = subscriptionErrors(inputs, form);
  const warnings = subscriptionWarnings(inputs, form);
  const cluster = inputs.clusters.find((candidate) => candidate.name === form.cluster);
  const entries = (cluster?.externalClusters ?? []).filter((entry) => entry.connectable);
  const entry = pickedExternalCluster(inputs, form);
  const behind = publicationsBehind(inputs, entry);
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
          update(model, { namespace, cluster: "", externalCluster: "" });
          loadNamespaced(model, namespace);
          askAccess(model, namespace);
        }}
        onCluster={(picked) => update(model, { cluster: picked, externalCluster: "" })}
        errors={errors}
        warnings={warnings}
      />
      <Inline>
        <TextField
          label="Object name"
          value={form.name}
          onChange={(name) => update(model, { name })}
          placeholder={
            form.cluster && form.subName ? `${form.cluster}-${form.subName.replace(/_/g, "-")}` : "pg-orders-sub"
          }
          inputTestId={`${TEST_ID}-name`}
          testId={`${TEST_ID}-name-field`}
          hint="The Kubernetes name of the Subscription object."
          error={errors.name}
          warning={warnings.name}
        />
        <TextField
          label="Subscription"
          value={form.subName}
          onChange={(subName) => update(model, { subName })}
          placeholder="orders_sub"
          inputTestId={`${TEST_ID}-sub-name`}
          testId={`${TEST_ID}-sub-name-field`}
          hint="The PostgreSQL name: lowercase, cannot change later."
          error={errors.subName}
          warning={warnings.subName}
        />
      </Inline>
      <ObjectChoiceField
        id={`${TEST_ID}-dbname`}
        testId={`${TEST_ID}-dbname`}
        label="Local database"
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
        hint="The database of this cluster the changes arrive in; its tables must already exist. Cannot change later."
        unverifiedHint="The databases could not be listed: the name goes unverified."
        error={errors.dbname}
        warning={warnings.dbname}
      />
      {cluster && entries.length === 0 ? (
        <ChoiceField
          id={`${TEST_ID}-external`}
          label="External cluster"
          value=""
          options={[]}
          onChange={() => undefined}
          placeholder="None declared"
          error={errors.externalCluster}
          testId={`${TEST_ID}-external-field`}
        />
      ) : (
        <ObjectChoiceField
          id={`${TEST_ID}-external`}
          testId={`${TEST_ID}-external`}
          label="External cluster"
          value={form.externalCluster}
          onChange={(externalCluster) => update(model, { externalCluster, publicationDBName: "" })}
          choices={entries.map((candidate) => ({
            name: candidate.name,
            reason: candidate.hasPassword ? undefined : "no password secret in the entry",
          }))}
          read={inputs.reads.clusters}
          typed={Boolean(model.typing.externalCluster)}
          onTyped={(typing) => {
            Mobx.runInAction(() => {
              model.typing.externalCluster = typing;
            });
          }}
          placeholder="Pick an entry of the cluster's externalClusters"
          hint={
            entry?.host
              ? `Connects to ${entry.host}${entry.dbname ? `, database ${entry.dbname}` : ""}${entry.user ? `, as ${entry.user}` : ""}.`
              : "An entry of the subscriber's externalClusters with connection parameters."
          }
          unverifiedHint="The cluster could not be read: the entry goes unverified."
          error={errors.externalCluster}
          warning={warnings.externalCluster}
        />
      )}
      <Inline>
        <ObjectChoiceField
          id={`${TEST_ID}-publication`}
          testId={`${TEST_ID}-publication`}
          label="Publication"
          value={form.publicationName}
          onChange={(publicationName) => update(model, { publicationName })}
          choices={behind.map((publication) => ({
            name: publication.name,
            reason:
              publication.dbname !== (form.publicationDBName.trim() || entry?.dbname)
                ? `in the database ${publication.dbname}`
                : undefined,
          }))}
          read={
            behind.length > 0 ? "ready" : inputs.reads.publications === "ready" ? "ready" : inputs.reads.publications
          }
          typed={Boolean(model.typing.publicationName)}
          onTyped={(typing) => {
            Mobx.runInAction(() => {
              model.typing.publicationName = typing;
            });
          }}
          placeholder="Pick a publication"
          hint={
            behind.length > 0
              ? "The publications the extension knows on the cluster behind the entry."
              : "The name of the publication on the publisher."
          }
          unverifiedHint="The publications could not be listed: the name goes unverified."
          error={errors.publicationName}
          warning={warnings.publicationName}
        />
        <TextField
          label="Publisher database"
          value={form.publicationDBName}
          onChange={(publicationDBName) => update(model, { publicationDBName })}
          inputTestId={`${TEST_ID}-publication-dbname`}
          testId={`${TEST_ID}-publication-dbname-field`}
          placeholder={entry?.dbname ?? "the entry's database"}
          effective={entry?.dbname ? `${entry.dbname}, the database of the entry` : "the database of the entry"}
          error={errors.publicationDBName}
        />
      </Inline>
      <ParametersField
        testId={TEST_ID}
        rows={form.parameters}
        onChange={(parameters: KeyValue[]) => update(model, { parameters })}
        errors={errors}
        known={SUBSCRIPTION_PARAMETERS}
        hint="How the subscription starts and streams; most cannot change once it exists."
      />
      <ReclaimField
        testId={TEST_ID}
        kind="Subscription"
        what="subscription"
        value={form.reclaim}
        onChange={(reclaim) => update(model, { reclaim })}
      />
    </>
  );
});

export interface OpenCreateSubscriptionOptions {
  namespace?: string;
  cluster?: string;
}

function open(model: SubscriptionCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => subscriptionFacts(model.inputs, model.form),
      form: () => <SubscriptionCreateForm model={model} />,
      yaml: () => toYaml(subscriptionBody(model.form)),
      blockReason: () => subscriptionBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: () => {
        const { name, namespace } = model.form;
        return runCreate({
          kind: "Subscription",
          resource: "subscriptions",
          namespace,
          name,
          body: subscriptionBody(model.form),
          create: () =>
            Subscription.getStore<Subscription>().create({ name, namespace }, subscriptionBody(model.form) as never),
          successMessage: subscriptionSuccessMessage(namespace, name),
          reload: () => loadNamespaced(model, namespace),
          reopen: (notice) => open(model, true, notice),
        });
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create Subscription form from the floating button of the Subscriptions page. */
export function openCreateSubscriptionDialog(options: OpenCreateSubscriptionOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
