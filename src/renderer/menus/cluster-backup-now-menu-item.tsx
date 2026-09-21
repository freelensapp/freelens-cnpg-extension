/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Back up now" in the menu of a PostgreSQL cluster (SPEC-0020): one `create`
// of a `Backup`, confirmed in a dialog that says which method, which instance
// and what is ahead of it in the queue. The decisions are in
// `components/backup-now.ts`; this file reads the stores, renders the three
// fields and sends the one request.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { openActionDialog, actionDialogStyles as styles } from "../components/action-dialog";
import {
  backupMethodOptions,
  backupNameError,
  backupNowBlockReason,
  backupNowBody,
  backupNowDialogFacts,
  canBackUpNow,
  defaultBackupForm,
  defaultBackupName,
} from "../components/backup-now";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "../components/write-actions";
import { ActionMenuItem } from "./action-menu-item";

import type { AccessQuestion } from "../components/access-review";
import type { ActionDialogModel } from "../components/action-dialog";
import type {
  BackupNowClusterFacts,
  BackupNowForm,
  BackupTargetChoice,
  ExistingBackupFacts,
} from "../components/backup-now";

const { observer } = MobxReact;

const {
  Component: { Input, MaybeLink, Notifications, Select },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Back up now";

export interface ClusterBackupNowMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
}

export function backupNowClusterFacts(object: Cluster): BackupNowClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    hibernated: Cluster.getHibernation(object),
    spec: object.spec,
    status: {
      currentPrimary: object.status?.currentPrimary,
      readyInstances: Cluster.getReadyInstances(object),
    },
  };
}

function liveCluster(object: Cluster): Cluster {
  const store = maybe(() => Cluster.getStore<Cluster>());
  const selfLink = object.metadata?.selfLink;
  return (selfLink ? store?.getByPath(selfLink) : undefined) ?? object;
}

function access(object: Cluster): AccessQuestion[] {
  return [
    { verb: "create", group: "postgresql.cnpg.io", resource: "backups", namespace: object.metadata?.namespace ?? "" },
  ];
}

/** The backups of the cluster and the names of its schedules, as the stores hold them right now. */
function related(cluster: BackupNowClusterFacts): { existing: ExistingBackupFacts[]; schedules: string[] } {
  const backups = maybe(() => Backup.getStore<Backup>())?.items ?? [];
  const schedules = maybe(() => ScheduledBackup.getStore<ScheduledBackup>())?.items ?? [];
  return {
    existing: backups
      .filter(
        (backup) => backup.metadata?.namespace === cluster.namespace && Backup.getClusterName(backup) === cluster.name,
      )
      .map((backup) => ({ name: backup.metadata?.name ?? "", phase: Backup.getPhase(backup) })),
    schedules: schedules
      .filter(
        (schedule) =>
          schedule.metadata?.namespace === cluster.namespace && schedule.spec?.cluster?.name === cluster.name,
      )
      .map((schedule) => schedule.metadata?.name ?? ""),
  };
}

const TARGET_OPTIONS: Array<{ value: BackupTargetChoice; label: string }> = [
  { value: "default", label: "The cluster's default" },
  { value: "primary", label: "Primary" },
  { value: "prefer-standby", label: "Prefer a standby" },
];

interface FormProps {
  cluster: BackupNowClusterFacts;
  form: BackupNowForm;
}

const BackupNowFormFields = observer(({ cluster, form }: FormProps) => {
  const options = backupMethodOptions(cluster);
  const { existing, schedules } = related(cluster);
  const nameError = backupNameError(form.name, schedules, existing);

  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>Method</span>
        {options.length === 1 ? (
          <span data-testid="cnpg-backup-now-method">{options[0].label}</span>
        ) : (
          <Select
            id="cnpg-backup-now-method"
            themeName="light"
            menuClass={styles.selectMenu}
            value={form.methodId}
            options={options.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(option: { value: string } | null) => {
              Mobx.runInAction(() => {
                form.methodId = option?.value ?? "";
              });
            }}
          />
        )}
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Target</span>
        <Select
          id="cnpg-backup-now-target"
          themeName="light"
          menuClass={styles.selectMenu}
          value={form.target}
          options={TARGET_OPTIONS}
          onChange={(option: { value: BackupTargetChoice } | null) => {
            Mobx.runInAction(() => {
              form.target = option?.value ?? "default";
            });
          }}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Name</span>
        <Input
          value={form.name}
          data-testid="cnpg-backup-now-name"
          onChange={(value: string) => {
            Mobx.runInAction(() => {
              form.name = value;
            });
          }}
        />
        {nameError ? <span className={styles.error}>{nameError}</span> : null}
      </div>
    </>
  );
});

/** Asks for the backups and the schedules of the namespace, so the queue note and the name check see them. */
function loadRelated(namespace: string): void {
  for (const store of [
    maybe(() => Backup.getStore<Backup>()),
    maybe(() => ScheduledBackup.getStore<ScheduledBackup>()),
  ]) {
    store?.loadAll({ namespaces: [namespace], merge: true, onLoadFailure: () => undefined })?.catch(() => undefined);
  }
}

function openBackupNow(object: Cluster, form?: BackupNowForm, model?: ActionDialogModel, changedNotice?: string): void {
  const cluster = backupNowClusterFacts(object);
  const values = form ?? Mobx.observable(defaultBackupForm(cluster, new Date()));

  loadRelated(cluster.namespace);

  const run = async () => {
    const body = backupNowBody(cluster, values);
    const store = maybe(() => Backup.getStore<Backup>());
    if (!body || !store) {
      Notifications.error(
        `Could not back up ${cluster.namespace}/${cluster.name}: the backups of the cluster are not available.`,
      );
      return;
    }
    try {
      const created = await store.create({ name: body.metadata.name, namespace: body.metadata.namespace }, body);
      const selfLink = created?.selfLink;
      Notifications.ok(
        <p data-testid="cnpg-backup-now-requested">
          {"Backup "}
          {selfLink ? (
            <MaybeLink to={getDetailsUrl(selfLink)}>{body.metadata.name}</MaybeLink>
          ) : (
            <b>{body.metadata.name}</b>
          )}
          {` of ${cluster.namespace}/${cluster.name} requested. The operator does the rest: follow it in the Backups list.`}
        </p>,
      );
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (isAlreadyExists(failure)) {
        // The name was taken between the check and the create: the dialog comes
        // back with the values intact and the next free name proposed.
        Mobx.runInAction(() => {
          values.name = defaultBackupName(cluster.name, new Date());
        });
        openBackupNow(
          liveCluster(object),
          values,
          model,
          `A backup named ${body.metadata.name} exists already: a new name is proposed.`,
        );
        return;
      }
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not back up ${cluster.namespace}/${cluster.name}. ${failureSentence(failure, {
            verb: "create",
            resource: "backups",
            namespace: cluster.namespace,
          })}`,
        );
      }
    }
  };

  openActionDialog(
    {
      title: TITLE,
      testId: "cnpg-backup-now-dialog",
      facts: () => backupNowDialogFacts(cluster, values, related(cluster).existing),
      form: () => <BackupNowFormFields cluster={cluster} form={values} />,
      blockReason: () => {
        const { existing, schedules } = related(cluster);
        const reason = backupNowBlockReason(cluster, values, schedules, existing);
        // The name error is shown under its own field.
        return reason === backupNameError(values.name, schedules, existing) ? undefined : reason;
      },
      okBlocked: () => {
        const { existing, schedules } = related(cluster);
        return Boolean(backupNowBlockReason(cluster, values, schedules, existing));
      },
      changedNotice,
      run,
    },
    model,
    Boolean(changedNotice),
  );
}

export function ClusterBackupNowMenuItem({ object, toolbar }: ClusterBackupNowMenuItemProps) {
  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title={TITLE}
      icon="backup"
      testId="cnpg-cluster-backup-now-menu-item"
      access={access}
      guard={(cluster) => canBackUpNow(backupNowClusterFacts(cluster))}
      live={liveCluster}
      open={(cluster) => openBackupNow(cluster)}
    />
  );
}
