/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Create ScheduledBackup dialog (SPEC-0026): the host wiring around the
// pure decisions of `scheduled-backup-create.ts` and `cron.ts`. It reads on
// open the clusters and the schedules of the namespace and whether the
// VolumeSnapshot CRD exists, asks the API server whether the account may
// create a schedule there (W3), renders the cron editor with the next runs,
// and sends the one `create` whose YAML the user read.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
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
  openCreateDialog,
  RadioField,
  createDialogStyles as styles,
  TextField,
} from "./create-dialog";
import { defaultNamespace, toYaml } from "./create-forms";
import { ObjectChoiceField } from "./create-pickers";
import { formatRun, nextRuns, WEEKDAY_NAMES } from "./cron";
import { describeSchedule, SCHEDULE_TIME_ZONE_NOTE } from "./cron-text";
import {
  defaultMethodId,
  defaultScheduledBackupForm,
  emptyScheduledBackupInputs,
  scheduledBackupBlockReason,
  scheduledBackupBody,
  scheduledBackupErrors,
  scheduledBackupFacts,
  scheduledBackupSuccessMessage,
  scheduledBackupWarnings,
  scheduleExpression,
  scheduleMethodOptions,
} from "./scheduled-backup-create";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "./write-actions";

import type { ActionDialogModel } from "./action-dialog";
import type { ReadState } from "./create-dialog";
import type { CronPreset } from "./cron";
import type { ScheduledBackupForm, ScheduledBackupInputs } from "./scheduled-backup-create";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, NamespaceSelect, Notifications },
  K8sApi: { crdApi, namespaceStore },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Create scheduled backup";
const TEST_ID = "cnpg-create-schedule";
const VOLUME_SNAPSHOT_CRD = "volumesnapshots.snapshot.storage.k8s.io";

interface ScheduleCreateModel extends ActionDialogModel {
  form: ScheduledBackupForm;
  inputs: ScheduledBackupInputs;
  open: { options: boolean };
  typing: Record<string, boolean>;
  accessReason?: string;
  fixedNamespace?: string;
  fixedCluster?: string;
}

function createModel(
  namespace: string,
  cluster: string | undefined,
  fixedNamespace: string | undefined,
): ScheduleCreateModel {
  return Mobx.observable(
    {
      ...createActionDialogModel(false),
      form: defaultScheduledBackupForm(namespace, cluster ?? ""),
      inputs: emptyScheduledBackupInputs(),
      open: { options: false },
      typing: {},
      accessReason: undefined,
      fixedNamespace,
      fixedCluster: cluster,
    },
    { inputs: Mobx.observable.ref },
  );
}

function update(model: ScheduleCreateModel, patch: Partial<ScheduledBackupForm>): void {
  Mobx.runInAction(() => {
    Object.assign(model.form, patch);
  });
}

function setInputs(
  model: ScheduleCreateModel,
  patch: Partial<ScheduledBackupInputs>,
  read?: keyof ScheduledBackupInputs["reads"],
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
  model: ScheduleCreateModel,
  key: keyof ScheduledBackupInputs["reads"],
  fetchItems: () => Promise<T[] | null | undefined>,
  fold: (items: T[]) => Partial<ScheduledBackupInputs>,
): Promise<void> {
  setInputs(model, {}, key, "loading");
  try {
    const items = (await fetchItems()) ?? [];
    setInputs(model, fold(items), key, "ready");
  } catch {
    setInputs(model, {}, key, "unavailable");
  }
}

/** The method follows the cluster: the first usable one of the new cluster, once its facts are in. */
function followCluster(model: ScheduleCreateModel): void {
  update(model, { methodId: defaultMethodId(model.inputs, model.form) });
}

function loadNamespaced(model: ScheduleCreateModel, namespace: string): void {
  if (namespace === "") return;
  void read<Cluster>(
    model,
    "clusters",
    () => Cluster.getStore<Cluster>().api.list({ namespace }),
    (items) => ({
      clusters: items.map((item) => ({
        name: item.getName(),
        namespace,
        hibernated: Cluster.getHibernation(item),
        phase: item.status?.phase,
        spec: { plugins: item.spec?.plugins, backup: item.spec?.backup },
      })),
    }),
  ).then(() => {
    if (model.form.methodId === "") followCluster(model);
  });
  void read<ScheduledBackup>(
    model,
    "schedules",
    () => ScheduledBackup.getStore<ScheduledBackup>().api.list({ namespace }),
    (items) => ({ schedules: items.map((item) => item.getName()) }),
  );
}

function loadClusterWide(model: ScheduleCreateModel): void {
  setInputs(model, {}, "crds", "loading");
  crdApi
    .get({ name: VOLUME_SNAPSHOT_CRD })
    .then((crd) => setInputs(model, { volumeSnapshotCrd: Boolean(crd) }, "crds", "ready"))
    .catch((error: unknown) => {
      // A 404 is an answer: the CRD is not there. Anything else leaves the fact unknown.
      const code = (error as { statusCode?: number; code?: number })?.statusCode ?? (error as { code?: number })?.code;
      if (code === 404) setInputs(model, { volumeSnapshotCrd: false }, "crds", "ready");
      else setInputs(model, {}, "crds", "unavailable");
    });
}

function askAccess(model: ScheduleCreateModel, namespace: string): void {
  if (namespace === "") return;
  const question = { verb: "create" as const, group: "postgresql.cnpg.io", resource: "scheduledbackups", namespace };
  void sharedAccessReviews()
    .ask(question)
    .then((answer) => {
      const guard = accessGuard([question], [answer]);
      Mobx.runInAction(() => {
        model.accessReason = guard.enabled ? undefined : guard.reason;
      });
    });
}

function changeNamespace(model: ScheduleCreateModel, namespace: string): void {
  update(model, { namespace, cluster: "", methodId: "" });
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
}

function changeCluster(model: ScheduleCreateModel, cluster: string): void {
  const previous = model.form.cluster;
  const patch: Partial<ScheduledBackupForm> = { cluster, methodId: "" };
  // The default name follows the cluster until the user typed one of their own.
  if (model.form.name === "" || model.form.name === `${previous}-daily`) patch.name = cluster ? `${cluster}-daily` : "";
  update(model, patch);
  followCluster(model);
}

const PRESETS: Array<{ value: CronPreset; label: string; hint: string }> = [
  { value: "hourly", label: "Every hour", hint: "At the minute given." },
  { value: "daily", label: "Every day", hint: "At the time given." },
  { value: "weekly", label: "Every week", hint: "On the day and at the time given." },
  { value: "monthly", label: "Every month", hint: "On the day of the month and at the time given." },
  {
    value: "custom",
    label: "A cron expression",
    hint: "Six fields, seconds first, as the operator reads them; or @hourly, @daily, @every 1h30m.",
  },
];

const CronEditor = observer(({ model }: { model: ScheduleCreateModel }) => {
  const { form, inputs } = model;
  const errors = scheduledBackupErrors(inputs, form);
  const cron = form.cron;
  const setCron = (patch: Partial<typeof cron>) => update(model, { cron: { ...cron, ...patch } });
  const expression = scheduleExpression(form);
  const words = errors.cron ? undefined : describeSchedule(expression);
  const runs = errors.cron ? [] : nextRuns(expression, new Date(), 3).map(formatRun);
  return (
    <>
      <RadioField
        label="Schedule"
        name={`${TEST_ID}-preset`}
        value={cron.preset}
        onChange={(preset) => setCron({ preset })}
        testId={`${TEST_ID}-preset`}
        choices={PRESETS}
      />
      {cron.preset !== "custom" ? (
        <Inline>
          {cron.preset === "weekly" ? (
            <ChoiceField
              id={`${TEST_ID}-weekday`}
              label="Day of the week"
              value={cron.weekday}
              options={WEEKDAY_NAMES.map((day, index) => ({ value: String(index), label: day }))}
              onChange={(weekday) => setCron({ weekday })}
            />
          ) : null}
          {cron.preset === "monthly" ? (
            <TextField
              label="Day of the month"
              value={cron.monthDay}
              onChange={(monthDay) => setCron({ monthDay })}
              inputTestId={`${TEST_ID}-month-day`}
              placeholder="1"
            />
          ) : null}
          {cron.preset !== "hourly" ? (
            <TextField
              label="Hour (UTC)"
              value={cron.hour}
              onChange={(hour) => setCron({ hour })}
              inputTestId={`${TEST_ID}-hour`}
              placeholder="3"
            />
          ) : null}
          <TextField
            label="Minute"
            value={cron.minute}
            onChange={(minute) => setCron({ minute })}
            inputTestId={`${TEST_ID}-minute`}
            placeholder="0"
          />
        </Inline>
      ) : (
        <TextField
          label="Expression"
          value={cron.custom}
          onChange={(custom) => setCron({ custom })}
          inputTestId={`${TEST_ID}-custom`}
          placeholder="0 0 3 * * *"
          hint="seconds minutes hours day-of-month month day-of-week"
        />
      )}
      <Field label="The expression sent" error={errors.cron} testId={`${TEST_ID}-expression`}>
        <div className={styles.fact}>
          <code data-testid={`${TEST_ID}-expression-value`}>{expression || "?"}</code>
          {words ? (
            <div
              className={styles.hint}
              data-testid={`${TEST_ID}-expression-words`}
            >{`${words} (${SCHEDULE_TIME_ZONE_NOTE})`}</div>
          ) : null}
          {runs.length > 0 ? (
            <div className={styles.hint} data-testid={`${TEST_ID}-next-runs`}>
              {`Next runs: ${runs.join(", ")}`}
            </div>
          ) : null}
        </div>
      </Field>
    </>
  );
});

const ScheduleCreateForm = observer(({ model }: { model: ScheduleCreateModel }) => {
  const { form, inputs } = model;
  const errors = scheduledBackupErrors(inputs, form);
  const warnings = scheduledBackupWarnings(inputs, form);
  const methods = scheduleMethodOptions(inputs, form);
  const picked = methods.find((option) => option.id === form.methodId);
  const snapshot = picked?.method === "volumeSnapshot";
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
              ? "hibernated: runs fail until it is resumed"
              : !(cluster.spec?.plugins ?? []).some((plugin) => plugin.isWALArchiver && plugin.enabled !== false)
                ? "no WAL archiver: no point in time recovery"
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
      <TextField
        label="Name"
        value={form.name}
        onChange={(name) => update(model, { name })}
        placeholder={form.cluster ? `${form.cluster}-daily` : "pg-daily"}
        inputTestId={`${TEST_ID}-name`}
        testId={`${TEST_ID}-name-field`}
        hint={`${OBJECT_NAME_HINT} Each run creates a Backup named after it and the time of the run.`}
        error={errors.name}
        warning={warnings.name}
      />
      <CronEditor model={model} />
      <ChoiceField
        id={`${TEST_ID}-method`}
        label="Method"
        value={form.methodId}
        placeholder={form.cluster ? "Pick a method" : "Pick a cluster first"}
        options={methods.map((option) => ({ value: option.id, label: option.label, reason: option.reason }))}
        onChange={(methodId) => update(model, { methodId })}
        hint="Always sent: the API's own default is the deprecated in-tree method."
        error={errors.methodId}
        testId={`${TEST_ID}-method-field`}
      />
      <ChoiceField
        id={`${TEST_ID}-target`}
        label="Target"
        value={form.target}
        options={[
          { value: "default", label: "The cluster's default" },
          { value: "primary", label: "Always the primary" },
          { value: "prefer-standby", label: "A standby when there is one, else the primary" },
        ]}
        onChange={(target) => update(model, { target })}
        effective="the cluster's backup target, prefer-standby unless it says otherwise"
      />
      {snapshot ? (
        <CollapsibleSection
          title="Volume snapshot options"
          hint={
            form.online
              ? "Online snapshot: the instance keeps serving."
              : "Offline snapshot: the instance is fenced for the duration."
          }
          open={model.open.options}
          onToggle={() => {
            Mobx.runInAction(() => {
              model.open.options = !model.open.options;
            });
          }}
          testId={`${TEST_ID}-snapshot-section`}
        >
          <CheckboxField
            label="Online"
            checked={form.online}
            onChange={(online) => update(model, { online })}
            testId={`${TEST_ID}-online`}
            hint="The snapshot is taken while the instance serves; offline fences it first."
          />
          {form.online ? (
            <>
              <CheckboxField
                label="Immediate checkpoint"
                checked={form.immediateCheckpoint}
                onChange={(immediateCheckpoint) => update(model, { immediateCheckpoint })}
                testId={`${TEST_ID}-immediate-checkpoint`}
                hint="Checkpoint at once instead of spread over time: faster, more I/O."
              />
              <CheckboxField
                label="Wait for archive"
                checked={form.waitForArchive}
                onChange={(waitForArchive) => update(model, { waitForArchive })}
                testId={`${TEST_ID}-wait-for-archive`}
                hint="The backup completes only once the WAL of the snapshot is archived."
              />
            </>
          ) : null}
        </CollapsibleSection>
      ) : null}
      <CheckboxField
        label="Take a first backup right away"
        checked={form.immediate}
        onChange={(immediate) => update(model, { immediate })}
        testId={`${TEST_ID}-immediate`}
        hint="A backup dated now, as soon as the schedule exists; the operator writes the next run time only after a first backup."
      />
      <CheckboxField
        label="Create suspended"
        checked={form.suspend}
        onChange={(suspend) => update(model, { suspend })}
        testId={`${TEST_ID}-suspend`}
        hint="Nothing runs until the schedule is resumed."
      />
      <RadioField
        label="Who owns the backups"
        name={`${TEST_ID}-owner`}
        value={form.owner}
        onChange={(owner) => update(model, { owner })}
        testId={`${TEST_ID}-owner`}
        choices={[
          { value: "none", label: "Nobody", hint: "The backups outlive the schedule and the cluster." },
          { value: "self", label: "The schedule", hint: "Deleting the schedule deletes its backups." },
          { value: "cluster", label: "The cluster", hint: "Deleting the cluster deletes the backups." },
        ]}
      />
    </>
  );
});

export interface OpenCreateScheduledBackupOptions {
  /** The namespace of the cluster the form was opened from (F4): shown as a fact. */
  namespace?: string;
  /** The cluster the form was opened from (F1): shown as a fact. */
  cluster?: string;
}

function open(model: ScheduleCreateModel, delayed: boolean, changedNotice?: string): void {
  openCreateDialog(
    {
      title: TITLE,
      testId: TEST_ID,
      facts: () => scheduledBackupFacts(model.inputs, model.form, new Date()),
      form: () => <ScheduleCreateForm model={model} />,
      yaml: () => toYaml(scheduledBackupBody(model.inputs, model.form)),
      blockReason: () => scheduledBackupBlockReason(model.inputs, model.form, model.accessReason),
      changedNotice,
      run: async () => {
        const { name, namespace } = model.form;
        const body = scheduledBackupBody(model.inputs, model.form);
        const attempted = { verb: "create" as const, resource: "scheduledbackups", namespace };
        try {
          const created = await ScheduledBackup.getStore<ScheduledBackup>().create({ name, namespace }, body as never);
          const url = created?.selfLink ? getDetailsUrl(created.selfLink) : undefined;
          Notifications.ok(
            <span>
              {scheduledBackupSuccessMessage(namespace, name)}
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
            ? `A scheduled backup named ${name} appeared in ${namespace} in the meantime: pick another name.`
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

/** Opens the Create ScheduledBackup form: from the floating button of the list, or from a cluster with its namespace and name set. */
export function openCreateScheduledBackupDialog(options: OpenCreateScheduledBackupOptions = {}): void {
  const namespace = options.namespace ?? defaultNamespace(maybe(() => namespaceStore.contextNamespaces) ?? []);
  const model = createModel(namespace, options.cluster, options.namespace);
  loadClusterWide(model);
  loadNamespaced(model, namespace);
  askAccess(model, namespace);
  open(model, false);
}
