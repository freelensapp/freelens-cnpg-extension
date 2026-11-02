/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Open maintenance window" or "Close maintenance window" in the menu of a
// PostgreSQL cluster, and the closing control on the "Maintenance window" row
// of its drawer (SPEC-0037). The decisions are in
// `components/maintenance-window.ts`; this file renders the choice about the
// volumes and sends one merge patch of `spec.nodeMaintenanceWindow`.

import { Renderer } from "@freelensapp/extensions";
import * as Mobx from "mobx";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog } from "../components/action-dialog";
import { CheckboxField } from "../components/create-dialog";
import {
  canCloseMaintenanceWindow,
  canOpenMaintenanceWindow,
  closeMaintenanceFacts,
  closeMaintenancePatch,
  maintenanceWindowState,
  openMaintenanceFacts,
  openMaintenancePatch,
} from "../components/maintenance-window";
import { apiFailureFacts, failureSentence, firstRefusal } from "../components/write-actions";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";
import { liveCluster } from "./cluster-live";

import type { AccessQuestion } from "../components/access-review";
import type { MaintenanceClusterFacts } from "../components/maintenance-window";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { Notifications },
} = Renderer;

type MaintenanceAction = "open" | "close";

export function maintenanceFacts(object: Cluster): MaintenanceClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    instances: object.spec?.instances ?? 1,
    window: object.spec?.nodeMaintenanceWindow,
  };
}

function access(object: Cluster): AccessQuestion[] {
  return [
    { verb: "patch", group: "postgresql.cnpg.io", resource: "clusters", namespace: object.metadata?.namespace ?? "" },
  ];
}

function guardOf(object: Cluster, action: MaintenanceAction): ActionGuard {
  const cluster = maintenanceFacts(object);
  return action === "open" ? canOpenMaintenanceWindow(cluster) : canCloseMaintenanceWindow(cluster);
}

export function openMaintenanceWindow(object: Cluster, action: MaintenanceAction): void {
  const opened = maintenanceFacts(object);
  const opening = action === "open";
  // The choice of the dialog, on by default as the API's own default.
  const reusePVC = Mobx.observable.box(maintenanceWindowState(opened).reusePVC);

  const run = async () => {
    const store = maybe(() => Cluster.getStore<Cluster>());
    if (!store) {
      Notifications.error(`Could not ${action} the maintenance window of ${opened.namespace}/${opened.name}.`);
      return;
    }
    try {
      await store.patch(
        liveCluster(object),
        opening ? openMaintenancePatch(reusePVC.get()) : closeMaintenancePatch(),
        "merge",
      );
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not ${action} the maintenance window of ${opened.namespace}/${opened.name}. ${failureSentence(
            failure,
            {
              verb: "patch",
              resource: "clusters",
              namespace: opened.namespace,
            },
          )}`,
        );
      }
      return;
    }
    Notifications.ok(
      <p data-testid={opening ? "cnpg-maintenance-opened" : "cnpg-maintenance-closed"}>
        {opening
          ? `Maintenance window of ${opened.namespace}/${opened.name} open: drain its nodes now, and close the window once they are back.`
          : `Maintenance window of ${opened.namespace}/${opened.name} closed.`}
      </p>,
    );
  };

  const ReuseChoice = observer(() => (
    <CheckboxField
      label="Reuse the volumes"
      checked={reusePVC.get()}
      onChange={(value) => Mobx.runInAction(() => reusePVC.set(value))}
      testId="cnpg-maintenance-reuse-pvc"
      hint="On: an instance waits for its node and keeps its volumes. Off: it is recreated on another node from a copy of the primary."
    />
  ));

  openActionDialog({
    title: opening ? "Open maintenance window" : "Close maintenance window",
    testId: opening ? "cnpg-maintenance-open-dialog" : "cnpg-maintenance-close-dialog",
    accent: opening,
    facts: () => {
      const cluster = maintenanceFacts(liveCluster(object));
      return opening ? openMaintenanceFacts(cluster, reusePVC.get()) : closeMaintenanceFacts(cluster);
    },
    form: opening ? () => <ReuseChoice /> : undefined,
    blockReason: () => guardOf(liveCluster(object), action).reason,
    run,
  });
}

export interface ClusterMaintenanceMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
}

/** Exactly one of the two, by `spec.nodeMaintenanceWindow.inProgress` as the store holds it. */
export const ClusterMaintenanceMenuItem = observer(({ object, toolbar }: ClusterMaintenanceMenuItemProps) => {
  if (!object || object.kind !== Cluster.kind) return null;

  const action: MaintenanceAction = maintenanceWindowState(maintenanceFacts(liveCluster(object))).open
    ? "close"
    : "open";

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title={action === "open" ? "Open maintenance window" : "Close maintenance window"}
      icon={action === "open" ? "engineering" : "event_available"}
      testId={
        action === "open" ? "cnpg-cluster-maintenance-open-menu-item" : "cnpg-cluster-maintenance-close-menu-item"
      }
      access={access}
      guard={(cluster) => guardOf(cluster, action)}
      live={liveCluster}
      open={(cluster) => openMaintenanceWindow(cluster, action)}
    />
  );
});

/** The closing control on the "Maintenance window" row of the drawer: next to the fact it reverses (W1). */
export const MaintenanceCloseButton = observer(({ cluster }: { cluster: Cluster }) => {
  const live = liveCluster(cluster);
  const accessVerdict = useAccessGuard(access(live));
  const verdictOf = (object: Cluster): ActionGuard => firstRefusal(guardOf(object, "close"), accessVerdict);
  const verdict = verdictOf(live);
  const tooltip = verdict.enabled ? "Close maintenance window" : `Close maintenance window: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid="cnpg-maintenance-close"
      onClick={(event) => {
        event.stopPropagation();
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        openMaintenanceWindow(liveCluster(cluster), "close");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material="event_available" tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
