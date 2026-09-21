/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Suspend" or "Resume" in the menu of a scheduled backup (SPEC-0021): exactly
// one of the two, by `.spec.suspend` of the object as the store holds it, and
// one merge patch of that one field with its explicit value. The decisions
// are in `components/scheduled-backup-actions.ts`.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { openActionDialog } from "../components/action-dialog";
import {
  canResume,
  canSuspend,
  RESUME_PATCH,
  resumeFacts,
  SUSPEND_PATCH,
  suspendEntry,
  suspendFacts,
} from "../components/scheduled-backup-actions";
import { apiFailureFacts, failureSentence } from "../components/write-actions";
import { ActionMenuItem } from "./action-menu-item";

import type { AccessQuestion } from "../components/access-review";
import type { ScheduleFacts } from "../components/scheduled-backup-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
  Navigation: { getDetailsUrl },
} = Renderer;

export interface ScheduledBackupMenuItemProps {
  object: ScheduledBackup;
  toolbar?: boolean;
}

export function scheduleFacts(object: ScheduledBackup): ScheduleFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    spec: object.spec,
    status: { nextScheduleTime: object.status?.nextScheduleTime },
  };
}

export function liveSchedule(object: ScheduledBackup): ScheduledBackup {
  const store = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
  const selfLink = object.metadata?.selfLink;
  return (selfLink ? store?.getByPath(selfLink) : undefined) ?? object;
}

function access(object: ScheduledBackup): AccessQuestion[] {
  return [
    {
      verb: "patch",
      group: "postgresql.cnpg.io",
      resource: "scheduledbackups",
      namespace: object.metadata?.namespace ?? "",
    },
  ];
}

function openSuspendOrResume(object: ScheduledBackup, entry: "suspend" | "resume"): void {
  const schedule = scheduleFacts(object);
  const resuming = entry === "resume";
  const verb = resuming ? "resume" : "suspend";

  const run = async () => {
    const store = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
    if (!store) {
      Notifications.error(
        `Could not ${verb} ${schedule.namespace}/${schedule.name}: the scheduled backups are not available.`,
      );
      return;
    }
    try {
      await store.patch(object, resuming ? RESUME_PATCH : SUSPEND_PATCH, "merge");
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not ${verb} ${schedule.namespace}/${schedule.name}. ${failureSentence(failure, {
            verb: "patch",
            resource: "scheduledbackups",
            namespace: schedule.namespace,
          })}`,
        );
      }
      return;
    }
    const selfLink = object.metadata?.selfLink;
    Notifications.ok(
      <p data-testid={resuming ? "cnpg-schedule-resume-requested" : "cnpg-schedule-suspend-requested"}>
        {resuming ? "Resume requested: spec.suspend of " : "Suspend requested: spec.suspend of "}
        {selfLink ? <MaybeLink to={getDetailsUrl(selfLink)}>{schedule.name}</MaybeLink> : <b>{schedule.name}</b>}
        {resuming
          ? " is written as false. The operator plans the next run from here."
          : " is written as true. The operator creates no backup for it until it is resumed."}
      </p>,
    );
  };

  openActionDialog({
    title: resuming ? "Resume" : "Suspend",
    testId: resuming ? "cnpg-schedule-resume-dialog" : "cnpg-schedule-suspend-dialog",
    facts: () => (resuming ? resumeFacts(schedule, new Date()) : suspendFacts(schedule)),
    run,
  });
}

/**
 * Reads the live object at render, inside an observer: after the write the
 * entry turns into its opposite as soon as the store has the new object, in
 * the row menu and in the toolbar of the drawer alike.
 */
export const ScheduledBackupSuspendMenuItem = observer(({ object, toolbar }: ScheduledBackupMenuItemProps) => {
  if (!object || object.kind !== ScheduledBackup.kind) return null;

  const entry = suspendEntry(scheduleFacts(liveSchedule(object)));
  const resuming = entry === "resume";

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={ScheduledBackup.kind}
      title={resuming ? "Resume" : "Suspend"}
      icon={resuming ? "play_arrow" : "pause"}
      testId={resuming ? "cnpg-schedule-resume-menu-item" : "cnpg-schedule-suspend-menu-item"}
      access={access}
      guard={(schedule) =>
        resuming ? canResume(scheduleFacts(liveSchedule(schedule))) : canSuspend(scheduleFacts(liveSchedule(schedule)))
      }
      live={liveSchedule}
      open={(schedule) => openSuspendOrResume(schedule, entry)}
    />
  );
});
