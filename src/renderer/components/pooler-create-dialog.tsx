/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create Pooler dialog (SPEC-0026): the host wiring around the pure
// decisions of `pooler-create.ts`. It reads on open the clusters, the
// poolers, the Services and the secrets of the namespace, asks the API server
// whether the account may create a pooler there (W3), renders the fields and
// sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import {
  CheckboxField,
  ChoiceField,
  CollapsibleSection,
  FactField,
  Field,
  Inline,
  KeyValueEditor,
  ObjectPicker,
  openCreateDialog,
  RadioField,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import { ObjectChoiceField } from "./create-pickers";
import {
  COMMON_PGBOUNCER_PARAMETERS,
  defaultPoolerForm,
  defaultPoolerName,
  emptyPoolerInputs,
  POOL_MODE_SENTENCES,
  POOLER_TYPE_SENTENCES,
  poolerBlockReason,
  poolerBody,
  poolerErrors,
  poolerFacts,
  poolerSuccessMessage,
  poolerTypeReason,
  poolerWarnings,
} from "./pooler-create";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { ActionDialogModel } from "./action-dialog";
import type { ReadState } from "./create-dialog";
import type { KeyValue } from "./create-forms";
import type { PoolerForm, PoolerInputs, PoolerType } from "./pooler-create";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  K8sApi: { namespaceStore, secretsApi, serviceApi },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Create pooler";
const TEST_ID = "cnpg-create-pooler";

interface PoolerCreateModel extends ActionDialogModel {
  form: PoolerForm;
  inputs: PoolerInputs;
  open: { auth: boolean };
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function createModel(
  namespace: string,
  cluster: string | undefined,
  fixedNamespace: string | undefined,
): PoolerCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultPoolerForm(namespace, cluster ?? ""),
      inputs: emptyPoolerInputs(),
      open: { auth: false },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
      fixedCluster: cluster,
    },
    { inputs: Mobx.observable.ref },
  );
}

function update(model: PoolerCreateModel, patch: Partial<PoolerForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function setInputs(
  model: PoolerCreateModel,
  patch: Partial<PoolerInputs>,
  read?: keyof PoolerInputs["reads"],
  state?: ReadState,
) {
  Mobx.runInAction(() => {
    model.inputs = {
      ...model.inputs,
      ...patch,
      reads: read && state ? { ...model.inputs.reads, [read]: state } : model.inputs.reads,
    };
  });
}

async function read<T>(
  model: PoolerCreateModel,
  key: keyof PoolerInputs["reads"],
  fetchItems: () => Promise<T[] | null | undefined>,
  fold: (items: T[]) => Partial<PoolerInputs>,
): Promise<void> {
  setInputs(model, {}, key, "loading");
  try {
    const items = (await fetchItems()) ?? [];
    setInputs(model, fold(items), key, "ready");
  } catch {
    setInputs(model, {}, key, "unavailable");
  }
}

interface NamedLike {
  getName(): string;
}

function loadNamespaced(model: PoolerCreateModel, namespace: string): void {
  if (namespace === "") return;
  void read<Cluster>(
    model,
    "clusters",
    () => Cluster.getStore<Cluster>().api.list({ namespace }),
    (items) => ({
      clusters: items.map((item) => ({
        name: item.getName(),
        instances: Cluster.getInstances(item),
        hibernated: Cluster.getHibernation(item),
      })),
    }),
  );
  void read<Pooler>(
    model,
    "poolers",
    () => Pooler.getStore<Pooler>().api.list({ namespace }),
    (items) => ({ poolers: items.map((item) => item.getName()) }),
  );
  void read<NamedLike>(
    model,
    "services",
    () => serviceApi.list({ namespace }) as unknown as Promise<NamedLike[] | null>,
    (items) => ({ services: items.map((item) => item.getName()) }),
  );
  void read<NamedLike>(
    model,
    "secrets",
    () => secretsApi.list({ namespace }) as unknown as Promise<NamedLike[] | null>,
    (items) => ({ secrets: items.map((item) => item.getName()) }),
  );
}

function askAccess(model: PoolerCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "poolers", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function changeNamespace(model: PoolerCreateModel, namespace: string): void {
  update(model, { namespace, cluster: "" });
  if (model.form.nameFollows) update(model, { name: "" });
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
}

function changeCluster(model: PoolerCreateModel, cluster: string): void {
  update(model, { cluster, ...(model.form.nameFollows ? { name: defaultPoolerName(cluster, model.form.type) } : {}) });
}

function changeType(model: PoolerCreateModel, type: PoolerType): void {
  update(model, { type, ...(model.form.nameFollows ? { name: defaultPoolerName(model.form.cluster, type) } : {}) });
}

const PoolerCreateForm = observer(({ model }: { model: PoolerCreateModel }) => {
  const { form, inputs } = model;
  const errors = poolerErrors(inputs, form);
  const warnings = poolerWarnings(inputs, form);
  const rowErrors = (index: number) => ({
    key: errors[`parameters.${index}.key`],
    value: errors[`parameters.${index}.value`],
  });
  return (
    <>
      {model.fixedNamespace ? (
        <FactField label="Namespace" value={model.fixedNamespace} testId={`${TEST_ID}-namespace-fact`} />
      ) : (
        <Field label="Namespace" error={errors.namespace} testId={`${TEST_ID}-namespace`}>
          <NamespaceSelect
            id={`${TEST_ID}-namespace-select`}
            themeName="light"
            menuClass={styles.selectMenu}
            value={form.namespace || null}
            onChange={(option: { value: string } | null) => changeNamespace(model, option?.value ?? "")}
          />
        </Field>
      )}
      {model.fixedCluster ? (
        <FactField label="Cluster" value={model.fixedCluster} testId={`${TEST_ID}-cluster-fact`} />
      ) : (
        <ObjectChoiceField
          id={`${TEST_ID}-cluster`}
          testId={`${TEST_ID}-cluster`}
          label="Cluster"
          value={form.cluster}
          onChange={(cluster) => changeCluster(model, cluster)}
          choices={inputs.clusters.map((cluster) => ({
            name: cluster.name,
            reason: cluster.hibernated
              ? "hibernated: nothing to connect to"
              : cluster.instances < 2
                ? "one instance: only rw makes sense"
                : undefined,
          }))}
          read={inputs.reads.clusters}
          typed={Boolean(model.typing.cluster)}
          onTyped={(typed) => {
            Mobx.runInAction(() => {
              model.typing.cluster = typed;
            });
          }}
          placeholder="Pick a cluster"
          unverifiedHint="The clusters could not be listed: the name goes unverified."
          error={errors.cluster}
          warning={warnings.cluster}
        />
      )}
      <RadioField
        label="Type"
        name={`${TEST_ID}-type`}
        value={form.type}
        onChange={(type) => changeType(model, type)}
        testId={`${TEST_ID}-type`}
        choices={(["rw", "ro", "r"] as const).map((type) => ({
          value: type,
          label: type,
          hint: POOLER_TYPE_SENTENCES[type],
          disabledReason: poolerTypeReason(inputs, form, type)
            ? `${POOLER_TYPE_SENTENCES[type]} Dimmed: ${poolerTypeReason(inputs, form, type)}.`
            : undefined,
        }))}
      />
      <TextField
        label="Name"
        value={form.name}
        onChange={(name) => update(model, { name, nameFollows: false })}
        placeholder={defaultPoolerName(form.cluster || "cluster", form.type)}
        inputTestId={`${TEST_ID}-name`}
        testId={`${TEST_ID}-name-field`}
        hint="A DNS label of 63 characters at most: it names the Deployment and the Service of the pooler, so it cannot be a service of the cluster."
        error={errors.name}
        warning={warnings.name}
      />
      <Inline>
        <TextField
          label="Instances"
          value={form.instances}
          onChange={(instances) => update(model, { instances })}
          inputTestId={`${TEST_ID}-instances`}
          testId={`${TEST_ID}-instances-field`}
          hint="PgBouncer pods behind the Service."
          error={errors.instances}
        />
        <ChoiceField
          id={`${TEST_ID}-pool-mode`}
          label="Pool mode"
          value={form.poolMode}
          options={[
            { value: "session", label: "session" },
            { value: "transaction", label: "transaction" },
          ]}
          onChange={(poolMode) => update(model, { poolMode })}
          hint={POOL_MODE_SENTENCES[form.poolMode]}
        />
      </Inline>
      <Field
        label="PgBouncer parameters"
        hint={`Settings of pgbouncer.ini the operator lets a pooler set, ${COMMON_PGBOUNCER_PARAMETERS.join(", ")} among them. The operator does not check the values.`}
        testId={`${TEST_ID}-parameters-field`}
      >
        <KeyValueEditor
          rows={form.parameters}
          onChange={(parameters: KeyValue[]) => update(model, { parameters })}
          errors={rowErrors}
          keyPlaceholder="max_client_conn"
          valuePlaceholder="500"
          addLabel="Add a parameter"
          testId={`${TEST_ID}-parameters`}
        />
      </Field>
      <CollapsibleSection
        title="Pause and authentication"
        hint={
          form.authQuery.trim() !== ""
            ? "A custom auth query: the operator does not manage the integration."
            : "The operator's own auth query and user; not paused."
        }
        open={model.open.auth}
        onToggle={() => {
          Mobx.runInAction(() => {
            model.open.auth = !model.open.auth;
          });
        }}
        testId={`${TEST_ID}-auth-section`}
      >
        <CheckboxField
          label="Create paused"
          checked={form.paused}
          onChange={(paused) => update(model, { paused })}
          testId={`${TEST_ID}-paused`}
          hint="PgBouncer holds every query until the pooler is resumed."
        />
        <ObjectPicker
          id={`${TEST_ID}-auth-secret`}
          inputTestId={`${TEST_ID}-auth-secret-input`}
          label="Auth query secret"
          value={form.authQuerySecret}
          onChange={(authQuerySecret) => update(model, { authQuerySecret })}
          names={inputs.secrets}
          read={inputs.reads.secrets}
          typed={Boolean(model.typing.authQuerySecret)}
          onTyped={(typed) => {
            Mobx.runInAction(() => {
              model.typing.authQuerySecret = typed;
            });
          }}
          noneLabel="The operator's own user"
          placeholder="The operator's own user"
          hint="The user PgBouncer connects as to run the auth query. Given together with the query, or not at all."
          unverifiedHint="The secrets could not be listed: the name goes unverified."
          error={errors.authQuerySecret}
          warning={warnings.authQuerySecret}
        />
        <TextField
          label="Auth query"
          value={form.authQuery}
          onChange={(authQuery) => update(model, { authQuery })}
          inputTestId={`${TEST_ID}-auth-query`}
          testId={`${TEST_ID}-auth-query-field`}
          placeholder="SELECT usename, passwd FROM user_search($1)"
          effective="the operator's own query, SELECT usename, passwd FROM public.user_search($1), run as cnpg_pooler_pgbouncer"
          error={errors.authQuery}
        />
      </CollapsibleSection>
    </>
  );
});

export interface OpenCreatePoolerOptions {
  namespace?: string;
  cluster?: string;
}

function open(model: PoolerCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => poolerFacts(model.inputs, model.form),
      form: () => <PoolerCreateForm model={model} />,
      yaml: () => toYaml(poolerBody(model.form)),
      blockReason: () => poolerBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: async () => {
        const { name, namespace } = model.form;
        const body = poolerBody(model.form);
        const attempted = { verb: "create" as const, resource: "poolers", namespace };
        try {
          const created = await Pooler.getStore<Pooler>().create({ name, namespace }, body as never);
          const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
          Notifications.ok(
            <span>
              {poolerSuccessMessage(namespace, name)}
              {url ? (
                <>
                  {" "}
                  <MaybeLink to={url}>Open it</MaybeLink>
                </>
              ) : null}
            </span>,
          );
        } catch (error) {
          const failure = apiFailureFacts(error);
          const notice = isAlreadyExists(failure)
            ? `A pooler named ${name} appeared in ${namespace} in the meantime: pick another name.`
            : failureSentence(failure, attempted);
          loadNamespaced(model, namespace);
          open(model, true, notice);
        }
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create Pooler form: from the floating button of the list, or from a cluster with its namespace and name set. */
export function openCreatePoolerDialog(options: OpenCreatePoolerOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
