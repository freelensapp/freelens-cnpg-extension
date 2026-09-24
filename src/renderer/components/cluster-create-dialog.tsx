/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create Cluster dialog (SPEC-0025): the host wiring around the pure
// decisions of `cluster-create.ts`. It reads on open what the pickers offer
// (the clusters, object stores, catalogs, backups and secrets of the
// namespace, the storage classes and the operator's default image of the
// Kubernetes cluster), asks the API server whether the account may create a
// cluster there (W3), renders the fields, and sends the one `create` whose
// YAML the user read. The model lives outside React, as in every dialog of
// the extension: a reopen after a refusal keeps every value.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import {
  orderSnapshots,
  snapshotFacts,
  snapshotLabel,
  snapshotReason,
  VOLUME_SNAPSHOT_CRD_NAME,
  volumeSnapshotApi,
  volumeSnapshotClassApi,
} from "../api/snapshot/volume-snapshot-v1";
import { accessGuard, sharedAccessReviews } from "./access-review";
import { createActionDialogModel } from "./action-dialog";
import {
  CLUSTER_NAME_HINT,
  catalogKey,
  clusterCreateBlockReason,
  clusterCreateBody,
  clusterCreateFacts,
  clusterCreateSuccessMessage,
  clusterEffectiveValues,
  clusterFormErrors,
  clusterFormWarnings,
  defaultClusterForm,
  emptyClusterCreateInputs,
  emptyTablespaceRow,
  pickedCatalog,
  TABLESPACE_HINT,
} from "./cluster-create";
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
import { defaultNamespace, OPERATOR_WRITTEN_PARAMETERS, toYaml } from "./create-forms";
import { ObjectChoiceField } from "./create-pickers";
import { findOperators } from "./operator";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { SnapshotRole, VolumeSnapshot, VolumeSnapshotClass } from "../api/snapshot/volume-snapshot-v1";
import type { ActionDialogModel } from "./action-dialog";
import type { ClusterCreateInputs, ClusterForm, ReadState, TablespaceRow } from "./cluster-create";
import type { KeyValue } from "./create-forms";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  K8sApi: { crdApi, deploymentApi, namespaceStore, secretsApi, storageClassApi },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Create PostgreSQL cluster";
const TEST_ID = "cnpg-create-cluster";
const BASIC_AUTH = "kubernetes.io/basic-auth";
const OPERATOR_IMAGE_ENV = "POSTGRES_IMAGE_NAME";

export type ClusterSection =
  | "wal"
  | "tablespaces"
  | "initdbOptions"
  | "recoveryArchive"
  | "backupOptions"
  | "replication"
  | "resources"
  | "updates"
  | "scheduling";

interface ClusterCreateModel extends ActionDialogModel {
  form: ClusterForm;
  inputs: ClusterCreateInputs;
  open: Record<ClusterSection, boolean>;
  /** The pickers the user switched to typing (F7), kept here so a reopen keeps them. */
  typing: Record<string, boolean>;
  /** The denial of the access review (W3), when there is one. */
  accessReason?: string;
  /** The namespace the form was opened from, when it came from a cluster: shown as a fact (F4). */
  fixedNamespace?: string;
}

function createModel(namespace: string, fixedNamespace?: string): ClusterCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultClusterForm(namespace),
      inputs: emptyClusterCreateInputs(namespaceStore.contextNamespaces),
      open: {
        wal: false,
        tablespaces: false,
        initdbOptions: false,
        recoveryArchive: false,
        backupOptions: false,
        replication: false,
        resources: false,
        updates: false,
        scheduling: false,
      },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
    },
    { inputs: Mobx.observable.ref },
  );
}

function update(model: ClusterCreateModel, patch: Partial<ClusterForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function setInputs(
  model: ClusterCreateModel,
  patch: Partial<ClusterCreateInputs>,
  read?: keyof ClusterCreateInputs["reads"],
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

/** One read on open (F7): what it found, or `unavailable` when it failed. Nothing blocks on it. */
async function read<T>(
  model: ClusterCreateModel,
  key: keyof ClusterCreateInputs["reads"],
  fetchItems: () => Promise<T[] | null | undefined>,
  fold: (items: T[]) => Partial<ClusterCreateInputs>,
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

/** The reads that depend on the namespace. Run again when it changes. */
function loadNamespaced(model: ClusterCreateModel, namespace: string): void {
  if (namespace === "") return;
  void read<Cluster>(
    model,
    "clusters",
    () => Cluster.getStore<Cluster>().api.list({ namespace }),
    (items) => ({ clusters: items.map((item) => item.getName()) }),
  );
  void read<ObjectStore>(
    model,
    "objectStores",
    () => ObjectStore.getStore<ObjectStore>().api.list({ namespace }),
    (items) => ({ objectStores: items.map((item) => item.getName()) }),
  );
  void read<Backup>(
    model,
    "backups",
    () => Backup.getStore<Backup>().api.list({ namespace }),
    (items) => ({
      backups: items.map((item) => ({
        name: item.getName(),
        cluster: Backup.getClusterName(item) ?? "",
        phase: Backup.getPhase(item),
      })),
    }),
  );
  void read<SecretLike>(
    model,
    "secrets",
    () => secretsApi.list({ namespace }) as unknown as Promise<SecretLike[] | null>,
    (items) => ({
      secrets: items
        .filter((item) => item.type === BASIC_AUTH)
        .map((item) => ({ name: item.getName(), type: item.type, username: decode(item.data?.username) })),
    }),
  );
  void read(
    model,
    "catalogs",
    async () => {
      const [namespaced, clusterWide] = await Promise.all([
        ImageCatalog.getStore<ImageCatalog>().api.list({ namespace }),
        ClusterImageCatalog.getStore<ClusterImageCatalog>()
          .api.list()
          .catch(() => []),
      ]);
      return [...(namespaced ?? []), ...(clusterWide ?? [])];
    },
    (items) => ({
      catalogs: items.map((item) => ({
        kind: item.kind === "ClusterImageCatalog" ? ("ClusterImageCatalog" as const) : ("ImageCatalog" as const),
        name: item.getName(),
        majors: (item.spec?.images ?? []).map((image) => image.major).filter((major) => Number.isFinite(major)),
      })),
    }),
  );
  // The snapshots of the namespace, for a recovery from volume snapshots (SPEC-0029): a 404 on a
  // Kubernetes cluster without the CRD leaves the picker a text field, as any failed read.
  void read<VolumeSnapshot>(
    model,
    "volumeSnapshots",
    () => volumeSnapshotApi().list({ namespace }),
    (items) => ({ volumeSnapshots: items.map((item) => snapshotFacts(item)) }),
  );
}

/** The reads that do not depend on the namespace. */
function loadClusterWide(model: ClusterCreateModel): void {
  void read<VolumeSnapshotClass>(
    model,
    "snapshotClasses",
    () => volumeSnapshotClassApi().list(),
    (items) => ({ snapshotClasses: items.map((item) => ({ name: item.getName(), driver: item.driver })) }),
  );
  // Whether the volumeSnapshot method can exist here at all (SPEC-0029, as SPEC-0026 checks it).
  setInputs(model, {}, "crds", "loading");
  crdApi
    .get({ name: VOLUME_SNAPSHOT_CRD_NAME })
    .then((crd) => setInputs(model, { volumeSnapshotCrd: Boolean(crd) }, "crds", "ready"))
    .catch((error: unknown) => {
      // A 404 is an answer: the CRD is not there. Anything else leaves the fact unknown.
      const code = (error as { statusCode?: number; code?: number })?.statusCode ?? (error as { code?: number })?.code;
      if (code === 404) setInputs(model, { volumeSnapshotCrd: false }, "crds", "ready");
      else setInputs(model, {}, "crds", "unavailable");
    });
  void read<{ getName(): string }>(
    model,
    "storageClasses",
    () => storageClassApi.list(),
    (items) => ({ storageClasses: items.map((item) => item.getName()) }),
  );
  void (async () => {
    try {
      const deployments = (await deploymentApi.list()) ?? [];
      const operator = findOperators(deployments as never[])[0] as
        | { spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } } }
        | undefined;
      const env = operator?.spec?.template?.spec?.containers?.flatMap((container) => container.env ?? []) ?? [];
      const image = env.find((entry) => entry.name === OPERATOR_IMAGE_ENV)?.value;
      if (image) setInputs(model, { operatorImage: image });
    } catch {
      // The default image stays "the operator's default": a read that fails never blocks a form.
    }
  })();
}

function askAccess(model: ClusterCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "clusters", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function changeNamespace(model: ClusterCreateModel, namespace: string): void {
  update(model, { namespace });
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
}

function toggle(model: ClusterCreateModel, section: ClusterSection): void {
  Mobx.runInAction(() => {
    model.open[section] = !model.open[section];
  });
}

function typing(model: ClusterCreateModel, field: string): boolean {
  return Boolean(model.typing[field]);
}

function setTyping(model: ClusterCreateModel, field: string, value: boolean): void {
  Mobx.runInAction(() => {
    model.typing[field] = value;
  });
}

interface SectionProps {
  model: ClusterCreateModel;
}

const IdentitySection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
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
        placeholder="pg-main"
        inputTestId={`${TEST_ID}-name`}
        testId={`${TEST_ID}-name-field`}
        hint={CLUSTER_NAME_HINT}
        error={errors.name}
        warning={warnings.name}
      />
      <TextField
        label="Description"
        value={form.description}
        onChange={(description) => update(model, { description })}
        placeholder="What this cluster is for (optional)"
        inputTestId={`${TEST_ID}-description`}
      />
      <TextField
        label="Instances"
        value={form.instances}
        onChange={(instances) => update(model, { instances })}
        inputTestId={`${TEST_ID}-instances`}
        testId={`${TEST_ID}-instances-field`}
        hint="One primary and the standbys. One instance means no failover and no standby to read from."
        error={errors.instances}
      />
    </>
  );
});

const ImageSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  const catalog = pickedCatalog(inputs, form);
  return (
    <>
      <RadioField
        label="Image"
        name={`${TEST_ID}-image`}
        value={form.imageSource}
        onChange={(imageSource) => update(model, { imageSource })}
        testId={`${TEST_ID}-image`}
        choices={[
          {
            value: "operator",
            label: "The operator's default",
            hint: `Nothing is sent: the operator stamps ${effective.image}.`,
          },
          {
            value: "catalog",
            label: "An image catalog",
            hint:
              inputs.reads.catalogs === "ready" && inputs.catalogs.length === 0
                ? "No ImageCatalog in the namespace and no ClusterImageCatalog: the two other choices stay."
                : "A catalog names one image per PostgreSQL major, and the cluster follows it.",
          },
          { value: "name", label: "An image name", hint: "A reference whose tag is the PostgreSQL version." },
        ]}
      />
      {form.imageSource === "catalog" ? (
        <Inline>
          <ChoiceField
            id={`${TEST_ID}-catalog`}
            label="Catalog"
            value={form.catalog}
            placeholder="Pick a catalog"
            options={inputs.catalogs.map((candidate) => ({
              value: catalogKey(candidate),
              label: `${candidate.name} (${candidate.kind === "ClusterImageCatalog" ? "cluster wide" : "namespace"})`,
            }))}
            onChange={(picked) => update(model, { catalog: picked, catalogMajor: "" })}
            error={errors.catalog}
            warning={warnings.catalog}
            testId={`${TEST_ID}-catalog-field`}
          />
          <ChoiceField
            id={`${TEST_ID}-catalog-major`}
            label="PostgreSQL major"
            value={form.catalogMajor}
            placeholder="Pick a major"
            options={(catalog?.majors ?? []).map((major) => ({ value: String(major), label: `PostgreSQL ${major}` }))}
            onChange={(catalogMajor) => update(model, { catalogMajor })}
            error={errors.catalogMajor}
            testId={`${TEST_ID}-catalog-major-field`}
          />
        </Inline>
      ) : null}
      {form.imageSource === "name" ? (
        <TextField
          label="Image name"
          value={form.imageName}
          onChange={(imageName) => update(model, { imageName })}
          placeholder="ghcr.io/cloudnative-pg/postgresql:17.2"
          inputTestId={`${TEST_ID}-image-name`}
          testId={`${TEST_ID}-image-name-field`}
          hint="The operator refuses latest and a digest alone: it reads the version from the tag."
          error={errors.imageName}
        />
      ) : null}
    </>
  );
});

const StorageSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  return (
    <>
      <Inline>
        <TextField
          label="Storage size"
          value={form.storageSize}
          onChange={(storageSize) => update(model, { storageSize })}
          placeholder="10Gi"
          inputTestId={`${TEST_ID}-storage-size`}
          testId={`${TEST_ID}-storage-size-field`}
          hint="The volume of each instance. It can grow later, never shrink."
          error={errors.storageSize}
        />
        <ObjectPicker
          id={`${TEST_ID}-storage-class`}
          inputTestId={`${TEST_ID}-storage-class-input`}
          label="Storage class"
          value={form.storageClass}
          onChange={(storageClass) => update(model, { storageClass })}
          names={inputs.storageClasses}
          read={inputs.reads.storageClasses}
          typed={typing(model, "storageClass")}
          onTyped={(value) => setTyping(model, "storageClass", value)}
          noneLabel="The default storage class"
          placeholder="The default storage class"
          effective={effective.storageClass}
          unverifiedHint="The storage classes could not be listed: the name goes unverified."
          warning={warnings.storageClass}
        />
      </Inline>
      <CollapsibleSection
        title="WAL on its own volume"
        hint={
          form.walEnabled
            ? `A separate volume of ${form.walSize || "?"} for the WAL.`
            : "The WAL shares the data volume unless a volume of its own is given here."
        }
        open={model.open.wal}
        onToggle={() => toggle(model, "wal")}
        testId={`${TEST_ID}-wal-section`}
      >
        <CheckboxField
          label="Give the WAL a volume of its own"
          checked={form.walEnabled}
          onChange={(walEnabled) => update(model, { walEnabled })}
          hint="It can be added later, never removed once set."
          testId={`${TEST_ID}-wal-enabled`}
        />
        {form.walEnabled ? (
          <Inline>
            <TextField
              label="WAL volume size"
              value={form.walSize}
              onChange={(walSize) => update(model, { walSize })}
              placeholder="2Gi"
              inputTestId={`${TEST_ID}-wal-size`}
              testId={`${TEST_ID}-wal-size-field`}
              error={errors.walSize}
            />
            <ObjectPicker
              id={`${TEST_ID}-wal-class`}
              inputTestId={`${TEST_ID}-wal-class-input`}
              label="WAL storage class"
              value={form.walClass}
              onChange={(walClass) => update(model, { walClass })}
              names={inputs.storageClasses}
              read={inputs.reads.storageClasses}
              typed={typing(model, "walClass")}
              onTyped={(value) => setTyping(model, "walClass", value)}
              noneLabel="The default storage class"
              placeholder="The default storage class"
              unverifiedHint="The storage classes could not be listed: the name goes unverified."
            />
          </Inline>
        ) : null}
      </CollapsibleSection>
    </>
  );
});

const TablespacesSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  const rows = form.tablespaces;
  const setRows = (tablespaces: TablespaceRow[]) => update(model, { tablespaces });
  const patch = (index: number, change: Partial<TablespaceRow>) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  return (
    <CollapsibleSection
      title={rows.length > 0 ? `Tablespaces (${rows.length})` : "Tablespaces"}
      hint={TABLESPACE_HINT}
      open={model.open.tablespaces}
      onToggle={() => toggle(model, "tablespaces")}
      testId={`${TEST_ID}-tablespaces-section`}
    >
      <div className={styles.rows} data-testid={`${TEST_ID}-tablespaces`}>
        {rows.map((row, index) => (
          <div key={`${TEST_ID}-tablespace-${index}`} data-testid={`${TEST_ID}-tablespaces-${index}`}>
            <Inline>
              <TextField
                label="Name"
                value={row.name}
                onChange={(name) => patch(index, { name })}
                placeholder="analytics"
                inputTestId={`${TEST_ID}-tablespaces-${index}-name`}
                testId={`${TEST_ID}-tablespaces-${index}-name-field`}
                hint="A PostgreSQL identifier; it cannot be changed later."
                error={errors[`tablespaces.${index}.name`]}
              />
              <TextField
                label="Size"
                value={row.size}
                onChange={(size) => patch(index, { size })}
                placeholder="5Gi"
                inputTestId={`${TEST_ID}-tablespaces-${index}-size`}
                testId={`${TEST_ID}-tablespaces-${index}-size-field`}
                hint="One volume per instance. It can grow later, never shrink."
                error={errors[`tablespaces.${index}.size`]}
              />
              <ObjectPicker
                id={`${TEST_ID}-tablespaces-${index}-class`}
                inputTestId={`${TEST_ID}-tablespaces-${index}-class-input`}
                label="Storage class"
                value={row.storageClass}
                onChange={(storageClass) => patch(index, { storageClass })}
                names={inputs.storageClasses}
                read={inputs.reads.storageClasses}
                typed={typing(model, `tablespaces.${index}.storageClass`)}
                onTyped={(value) => setTyping(model, `tablespaces.${index}.storageClass`, value)}
                noneLabel="The default storage class"
                placeholder="The default storage class"
                unverifiedHint="The storage classes could not be listed: the name goes unverified."
                warning={warnings[`tablespaces.${index}.storageClass`]}
              />
            </Inline>
            <Inline>
              <TextField
                label="Owner"
                value={row.owner}
                onChange={(owner) => patch(index, { owner })}
                placeholder="Optional"
                inputTestId={`${TEST_ID}-tablespaces-${index}-owner`}
                testId={`${TEST_ID}-tablespaces-${index}-owner-field`}
                effective={effective.tablespaceOwner}
                error={errors[`tablespaces.${index}.owner`]}
              />
              <CheckboxField
                label="Temporary"
                checked={row.temporary}
                onChange={(temporary) => patch(index, { temporary })}
                hint="Joins temp_tablespaces: temporary objects and files land here."
                testId={`${TEST_ID}-tablespaces-${index}-temporary`}
              />
            </Inline>
            <div>
              <button
                type="button"
                className={styles.button}
                data-testid={`${TEST_ID}-tablespaces-${index}-remove`}
                onClick={() => setRows(rows.filter((_, at) => at !== index))}
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
            data-testid={`${TEST_ID}-tablespaces-add`}
            onClick={() => setRows([...rows, emptyTablespaceRow()])}
          >
            Add tablespace
          </button>
        </div>
      </div>
    </CollapsibleSection>
  );
});

/** The object store and the server name of a WAL archive: the object store recovery, or the archive next to snapshots. */
const RecoveryArchiveFields = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  return (
    <Inline>
      <ObjectPicker
        id={`${TEST_ID}-recovery-store`}
        inputTestId={`${TEST_ID}-recovery-store-input`}
        label="Object store"
        value={form.recoveryObjectStore}
        onChange={(recoveryObjectStore) => update(model, { recoveryObjectStore })}
        names={inputs.objectStores}
        read={inputs.reads.objectStores}
        typed={typing(model, "recoveryObjectStore")}
        onTyped={(value) => setTyping(model, "recoveryObjectStore", value)}
        placeholder="Pick an object store"
        unverifiedHint="The object stores could not be listed: the name goes unverified."
        error={errors.recoveryObjectStore}
        warning={warnings.recoveryObjectStore}
      />
      <TextField
        label="Source server name"
        value={form.recoveryServerName}
        onChange={(recoveryServerName) => update(model, { recoveryServerName })}
        placeholder="The name of the cluster that wrote the backups"
        inputTestId={`${TEST_ID}-recovery-server`}
        testId={`${TEST_ID}-recovery-server-field`}
        hint="The folder in the store: the source cluster's name, unless it archived under another."
        error={errors.recoveryServerName}
      />
    </Inline>
  );
});

/** A recovery from volume snapshots (SPEC-0029): the data snapshot, the WAL and tablespace snapshots, the archive. */
const SnapshotRecoveryFields = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  const choicesOf = (role: SnapshotRole, tablespace?: string) =>
    orderSnapshots(inputs.volumeSnapshots, role, tablespace).map((facts) => ({
      name: facts.name,
      label: snapshotLabel(facts),
      reason: snapshotReason(facts, role, tablespace),
    }));
  const unverified = "The snapshots could not be listed: the name goes unverified.";
  return (
    <>
      <ObjectChoiceField
        id={`${TEST_ID}-recovery-data-snapshot`}
        testId={`${TEST_ID}-recovery-data-snapshot`}
        label="Data snapshot"
        value={form.recoveryDataSnapshot}
        onChange={(recoveryDataSnapshot) => update(model, { recoveryDataSnapshot })}
        choices={choicesOf("PG_DATA")}
        read={inputs.reads.volumeSnapshots}
        typed={typing(model, "recoveryDataSnapshot")}
        onTyped={(value) => setTyping(model, "recoveryDataSnapshot", value)}
        placeholder="Pick the snapshot of the data volume"
        unverifiedHint={unverified}
        hint="The PG_DATA snapshot of a backup taken with the volume snapshot method."
        error={errors.recoveryDataSnapshot}
        warning={warnings.recoveryDataSnapshot}
      />
      {form.walEnabled ? (
        <ObjectChoiceField
          id={`${TEST_ID}-recovery-wal-snapshot`}
          testId={`${TEST_ID}-recovery-wal-snapshot`}
          label="WAL snapshot"
          value={form.recoveryWalSnapshot}
          onChange={(recoveryWalSnapshot) => update(model, { recoveryWalSnapshot })}
          choices={choicesOf("PG_WAL")}
          read={inputs.reads.volumeSnapshots}
          typed={typing(model, "recoveryWalSnapshot")}
          onTyped={(value) => setTyping(model, "recoveryWalSnapshot", value)}
          placeholder="Optional: the snapshot of the WAL volume"
          unverifiedHint={unverified}
          hint="The PG_WAL snapshot of the same backup, restored as the WAL volume."
          error={errors.recoveryWalSnapshot}
          warning={warnings.recoveryWalSnapshot}
        />
      ) : null}
      {form.tablespaces.map((row) => {
        const tablespace = row.name.trim();
        if (tablespace === "") return null;
        return (
          <ObjectChoiceField
            key={tablespace}
            id={`${TEST_ID}-recovery-tablespace-snapshot-${tablespace}`}
            testId={`${TEST_ID}-recovery-tablespace-snapshot-${tablespace}`}
            label={`Snapshot of the tablespace ${tablespace}`}
            value={form.recoveryTablespaceSnapshots[tablespace] ?? ""}
            onChange={(name) =>
              update(model, {
                recoveryTablespaceSnapshots: { ...form.recoveryTablespaceSnapshots, [tablespace]: name },
              })
            }
            choices={choicesOf("PG_TABLESPACE", tablespace)}
            read={inputs.reads.volumeSnapshots}
            typed={typing(model, `recoveryTablespaceSnapshots.${tablespace}`)}
            onTyped={(value) => setTyping(model, `recoveryTablespaceSnapshots.${tablespace}`, value)}
            placeholder="Optional: the snapshot of this tablespace"
            unverifiedHint={unverified}
            hint="A tablespace of the backup with no snapshot here makes the recovery fail on the missing volume."
            warning={warnings[`recoveryTablespaceSnapshots.${tablespace}`]}
          />
        );
      })}
      <CollapsibleSection
        title="WAL archive of the source"
        hint={
          form.recoveryWalArchive
            ? `The WAL of ${form.recoveryServerName || "?"} in ${form.recoveryObjectStore || "?"} finishes the recovery.`
            : "Optional: what finishes a hot snapshot, and what a point in time needs."
        }
        open={model.open.recoveryArchive}
        onToggle={() => toggle(model, "recoveryArchive")}
        testId={`${TEST_ID}-recovery-archive-section`}
      >
        <CheckboxField
          label="Give the WAL archive of the source"
          checked={form.recoveryWalArchive}
          onChange={(recoveryWalArchive) => update(model, { recoveryWalArchive })}
          hint="The object store the source archived to and the name it archived under, sent as the recovery source and an external cluster."
          testId={`${TEST_ID}-recovery-wal-archive`}
        />
        {form.recoveryWalArchive ? <RecoveryArchiveFields model={model} /> : null}
      </CollapsibleSection>
    </>
  );
});

const BootstrapSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const warnings = clusterFormWarnings(inputs, form);
  const secrets = inputs.secrets.map((secret) => secret.name);
  const backups = inputs.backups;
  return (
    <>
      <RadioField
        label="Bootstrap"
        name={`${TEST_ID}-bootstrap`}
        value={form.bootstrap}
        onChange={(bootstrap) => update(model, { bootstrap })}
        testId={`${TEST_ID}-bootstrap`}
        hint="Read once, when the first instance is created, and ignored afterwards."
        choices={[
          { value: "initdb", label: "A new database", hint: "initdb: an empty database with its owner." },
          {
            value: "recovery",
            label: "Recovery from a backup or an object store",
            hint: "The new cluster starts from the data of another one, up to a point in time when asked.",
          },
        ]}
      />
      {form.bootstrap === "initdb" ? (
        <>
          <Inline>
            <TextField
              label="Database"
              value={form.initdbDatabase}
              onChange={(initdbDatabase) => update(model, { initdbDatabase })}
              inputTestId={`${TEST_ID}-initdb-database`}
              testId={`${TEST_ID}-initdb-database-field`}
              error={errors.initdbDatabase}
            />
            <TextField
              label="Owner"
              value={form.initdbOwner}
              onChange={(initdbOwner) => update(model, { initdbOwner })}
              inputTestId={`${TEST_ID}-initdb-owner`}
              testId={`${TEST_ID}-initdb-owner-field`}
              error={errors.initdbOwner}
            />
          </Inline>
          <ObjectPicker
            id={`${TEST_ID}-initdb-secret`}
            inputTestId={`${TEST_ID}-initdb-secret-input`}
            label="Password of the owner"
            value={form.initdbSecret}
            onChange={(initdbSecret) => update(model, { initdbSecret })}
            names={secrets}
            read={inputs.reads.secrets}
            typed={typing(model, "initdbSecret")}
            onTyped={(value) => setTyping(model, "initdbSecret", value)}
            noneLabel="Generated by the operator"
            placeholder="Generated by the operator"
            hint="A kubernetes.io/basic-auth secret whose username is the owner. Left empty, the operator generates one."
            unverifiedHint="The secrets could not be listed: the name goes unverified."
            warning={warnings.initdbSecret}
          />
          <CollapsibleSection
            title="Options of the new database"
            hint="Encoding, locale and checksums: creation only, they cannot change later."
            open={model.open.initdbOptions}
            onToggle={() => toggle(model, "initdbOptions")}
            testId={`${TEST_ID}-initdb-options-section`}
          >
            <Inline>
              <TextField
                label="Encoding"
                value={form.initdbEncoding}
                onChange={(initdbEncoding) => update(model, { initdbEncoding })}
                placeholder="UTF8"
                inputTestId={`${TEST_ID}-initdb-encoding`}
                effective="UTF8"
              />
              <ChoiceField
                id={`${TEST_ID}-initdb-locale-provider`}
                label="Locale provider"
                value={form.initdbLocaleProvider}
                options={[
                  { value: "", label: "The operator's default (libc)" },
                  { value: "libc", label: "libc" },
                  { value: "icu", label: "icu (PostgreSQL 15 and newer)" },
                  { value: "builtin", label: "builtin (PostgreSQL 17 and newer)" },
                ]}
                onChange={(initdbLocaleProvider) => update(model, { initdbLocaleProvider })}
              />
              <TextField
                label="Locale"
                value={form.initdbLocale}
                onChange={(initdbLocale) => update(model, { initdbLocale })}
                placeholder={form.initdbLocaleProvider === "icu" ? "en-US" : "C"}
                inputTestId={`${TEST_ID}-initdb-locale`}
                testId={`${TEST_ID}-initdb-locale-field`}
                effective="C"
                error={errors.initdbLocale}
              />
            </Inline>
            <CheckboxField
              label="Data checksums"
              checked={form.initdbDataChecksums}
              onChange={(initdbDataChecksums) => update(model, { initdbDataChecksums })}
              hint="Detects corruption on disk at a small cost per write."
              testId={`${TEST_ID}-initdb-checksums`}
            />
          </CollapsibleSection>
        </>
      ) : (
        <>
          <RadioField
            label="Recover from"
            name={`${TEST_ID}-recovery-source`}
            value={form.recoverySource}
            onChange={(recoverySource) => update(model, { recoverySource })}
            testId={`${TEST_ID}-recovery-source`}
            choices={[
              { value: "backup", label: "A completed backup of this namespace" },
              { value: "objectStore", label: "An object store, by the name the source cluster archived under" },
              {
                value: "volumeSnapshots",
                label: "The volume snapshots of a backup",
                hint: "The data snapshot becomes the volume of the first instance; a hot snapshot is finished with the WAL archive of the source.",
                disabledReason:
                  inputs.volumeSnapshotCrd === false
                    ? "The VolumeSnapshot CRD is not installed in this Kubernetes cluster"
                    : undefined,
              },
            ]}
          />
          {form.recoverySource === "backup" ? (
            backups.length > 0 || inputs.reads.backups !== "ready" ? (
              <ChoiceField
                id={`${TEST_ID}-recovery-backup`}
                label="Backup"
                value={form.recoveryBackup}
                placeholder="Pick a backup"
                options={backups.map((backup) => ({
                  value: backup.name,
                  label: `${backup.name} (${backup.cluster})`,
                  reason: backup.phase === "completed" ? undefined : `${backup.phase ?? "not completed"}`,
                }))}
                onChange={(recoveryBackup) => update(model, { recoveryBackup })}
                error={errors.recoveryBackup}
                warning={warnings.recoveryBackup}
                testId={`${TEST_ID}-recovery-backup-field`}
              />
            ) : (
              <TextField
                label="Backup"
                value={form.recoveryBackup}
                onChange={(recoveryBackup) => update(model, { recoveryBackup })}
                placeholder="The name of a completed Backup of this namespace"
                inputTestId={`${TEST_ID}-recovery-backup-input`}
                testId={`${TEST_ID}-recovery-backup-field`}
                hint="No backup was found in the namespace: type the name of one."
                error={errors.recoveryBackup}
              />
            )
          ) : form.recoverySource === "volumeSnapshots" ? (
            <SnapshotRecoveryFields model={model} />
          ) : (
            <RecoveryArchiveFields model={model} />
          )}
          <TextField
            label="Recover up to"
            value={form.recoveryTargetTime}
            onChange={(recoveryTargetTime) => update(model, { recoveryTargetTime })}
            placeholder="2026-09-22T10:30:00Z (optional)"
            inputTestId={`${TEST_ID}-recovery-target`}
            testId={`${TEST_ID}-recovery-target-field`}
            hint="A point in time (RFC 3339). Left empty, the recovery replays everything the source archived."
            error={errors.recoveryTargetTime}
          />
        </>
      )}
    </>
  );
});

const BackupSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const warnings = clusterFormWarnings(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  return (
    <>
      <ObjectPicker
        id={`${TEST_ID}-object-store`}
        inputTestId={`${TEST_ID}-object-store-input`}
        label="WAL archiving and backups"
        value={form.objectStore}
        onChange={(objectStore) => update(model, { objectStore })}
        names={inputs.objectStores}
        read={inputs.reads.objectStores}
        typed={typing(model, "objectStore")}
        onTyped={(value) => setTyping(model, "objectStore", value)}
        noneLabel="None (no WAL archiving)"
        placeholder="Pick an object store"
        hint="The object store of the Barman Cloud plugin the WAL is archived to; its retention policy applies to the backups. Without one there is no backup and no point in time recovery."
        unverifiedHint="The object stores could not be listed: the name goes unverified."
        warning={warnings.objectStore}
      />
      <CollapsibleSection
        title="Backup options"
        hint={`Backups are taken from ${form.backupTarget || effective.backupTarget}${form.snapshotsEnabled ? `, as ${form.snapshotMode} volume snapshots` : ""}.`}
        open={model.open.backupOptions}
        onToggle={() => toggle(model, "backupOptions")}
        testId={`${TEST_ID}-backup-options-section`}
      >
        <ChoiceField
          id={`${TEST_ID}-backup-target`}
          label="Backup target"
          value={form.backupTarget}
          options={[
            { value: "", label: "The operator's default" },
            { value: "prefer-standby", label: "A standby when there is one, else the primary" },
            { value: "primary", label: "Always the primary" },
          ]}
          onChange={(backupTarget) => update(model, { backupTarget })}
          effective={effective.backupTarget}
        />
        <CheckboxField
          label="Take backups as volume snapshots"
          checked={form.snapshotsEnabled}
          onChange={(snapshotsEnabled) => update(model, { snapshotsEnabled })}
          hint={
            inputs.reads.crds === "unavailable"
              ? "Whether the VolumeSnapshot CRD is installed could not be checked: the operator refuses the method without it. Back up now and the schedules can then pick the volumeSnapshot method."
              : "Back up now and the schedules can then pick the volumeSnapshot method; the plugin method stays available with an object store."
          }
          testId={`${TEST_ID}-snapshots-enabled`}
          disabledReason={
            inputs.volumeSnapshotCrd === false
              ? "The VolumeSnapshot CRD is not installed in this Kubernetes cluster: the operator refuses the volumeSnapshot method"
              : undefined
          }
        />
        {form.snapshotsEnabled ? (
          <>
            <Inline>
              <ObjectPicker
                id={`${TEST_ID}-snapshot-class`}
                inputTestId={`${TEST_ID}-snapshot-class-input`}
                label="Snapshot class"
                value={form.snapshotClass}
                onChange={(snapshotClass) => update(model, { snapshotClass })}
                names={inputs.snapshotClasses.map((choice) => choice.name)}
                read={inputs.reads.snapshotClasses}
                typed={typing(model, "snapshotClass")}
                onTyped={(value) => setTyping(model, "snapshotClass", value)}
                noneLabel="The default snapshot class of the CSI driver"
                placeholder="The default snapshot class of the CSI driver"
                effective={effective.snapshotClass}
                hint="It must belong to the CSI driver of the storage class; the form cannot check that."
                unverifiedHint="The snapshot classes could not be listed: the name goes unverified."
                warning={warnings.snapshotClass}
              />
              {form.walEnabled ? (
                <ObjectPicker
                  id={`${TEST_ID}-snapshot-wal-class`}
                  inputTestId={`${TEST_ID}-snapshot-wal-class-input`}
                  label="WAL snapshot class"
                  value={form.snapshotWalClass}
                  onChange={(snapshotWalClass) => update(model, { snapshotWalClass })}
                  names={inputs.snapshotClasses.map((choice) => choice.name)}
                  read={inputs.reads.snapshotClasses}
                  typed={typing(model, "snapshotWalClass")}
                  onTyped={(value) => setTyping(model, "snapshotWalClass", value)}
                  noneLabel="The snapshot class of the data volume"
                  placeholder="The snapshot class of the data volume"
                  effective={effective.snapshotWalClass}
                  unverifiedHint="The snapshot classes could not be listed: the name goes unverified."
                  warning={warnings.snapshotWalClass}
                />
              ) : null}
            </Inline>
            <RadioField
              label="Hot or cold"
              name={`${TEST_ID}-snapshot-mode`}
              value={form.snapshotMode}
              onChange={(snapshotMode) => update(model, { snapshotMode })}
              testId={`${TEST_ID}-snapshot-mode`}
              choices={[
                {
                  value: "hot",
                  label: "Hot: PostgreSQL stays open",
                  hint: "The WAL of the snapshot window is kept with a temporary slot; the operator's default.",
                },
                {
                  value: "cold",
                  label: "Cold: the target is fenced for the duration of the snapshot",
                  hint: "On a cluster of one instance the database is unavailable meanwhile, and the operator refuses a cold snapshot while an instance is fenced.",
                },
              ]}
            />
            {form.snapshotMode === "hot" ? (
              <Inline>
                <CheckboxField
                  label="Wait for the WAL archive"
                  checked={form.snapshotWaitForArchive}
                  onChange={(snapshotWaitForArchive) => update(model, { snapshotWaitForArchive })}
                  hint="pg_backup_stop waits for the last segment to be archived; the operator's default."
                  testId={`${TEST_ID}-snapshot-wait-for-archive`}
                />
                <CheckboxField
                  label="Immediate checkpoint"
                  checked={form.snapshotImmediateCheckpoint}
                  onChange={(snapshotImmediateCheckpoint) => update(model, { snapshotImmediateCheckpoint })}
                  hint="The checkpoint that starts the backup runs as fast as possible instead of being spread out."
                  testId={`${TEST_ID}-snapshot-immediate-checkpoint`}
                />
              </Inline>
            ) : null}
            <ChoiceField
              id={`${TEST_ID}-snapshot-owner`}
              label="Owner of the snapshots"
              value={form.snapshotOwner}
              options={[
                { value: "", label: "The operator's default" },
                { value: "none", label: "Nobody: the snapshots outlive the backup and the cluster" },
                { value: "cluster", label: "The cluster: deleted with it" },
                { value: "backup", label: "The backup: deleted with it" },
              ]}
              onChange={(snapshotOwner) => update(model, { snapshotOwner })}
              effective={effective.snapshotOwner}
            />
          </>
        ) : null}
      </CollapsibleSection>
    </>
  );
});

const SuperuserSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const warnings = clusterFormWarnings(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  return (
    <>
      <CheckboxField
        label="Enable superuser access"
        checked={form.superuserAccess}
        onChange={(superuserAccess) => update(model, { superuserAccess })}
        hint="The postgres role gets a password, in the secret <name>-superuser or in the one picked below."
        effective={effective.superuserAccess}
        testId={`${TEST_ID}-superuser-access`}
      />
      {form.superuserAccess ? (
        <ObjectPicker
          id={`${TEST_ID}-superuser-secret`}
          inputTestId={`${TEST_ID}-superuser-secret-input`}
          label="Superuser secret"
          value={form.superuserSecret}
          onChange={(superuserSecret) => update(model, { superuserSecret })}
          names={inputs.secrets.map((secret) => secret.name)}
          read={inputs.reads.secrets}
          typed={typing(model, "superuserSecret")}
          onTyped={(value) => setTyping(model, "superuserSecret", value)}
          noneLabel="Generated by the operator"
          placeholder="Generated by the operator"
          hint="A kubernetes.io/basic-auth secret whose username is postgres."
          unverifiedHint="The secrets could not be listed: the name goes unverified."
          warning={warnings.superuserSecret}
        />
      ) : null}
    </>
  );
});

const ReplicationSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  const instances = Number(form.instances);
  const single = Number.isFinite(instances) && instances < 2;
  return (
    <CollapsibleSection
      title="Replication"
      hint={
        form.syncEnabled
          ? `${form.syncNumber} synchronous replica${form.syncNumber === "1" ? "" : "s"} (${form.syncMethod}).`
          : "Asynchronous streaming replication unless synchronous replicas are asked for here."
      }
      open={model.open.replication}
      onToggle={() => toggle(model, "replication")}
      testId={`${TEST_ID}-replication-section`}
    >
      <CheckboxField
        label="Synchronous replication"
        checked={form.syncEnabled}
        onChange={(syncEnabled) => update(model, { syncEnabled })}
        hint="A commit waits for the standbys before it is acknowledged."
        disabledReason={single ? "Synchronous replication needs at least two instances." : undefined}
        testId={`${TEST_ID}-sync-enabled`}
      />
      {form.syncEnabled && !single ? (
        <Inline>
          <ChoiceField
            id={`${TEST_ID}-sync-method`}
            label="Method"
            value={form.syncMethod}
            options={[
              { value: "any", label: "any: the first N standbys to answer" },
              { value: "first", label: "first: N standbys in priority order" },
            ]}
            onChange={(syncMethod) => update(model, { syncMethod })}
          />
          <TextField
            label="Number"
            value={form.syncNumber}
            onChange={(syncNumber) => update(model, { syncNumber })}
            inputTestId={`${TEST_ID}-sync-number`}
            testId={`${TEST_ID}-sync-number-field`}
            hint="Below the instances: the operator refuses a number that leaves no standby free."
            error={errors.syncNumber}
          />
          <ChoiceField
            id={`${TEST_ID}-sync-durability`}
            label="Data durability"
            value={form.syncDurability}
            options={[
              { value: "", label: "The operator's default" },
              { value: "required", label: "required: writes stop when the standbys are missing" },
              { value: "preferred", label: "preferred: writes go on alone when the standbys are missing" },
            ]}
            onChange={(syncDurability) => update(model, { syncDurability })}
            effective={effective.dataDurability}
          />
        </Inline>
      ) : null}
    </CollapsibleSection>
  );
});

const ResourcesSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  return (
    <CollapsibleSection
      title="Resources"
      hint={
        form.requestsCpu || form.requestsMemory
          ? `Requests ${form.requestsCpu || "-"} CPU, ${form.requestsMemory || "-"} memory; limits ${form.limitsCpu || "-"}, ${form.limitsMemory || "-"}.`
          : "No requests and no limits: BestEffort pods, the first evicted under pressure."
      }
      open={model.open.resources}
      onToggle={() => toggle(model, "resources")}
      testId={`${TEST_ID}-resources-section`}
    >
      <Inline>
        <TextField
          label="CPU request"
          value={form.requestsCpu}
          onChange={(requestsCpu) => update(model, { requestsCpu })}
          placeholder="500m"
          inputTestId={`${TEST_ID}-requests-cpu`}
          testId={`${TEST_ID}-requests-cpu-field`}
          error={errors.requestsCpu}
        />
        <TextField
          label="Memory request"
          value={form.requestsMemory}
          onChange={(requestsMemory) => update(model, { requestsMemory })}
          placeholder="1Gi"
          inputTestId={`${TEST_ID}-requests-memory`}
          testId={`${TEST_ID}-requests-memory-field`}
          hint="Not below shared_buffers."
          error={errors.requestsMemory}
        />
      </Inline>
      <Inline>
        <TextField
          label="CPU limit"
          value={form.limitsCpu}
          onChange={(limitsCpu) => update(model, { limitsCpu })}
          placeholder="1"
          inputTestId={`${TEST_ID}-limits-cpu`}
          testId={`${TEST_ID}-limits-cpu-field`}
          error={errors.limitsCpu}
        />
        <TextField
          label="Memory limit"
          value={form.limitsMemory}
          onChange={(limitsMemory) => update(model, { limitsMemory })}
          placeholder="1Gi"
          inputTestId={`${TEST_ID}-limits-memory`}
          testId={`${TEST_ID}-limits-memory-field`}
          hint="Equal requests and limits give the Guaranteed class the operator recommends for a database."
          error={errors.limitsMemory}
        />
      </Inline>
    </CollapsibleSection>
  );
});

const UpdatesSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  const rowErrors = (index: number) => ({
    key: errors[`parameters.${index}.key`],
    value: errors[`parameters.${index}.value`],
  });
  return (
    <CollapsibleSection
      title="Updates and PostgreSQL parameters"
      hint={`${form.updateStrategy || effective.updateStrategy} updates by ${form.updateMethod || effective.updateMethod}; ${form.parameters.length} parameter${form.parameters.length === 1 ? "" : "s"} set.`}
      open={model.open.updates}
      onToggle={() => toggle(model, "updates")}
      testId={`${TEST_ID}-updates-section`}
    >
      <Inline>
        <ChoiceField
          id={`${TEST_ID}-update-strategy`}
          label="Primary update strategy"
          value={form.updateStrategy}
          options={[
            { value: "", label: "The operator's default" },
            { value: "unsupervised", label: "unsupervised: the operator updates the primary itself" },
            {
              value: "supervised",
              label: "supervised: the primary waits for a switchover by hand",
              reason: form.instances === "1" ? "refused with one instance" : undefined,
            },
          ]}
          onChange={(updateStrategy) => update(model, { updateStrategy })}
          effective={effective.updateStrategy}
          error={errors.updateStrategy}
          testId={`${TEST_ID}-update-strategy-field`}
        />
        <ChoiceField
          id={`${TEST_ID}-update-method`}
          label="Primary update method"
          value={form.updateMethod}
          options={[
            { value: "", label: "The operator's default" },
            { value: "restart", label: "restart: the primary restarts in place" },
            { value: "switchover", label: "switchover: a standby is promoted first" },
          ]}
          onChange={(updateMethod) => update(model, { updateMethod })}
          effective={effective.updateMethod}
        />
      </Inline>
      <Field
        label="PostgreSQL parameters"
        hint={`Settings of postgresql.conf. The operator writes ${OPERATOR_WRITTEN_PARAMETERS.length} of its own on every cluster (wal_level logical among them) and refuses the ones it fixes; a value set here overrides the operator's.`}
        error={errors.parameters ? undefined : undefined}
        testId={`${TEST_ID}-parameters-field`}
      >
        <KeyValueEditor
          rows={form.parameters}
          onChange={(parameters: KeyValue[]) => update(model, { parameters })}
          errors={rowErrors}
          keyPlaceholder="shared_buffers"
          valuePlaceholder="256MB"
          addLabel="Add a parameter"
          testId={`${TEST_ID}-parameters`}
        />
      </Field>
    </CollapsibleSection>
  );
});

const SchedulingSection = observer(({ model }: SectionProps) => {
  const { form, inputs } = model;
  const errors = clusterFormErrors(inputs, form);
  const effective = clusterEffectiveValues(inputs);
  const rowErrors = (index: number) => ({
    key: errors[`nodeSelector.${index}.key`],
    value: errors[`nodeSelector.${index}.value`],
  });
  return (
    <CollapsibleSection
      title="Scheduling"
      hint={`Pod anti affinity ${form.antiAffinity || effective.antiAffinity}${form.topologyKey ? ` on ${form.topologyKey}` : ""}; ${form.nodeSelector.length} node selector${form.nodeSelector.length === 1 ? "" : "s"}.`}
      open={model.open.scheduling}
      onToggle={() => toggle(model, "scheduling")}
      testId={`${TEST_ID}-scheduling-section`}
    >
      <Inline>
        <ChoiceField
          id={`${TEST_ID}-anti-affinity`}
          label="Pod anti affinity"
          value={form.antiAffinity}
          options={[
            { value: "", label: "The operator's default" },
            { value: "preferred", label: "preferred: instances spread when they can" },
            { value: "required", label: "required: instances never share a node (or a topology key)" },
          ]}
          onChange={(antiAffinity) => update(model, { antiAffinity })}
          effective={effective.antiAffinity}
        />
        <TextField
          label="Topology key"
          value={form.topologyKey}
          onChange={(topologyKey) => update(model, { topologyKey })}
          placeholder="kubernetes.io/hostname"
          inputTestId={`${TEST_ID}-topology-key`}
          testId={`${TEST_ID}-topology-key-field`}
          effective="kubernetes.io/hostname"
          error={errors.topologyKey}
        />
      </Inline>
      <Field
        label="Node selector"
        hint="The instances run only on nodes with these labels."
        testId={`${TEST_ID}-node-selector-field`}
      >
        <KeyValueEditor
          rows={form.nodeSelector}
          onChange={(nodeSelector: KeyValue[]) => update(model, { nodeSelector })}
          errors={rowErrors}
          keyPlaceholder="disktype"
          valuePlaceholder="ssd"
          addLabel="Add a label"
          testId={`${TEST_ID}-node-selector`}
        />
      </Field>
    </CollapsibleSection>
  );
});

const ClusterCreateForm = observer(({ model }: SectionProps) => (
  <>
    <IdentitySection model={model} />
    <ImageSection model={model} />
    <StorageSection model={model} />
    <TablespacesSection model={model} />
    <BootstrapSection model={model} />
    <BackupSection model={model} />
    <SuperuserSection model={model} />
    <ReplicationSection model={model} />
    <ResourcesSection model={model} />
    <UpdatesSection model={model} />
    <SchedulingSection model={model} />
  </>
));

export interface OpenCreateClusterOptions {
  /** The namespace of the cluster the form was opened from (F4): shown as a fact. */
  namespace?: string;
}

function open(model: ClusterCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => clusterCreateFacts(model.inputs, model.form),
      form: () => <ClusterCreateForm model={model} />,
      yaml: () => toYaml(clusterCreateBody(model.form)),
      blockReason: () => clusterCreateBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: async () => {
        const { name, namespace } = model.form;
        const body = clusterCreateBody(model.form);
        const attempted = { verb: "create" as const, resource: "clusters", namespace };
        try {
          const created = await Cluster.getStore<Cluster>().create({ name, namespace }, body as never);
          const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
          Notifications.ok(
            <span>
              {clusterCreateSuccessMessage(namespace, name)}
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
            ? `A cluster named ${name} appeared in ${namespace} in the meantime: pick another name.`
            : failureSentence(failure, attempted);
          // The values stay: the dialog comes back with the answer of the API server at its top (F6).
          loadNamespaced(model, namespace);
          open(model, true, notice);
        }
      },
    },
    model,
    delayed,
  );
}

/** Opens the Create Cluster form (F1): from the floating button of the list, or from a cluster with its namespace set. */
export function openCreateClusterDialog(options: OpenCreateClusterOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.namespace);
  loadClusterWide(model);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
