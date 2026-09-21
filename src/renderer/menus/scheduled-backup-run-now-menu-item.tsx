/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Run now" in the menu of a scheduled backup (SPEC-0021): one `create` of an
// ordinary `Backup` with the settings of the schedule. It is not a run of the
// schedule, and the dialog says so: upstream has no way to trigger one. The
// decisions are in `components/scheduled-backup-actions.ts`.

import { Renderer } from "@freelensapp/extensions";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { openActionDialog } from "../components/action-dialog";
import { useReferenceStores } from "../components/reference-loader";
import { canRunNow, runNowBackup, runNowFacts } from "../components/scheduled-backup-actions";
import { apiFailureFacts, failureSentence, isAlreadyExists } from "../components/write-actions";
import { ActionMenuItem } from "./action-menu-item";
import { liveSchedule, scheduleFacts } from "./scheduled-backup-suspend-menu-item";

import type { AccessQuestion } from "../components/access-review";
import type { ScheduleClusterFacts } from "../components/scheduled-backup-actions";
import type { ScheduledBackupMenuItemProps } from "./scheduled-backup-suspend-menu-item";

const {
  Component: { MaybeLink, Notifications },
  Navigation: { getDetailsUrl },
} = Renderer;

const TITLE = "Run now";

function access(object: ScheduledBackup): AccessQuestion[] {
  return [
    { verb: "create", group: "postgresql.cnpg.io", resource: "backups", namespace: object.metadata?.namespace ?? "" },
  ];
}

/** The cluster of the schedule as the store holds it, or undefined when it is not in the namespace. */
function clusterOf(object: ScheduledBackup): ScheduleClusterFacts | undefined {
  const name = ScheduledBackup.getClusterName(object);
  const namespace = object.metadata?.namespace;
  if (!name || !namespace) return undefined;
  const cluster = maybe(() => Cluster.getStore<Cluster>())?.getByName(name, namespace) as Cluster | undefined;
  return cluster ? { name, hibernated: Cluster.getHibernation(cluster) } : undefined;
}

function openRunNow(object: ScheduledBackup, changedNotice?: string): void {
  const schedule = scheduleFacts(object);
  // One instant for the dialog and the request: the name the user reads is the name that is sent.
  const now = new Date();

  const run = async () => {
    const body = runNowBackup(schedule, now);
    const store = maybe(() => Backup.getStore<Backup>());
    if (!body || !store) {
      Notifications.error(
        `Could not request a backup for ${schedule.namespace}/${schedule.name}: the backups are not available.`,
      );
      return;
    }
    try {
      const created = await store.create({ name: body.metadata.name, namespace: body.metadata.namespace }, body);
      const selfLink = created?.selfLink;
      Notifications.ok(
        <p data-testid="cnpg-schedule-run-now-requested">
          {"Backup "}
          {selfLink ? (
            <MaybeLink to={getDetailsUrl(selfLink)}>{body.metadata.name}</MaybeLink>
          ) : (
            <b>{body.metadata.name}</b>
          )}
          {` of ${body.metadata.namespace}/${body.spec.cluster.name} requested with the settings of the schedule ${schedule.name}. The operator does the rest: follow it in the Backups list.`}
        </p>,
      );
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (isAlreadyExists(failure)) {
        // Two clicks in one second: the dialog comes back with the name of the next one.
        openRunNow(
          liveSchedule(object),
          `A backup named ${body.metadata.name} exists already: the name of this second is proposed.`,
        );
        return;
      }
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not request a backup for ${schedule.namespace}/${schedule.name}. ${failureSentence(failure, {
            verb: "create",
            resource: "backups",
            namespace: schedule.namespace,
          })}`,
        );
      }
    }
  };

  openActionDialog(
    {
      title: TITLE,
      testId: "cnpg-schedule-run-now-dialog",
      facts: () => runNowFacts(schedule, now),
      changedNotice,
      run,
    },
    undefined,
    Boolean(changedNotice),
  );
}

function RunNowMenuItem({ object, toolbar }: ScheduledBackupMenuItemProps) {
  // The list of the schedules does not load the clusters by itself, and the guard needs the one of this schedule.
  useReferenceStores([
    {
      label: Cluster.crd.plural,
      store: maybe(() => Cluster.getStore<Cluster>()),
      namespaces: [object.metadata?.namespace ?? ""],
    },
  ]);

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={ScheduledBackup.kind}
      title={TITLE}
      icon="backup"
      testId="cnpg-schedule-run-now-menu-item"
      access={access}
      guard={(schedule) =>
        canRunNow(
          scheduleFacts(schedule),
          clusterOf(schedule),
          maybe(() => Cluster.getStore<Cluster>())?.isLoaded ?? false,
        )
      }
      live={liveSchedule}
      open={(schedule) => openRunNow(schedule)}
    />
  );
}

export function ScheduledBackupRunNowMenuItem(props: ScheduledBackupMenuItemProps) {
  if (!props.object || props.object.kind !== ScheduledBackup.kind) return null;
  return <RunNowMenuItem {...props} />;
}
