/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create ObjectStore dialog (SPEC-0026): the host wiring around the pure
// decisions of `object-store-create.ts`. It reads on open the object stores
// and the secrets of the namespace (with their keys, for the key pickers),
// asks the API server whether the account may create a store there (W3),
// renders the provider, its credentials, the WAL and data settings and the
// retention, and sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import { OBJECT_NAME_HINT } from "./cluster-create";
import {
  CheckboxField,
  ChoiceField,
  CollapsibleSection,
  FactField,
  Field,
  Inline,
  KeyValueEditor,
  openCreateDialog,
  RadioField,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import { SecretKeyField } from "./create-pickers";
import {
  DATA_COMPRESSIONS,
  defaultObjectStoreForm,
  ENCRYPTIONS,
  emptyObjectStoreInputs,
  objectStoreBlockReason,
  objectStoreBody,
  objectStoreErrors,
  objectStoreFacts,
  objectStoreSuccessMessage,
  objectStoreWarnings,
  WAL_COMPRESSIONS,
} from "./object-store-create";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { ActionDialogModel } from "./action-dialog";
import type { ReadState } from "./create-dialog";
import type { KeyValue } from "./create-forms";
import type { ObjectStoreForm, ObjectStoreInputs, SecretKeyRef } from "./object-store-create";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  K8sApi: { namespaceStore, secretsApi },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Create object store";
const TEST_ID = "cnpg-create-object-store";

interface StoreCreateModel extends ActionDialogModel {
  form: ObjectStoreForm;
  inputs: ObjectStoreInputs;
  open: { walData: boolean; retention: boolean; tags: boolean };
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
}

function createModel(namespace: string, fixedNamespace: string | undefined): StoreCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultObjectStoreForm(namespace),
      inputs: emptyObjectStoreInputs(),
      open: { walData: false, retention: false, tags: false },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
    },
    { inputs: Mobx.observable.ref },
  );
}

function update(model: StoreCreateModel, patch: Partial<ObjectStoreForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function setInputs(
  model: StoreCreateModel,
  patch: Partial<ObjectStoreInputs>,
  read?: keyof ObjectStoreInputs["reads"],
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
  model: StoreCreateModel,
  key: keyof ObjectStoreInputs["reads"],
  fetchItems: () => Promise<T[] | null | undefined>,
  fold: (items: T[]) => Partial<ObjectStoreInputs>,
): Promise<void> {
  setInputs(model, {}, key, "loading");
  try {
    const items = (await fetchItems()) ?? [];
    setInputs(model, fold(items), key, "ready");
  } catch {
    setInputs(model, {}, key, "unavailable");
  }
}

interface SecretLike {
  getName(): string;
  data?: Record<string, string>;
}

function loadNamespaced(model: StoreCreateModel, namespace: string): void {
  if (namespace === "") return;
  void read<ObjectStore>(
    model,
    "stores",
    () => ObjectStore.getStore<ObjectStore>().api.list({ namespace }),
    (items) => ({ stores: items.map((item) => item.getName()) }),
  );
  void read<SecretLike>(
    model,
    "secrets",
    () => secretsApi.list({ namespace }) as unknown as Promise<SecretLike[] | null>,
    (items) => ({ secrets: items.map((item) => ({ name: item.getName(), keys: Object.keys(item.data ?? {}) })) }),
  );
}

function askAccess(model: StoreCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "barmancloud.cnpg.io", resource: "objectstores", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function changeNamespace(model: StoreCreateModel, namespace: string): void {
  update(model, { namespace });
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
}

function toggle(model: StoreCreateModel, section: keyof StoreCreateModel["open"]): void {
  Mobx.runInAction(() => {
    model.open[section] = !model.open[section];
  });
}

function typing(model: StoreCreateModel, field: string): boolean {
  return Boolean(model.typing[field]);
}

function setTyping(model: StoreCreateModel, field: string, value: boolean): void {
  Mobx.runInAction(() => {
    model.typing[field] = value;
  });
}

interface RefFieldProps {
  model: StoreCreateModel;
  field: keyof Pick<
    ObjectStoreForm,
    | "endpointCA"
    | "s3AccessKeyId"
    | "s3SecretAccessKey"
    | "azureConnectionString"
    | "azureStorageAccount"
    | "azureStorageKey"
    | "azureSasToken"
    | "googleCredentials"
  >;
  label: string;
  hint?: string;
}

const RefField = observer(({ model, field, label, hint }: RefFieldProps) => {
  const { form, inputs } = model;
  const errors = objectStoreErrors(inputs, form);
  const warnings = objectStoreWarnings(inputs, form);
  return (
    <SecretKeyField
      testId={`${TEST_ID}-${field}`}
      label={label}
      value={form[field]}
      onChange={(value: SecretKeyRef) => update(model, { [field]: value } as Partial<ObjectStoreForm>)}
      secrets={inputs.secrets}
      read={inputs.reads.secrets}
      typed={typing(model, field)}
      onTyped={(value) => setTyping(model, field, value)}
      hint={hint}
      error={errors[field]}
      warning={warnings[field]}
    />
  );
});

const CredentialsSection = observer(({ model }: { model: StoreCreateModel }) => {
  const { form } = model;
  if (form.provider === "s3") {
    return (
      <>
        <RadioField
          label="Authentication"
          name={`${TEST_ID}-s3-auth`}
          value={form.s3Auth}
          onChange={(s3Auth) => update(model, { s3Auth })}
          testId={`${TEST_ID}-s3-auth`}
          choices={[
            {
              value: "keys",
              label: "An access key pair from a secret",
              hint: "The access key id and the secret access key, each a key of a secret.",
            },
            {
              value: "iam",
              label: "The IAM role of the nodes",
              hint: "No secret: the pods inherit the role of the node or of the service account.",
            },
          ]}
        />
        {form.s3Auth === "keys" ? (
          <>
            <RefField model={model} field="s3AccessKeyId" label="Access key id" />
            <RefField model={model} field="s3SecretAccessKey" label="Secret access key" />
          </>
        ) : null}
      </>
    );
  }
  if (form.provider === "azure") {
    return (
      <>
        <RadioField
          label="Authentication"
          name={`${TEST_ID}-azure-auth`}
          value={form.azureAuth}
          onChange={(azureAuth) => update(model, { azureAuth })}
          testId={`${TEST_ID}-azure-auth`}
          choices={[
            { value: "connectionString", label: "A connection string from a secret" },
            { value: "storageKey", label: "A storage account and its key, from a secret" },
            { value: "sasToken", label: "A storage account and a SAS token, from a secret" },
            {
              value: "azureAd",
              label: "Azure AD workload identity",
              hint: "The storage account from a secret; the pods inherit the identity.",
            },
            {
              value: "defaultCredentials",
              label: "The default Azure credentials of the environment",
              hint: "The storage account from a secret; the environment supplies the rest.",
            },
          ]}
        />
        {form.azureAuth === "connectionString" ? (
          <RefField model={model} field="azureConnectionString" label="Connection string" />
        ) : null}
        {form.azureAuth !== "connectionString" ? (
          <RefField model={model} field="azureStorageAccount" label="Storage account" />
        ) : null}
        {form.azureAuth === "storageKey" ? (
          <RefField model={model} field="azureStorageKey" label="Storage key" />
        ) : null}
        {form.azureAuth === "sasToken" ? <RefField model={model} field="azureSasToken" label="SAS token" /> : null}
      </>
    );
  }
  return (
    <>
      <RadioField
        label="Authentication"
        name={`${TEST_ID}-google-auth`}
        value={form.googleAuth}
        onChange={(googleAuth) => update(model, { googleAuth })}
        testId={`${TEST_ID}-google-auth`}
        choices={[
          {
            value: "credentials",
            label: "Application credentials from a secret",
            hint: "The JSON key file of a service account, as a key of a secret.",
          },
          {
            value: "gke",
            label: "The GKE environment",
            hint: "No secret: the pods inherit the identity of the node pool or the workload.",
          },
        ]}
      />
      {form.googleAuth === "credentials" ? (
        <RefField model={model} field="googleCredentials" label="Application credentials" />
      ) : null}
    </>
  );
});

const StoreCreateForm = observer(({ model }: { model: StoreCreateModel }) => {
  const { form, inputs } = model;
  const errors = objectStoreErrors(inputs, form);
  const warnings = objectStoreWarnings(inputs, form);
  const tagErrors = (field: "tags" | "historyTags") => (index: number) => ({
    key: errors[`${field}.${index}.key`],
    value: undefined,
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
      <TextField
        label="Name"
        value={form.name}
        onChange={(name) => update(model, { name })}
        placeholder="backups"
        inputTestId={`${TEST_ID}-name`}
        testId={`${TEST_ID}-name-field`}
        hint={`${OBJECT_NAME_HINT} Clusters name it in their plugin entry.`}
        error={errors.name}
        warning={warnings.name}
      />
      <RadioField
        label="Provider"
        name={`${TEST_ID}-provider`}
        value={form.provider}
        onChange={(provider) => update(model, { provider })}
        testId={`${TEST_ID}-provider`}
        choices={[
          { value: "s3", label: "S3 or compatible", hint: "AWS S3, MinIO, Ceph, Linode, DigitalOcean and the like." },
          { value: "azure", label: "Azure Blob Storage" },
          { value: "google", label: "Google Cloud Storage" },
        ]}
      />
      <TextField
        label="Destination path"
        value={form.destinationPath}
        onChange={(destinationPath) => update(model, { destinationPath })}
        placeholder={
          form.provider === "s3"
            ? "s3://bucket/path/"
            : form.provider === "azure"
              ? "https://account.blob.core.windows.net/container/folder/"
              : "gs://bucket/folder/"
        }
        inputTestId={`${TEST_ID}-destination`}
        testId={`${TEST_ID}-destination-field`}
        hint="Each cluster archives in a folder of its own name under this path."
        error={errors.destinationPath}
      />
      {form.provider === "s3" ? (
        <TextField
          label="Endpoint URL"
          value={form.endpointURL}
          onChange={(endpointURL) => update(model, { endpointURL })}
          placeholder="https://minio.example.svc:9000 (empty for AWS)"
          inputTestId={`${TEST_ID}-endpoint`}
          testId={`${TEST_ID}-endpoint-field`}
          hint="Required for anything but AWS S3."
          error={errors.endpointURL}
        />
      ) : null}
      <CredentialsSection model={model} />
      <CollapsibleSection
        title="WAL and base backups"
        hint={`WAL ${form.walCompression || "not compressed"}${form.walEncryption ? `, ${form.walEncryption}` : ""}; backups ${form.dataCompression || "not compressed"}${form.dataEncryption ? `, ${form.dataEncryption}` : ""}.`}
        open={model.open.walData}
        onToggle={() => toggle(model, "walData")}
        testId={`${TEST_ID}-wal-data-section`}
      >
        <Inline>
          <ChoiceField
            id={`${TEST_ID}-wal-compression`}
            label="WAL compression"
            value={form.walCompression}
            options={WAL_COMPRESSIONS.map((value) => ({ value, label: value || "none" }))}
            onChange={(walCompression) => update(model, { walCompression })}
          />
          <ChoiceField
            id={`${TEST_ID}-wal-encryption`}
            label="WAL encryption"
            value={form.walEncryption}
            options={ENCRYPTIONS.map((value) => ({ value, label: value || "none" }))}
            onChange={(walEncryption) => update(model, { walEncryption })}
            hint="Server side encryption of an S3 store."
          />
          <TextField
            label="Max parallel"
            value={form.walMaxParallel}
            onChange={(walMaxParallel) => update(model, { walMaxParallel })}
            inputTestId={`${TEST_ID}-wal-parallel`}
            testId={`${TEST_ID}-wal-parallel-field`}
            placeholder="1"
            hint="WAL files archived at once."
            error={errors.walMaxParallel}
          />
        </Inline>
        <Inline>
          <ChoiceField
            id={`${TEST_ID}-data-compression`}
            label="Backup compression"
            value={form.dataCompression}
            options={DATA_COMPRESSIONS.map((value) => ({ value, label: value || "none" }))}
            onChange={(dataCompression) => update(model, { dataCompression })}
          />
          <ChoiceField
            id={`${TEST_ID}-data-encryption`}
            label="Backup encryption"
            value={form.dataEncryption}
            options={ENCRYPTIONS.map((value) => ({ value, label: value || "none" }))}
            onChange={(dataEncryption) => update(model, { dataEncryption })}
          />
          <TextField
            label="Jobs"
            value={form.dataJobs}
            onChange={(dataJobs) => update(model, { dataJobs })}
            inputTestId={`${TEST_ID}-data-jobs`}
            testId={`${TEST_ID}-data-jobs-field`}
            placeholder="1"
            hint="Parallel uploads of a base backup."
            error={errors.dataJobs}
          />
        </Inline>
        <CheckboxField
          label="Immediate checkpoint"
          checked={form.dataImmediateCheckpoint}
          onChange={(dataImmediateCheckpoint) => update(model, { dataImmediateCheckpoint })}
          testId={`${TEST_ID}-immediate-checkpoint`}
          hint="A base backup starts with a checkpoint at once instead of one spread over time."
        />
        <RefField
          model={model}
          field="endpointCA"
          label="Endpoint CA (optional)"
          hint="The CA certificate of a private endpoint, as a key of a secret."
        />
      </CollapsibleSection>
      <CollapsibleSection
        title="Retention"
        hint={
          form.retentionAmount.trim() === ""
            ? "No retention policy: kept forever."
            : `Backups kept ${form.retentionAmount} ${form.retentionUnit === "d" ? "day" : form.retentionUnit === "w" ? "week" : "month"}${form.retentionAmount === "1" ? "" : "s"}.`
        }
        open={model.open.retention}
        onToggle={() => toggle(model, "retention")}
        testId={`${TEST_ID}-retention-section`}
      >
        <Inline>
          <TextField
            label="Keep backups for"
            value={form.retentionAmount}
            onChange={(retentionAmount) => update(model, { retentionAmount })}
            inputTestId={`${TEST_ID}-retention-amount`}
            testId={`${TEST_ID}-retention-amount-field`}
            placeholder="30"
            hint="Empty keeps everything forever."
            error={errors.retentionAmount}
          />
          <ChoiceField
            id={`${TEST_ID}-retention-unit`}
            label="Unit"
            value={form.retentionUnit}
            options={[
              { value: "d", label: "days" },
              { value: "w", label: "weeks" },
              { value: "m", label: "months" },
            ]}
            onChange={(retentionUnit) => update(model, { retentionUnit })}
          />
          <TextField
            label="Check every (seconds)"
            value={form.retentionIntervalSeconds}
            onChange={(retentionIntervalSeconds) => update(model, { retentionIntervalSeconds })}
            inputTestId={`${TEST_ID}-retention-interval`}
            testId={`${TEST_ID}-retention-interval-field`}
            placeholder="1800"
            effective="1800 seconds"
            error={errors.retentionIntervalSeconds}
          />
        </Inline>
      </CollapsibleSection>
      <CollapsibleSection
        title="Tags"
        hint={`${form.tags.length} tag${form.tags.length === 1 ? "" : "s"} on the backups, ${form.historyTags.length} on the WAL history.`}
        open={model.open.tags}
        onToggle={() => toggle(model, "tags")}
        testId={`${TEST_ID}-tags-section`}
      >
        <Field label="Tags" hint="Set on every object the store writes." testId={`${TEST_ID}-tags-field`}>
          <KeyValueEditor
            rows={form.tags}
            onChange={(tags: KeyValue[]) => update(model, { tags })}
            errors={tagErrors("tags")}
            keyPlaceholder="env"
            valuePlaceholder="prod"
            addLabel="Add a tag"
            testId={`${TEST_ID}-tags`}
          />
        </Field>
        <Field label="History tags" hint="Set on the WAL files only." testId={`${TEST_ID}-history-tags-field`}>
          <KeyValueEditor
            rows={form.historyTags}
            onChange={(historyTags: KeyValue[]) => update(model, { historyTags })}
            errors={tagErrors("historyTags")}
            keyPlaceholder="team"
            valuePlaceholder="db"
            addLabel="Add a history tag"
            testId={`${TEST_ID}-history-tags`}
          />
        </Field>
      </CollapsibleSection>
    </>
  );
});

export interface OpenCreateObjectStoreOptions {
  namespace?: string;
}

function open(model: StoreCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => objectStoreFacts(model.inputs, model.form),
      form: () => <StoreCreateForm model={model} />,
      yaml: () => toYaml(objectStoreBody(model.form)),
      blockReason: () => objectStoreBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: async () => {
        const { name, namespace } = model.form;
        const body = objectStoreBody(model.form);
        const attempted = { verb: "create" as const, resource: "objectstores", namespace };
        try {
          const created = await ObjectStore.getStore<ObjectStore>().create({ name, namespace }, body as never);
          const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
          Notifications.ok(
            <span>
              {objectStoreSuccessMessage(namespace, name)}
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
            ? `An object store named ${name} appeared in ${namespace} in the meantime: pick another name.`
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

/** Opens the Create ObjectStore form from the floating button of the Object Stores page. */
export function openCreateObjectStoreDialog(options: OpenCreateObjectStoreOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.namespace);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
