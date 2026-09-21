/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The fencing actions of a PostgreSQL cluster (SPEC-0024): "Fence all
// instances" or "Lift all fences" in its menu, "Fence" or "Lift the fence" on
// the row of an instance, and the lifting control on the "Fenced instances"
// row of the drawer. The decisions are in `components/fencing.ts`; this file
// reads the stores and sends one merge patch of one annotation, with the
// resource version, because the whole fenced set lives in one string (W6).

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog } from "../components/action-dialog";
import {
  ALL_INSTANCES,
  canFenceAll,
  canFenceInstance,
  canLiftAll,
  canLiftInstance,
  FENCED_INSTANCES_ANNOTATION,
  fencingDialogFacts,
  fencingPatch,
  fencingTransition,
  isFencedIn,
  parseFenced,
} from "../components/fencing";
import { failureSentence, firstRefusal, writeWithConflictRetry } from "../components/write-actions";
import { timelineUrl } from "../navigation";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";
import { liveCluster } from "./cluster-live";

import type { AccessQuestion } from "../components/access-review";
import type { FencingAction, FencingBackupFacts, FencingClusterFacts } from "../components/fencing";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
} = Renderer;

export interface ClusterFencingProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function fencingFacts(object: Cluster): FencingClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    resourceVersion: object.metadata?.resourceVersion,
    hibernated: Cluster.getHibernation(object),
    fencedAnnotation: object.metadata?.annotations?.[FENCED_INSTANCES_ANNOTATION],
    spec: object.spec,
    status: object.status,
  };
}

function access(object: Cluster): AccessQuestion[] {
  return [
    { verb: "patch", group: "postgresql.cnpg.io", resource: "clusters", namespace: object.metadata?.namespace ?? "" },
  ];
}

/** The backups of the cluster, as far as the cold snapshot guard needs them. */
function backupsOf(cluster: FencingClusterFacts): FencingBackupFacts[] {
  return ((maybe(() => Backup.getStore<Backup>())?.items ?? []) as Backup[])
    .filter(
      (backup) => backup.metadata?.namespace === cluster.namespace && Backup.getClusterName(backup) === cluster.name,
    )
    .map((backup) => ({
      name: backup.metadata?.name ?? "",
      method: backup.spec?.method,
      online: backup.spec?.online,
      phase: Backup.getPhase(backup),
    }));
}

function loadBackups(namespace: string): void {
  maybe(() => Backup.getStore<Backup>())
    ?.loadAll({ namespaces: [namespace], merge: true, onLoadFailure: () => undefined })
    ?.catch(() => undefined);
}

export function fencingGuard(object: Cluster, action: FencingAction): ActionGuard {
  const cluster = fencingFacts(object);
  if (action.kind === "fence") {
    return action.instance === ALL_INSTANCES ? canFenceAll(cluster) : canFenceInstance(cluster, action.instance);
  }
  return action.instance === ALL_INSTANCES
    ? canLiftAll(cluster, backupsOf(cluster))
    : canLiftInstance(cluster, action.instance, backupsOf(cluster));
}

function titleOf(action: FencingAction): string {
  if (action.instance === ALL_INSTANCES) return action.kind === "fence" ? "Fence all instances" : "Lift all fences";
  return action.kind === "fence" ? "Fence" : "Lift the fence";
}

function whatWords(action: FencingAction): string {
  if (action.instance === ALL_INSTANCES) {
    return action.kind === "fence" ? "Fencing of every instance" : "Lift of every fence";
  }
  return action.kind === "fence" ? `Fencing of ${action.instance}` : `Lift of the fence of ${action.instance}`;
}

export function openFencing(
  object: Cluster,
  action: FencingAction,
  extension: Renderer.LensExtension,
  changedNotice?: string,
): void {
  const opened = fencingFacts(object);

  loadBackups(opened.namespace);

  const run = async () => {
    const store = maybe(() => Cluster.getStore<Cluster>());
    if (!store) {
      Notifications.error(`${whatWords(action)} not requested: the clusters are not available.`);
      return;
    }
    const confirmed = fencingDialogFacts(fencingFacts(liveCluster(object)), action).writes;
    if (confirmed.length === 0) return;

    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        const live = liveCluster(object);
        const cluster = fencingFacts(live);
        const transition = fencingTransition(cluster, action);
        // A set is never written from a stale read: the value comes from the object the patch names by its version.
        if (transition.kind !== "next") throw { code: 409, reason: "Conflict", message: "the fenced set changed" };
        // `null` is how a merge patch removes a key (spike S1): the host's type for a patch knows only values.
        await store.patch(live, fencingPatch(cluster, transition.set) as never, "merge");
      },
      refresh: async () => {
        await store.load({ name: opened.name, namespace: opened.namespace });
        const live = liveCluster(object);
        return { guard: fencingGuard(live, action), writes: fencingDialogFacts(fencingFacts(live), action).writes };
      },
    });

    switch (outcome.kind) {
      case "written":
        Notifications.ok(
          <p data-testid="cnpg-fencing-requested">
            {`${whatWords(action)} of ${opened.namespace}/${opened.name} requested. The instance managers do the rest: follow it in the `}
            <MaybeLink to={timelineUrl(extension.name, opened.namespace, opened.name)}>Timeline</MaybeLink>
            {" of the cluster, and in the Instances table of its drawer."}
          </p>,
        );
        return;
      case "changed":
        openFencing(
          liveCluster(object),
          action,
          extension,
          "The fenced instances changed while the write was sent: nothing was written. Read the write again.",
        );
        return;
      case "refused":
        Notifications.error(
          `${whatWords(action)} not requested: the cluster changed in the meantime. ${outcome.reason}.`,
        );
        return;
      case "failed":
        if (!outcome.failure.alreadyNotified) {
          Notifications.error(
            `${whatWords(action)} not requested. ${failureSentence(outcome.failure, {
              verb: "patch",
              resource: "clusters",
              namespace: opened.namespace,
            })}`,
          );
        }
    }
  };

  openActionDialog(
    {
      title: titleOf(action),
      testId: action.kind === "fence" ? "cnpg-fence-dialog" : "cnpg-lift-fence-dialog",
      accent: action.kind === "fence",
      facts: () => fencingDialogFacts(fencingFacts(liveCluster(object)), action),
      blockReason: () => fencingGuard(liveCluster(object), action).reason,
      changedNotice,
      run,
    },
    undefined,
    Boolean(changedNotice),
  );
}

/**
 * Exactly one of the two, by what the annotation says on the object as the
 * store holds it: "Lift all fences" while anything is fenced (or the value
 * does not parse, which only this action can remove), "Fence all instances"
 * otherwise.
 */
export const ClusterFencingMenuItem = observer(({ object, toolbar, extension }: ClusterFencingProps) => {
  if (!object || object.kind !== Cluster.kind) return null;

  const set = parseFenced(fencingFacts(liveCluster(object)).fencedAnnotation);
  const action: FencingAction = { kind: set.kind === "none" ? "fence" : "lift", instance: ALL_INSTANCES };

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title={titleOf(action)}
      icon={action.kind === "fence" ? "block" : "lock_open"}
      testId={action.kind === "fence" ? "cnpg-cluster-fence-all-menu-item" : "cnpg-cluster-lift-all-menu-item"}
      access={access}
      guard={(cluster) => fencingGuard(cluster, action)}
      live={liveCluster}
      open={(cluster) => openFencing(cluster, action, extension)}
    />
  );
});

export interface FencingButtonProps {
  cluster: Cluster;
  /** The instance, or `*` for the control of the "Fenced instances" row. */
  instanceName: string;
  extension: Renderer.LensExtension;
}

/**
 * "Fence" or "Lift the fence" on the row of an instance, and, with `*`, the
 * lifting control next to the fact it reverses (W1).
 */
export const FencingButton = observer(({ cluster, instanceName, extension }: FencingButtonProps) => {
  const live = liveCluster(cluster);
  const set = parseFenced(fencingFacts(live).fencedAnnotation);
  const lifting = instanceName === ALL_INSTANCES ? true : isFencedIn(set, instanceName);
  // Under the star a single fence cannot be lifted: the row offers the lift, refused, with the reason.
  const action: FencingAction = { kind: lifting ? "lift" : "fence", instance: instanceName };
  const accessVerdict = useAccessGuard(access(live));
  const verdictOf = (object: Cluster): ActionGuard => firstRefusal(fencingGuard(object, action), accessVerdict);
  const verdict = verdictOf(live);
  const verb = instanceName === ALL_INSTANCES ? titleOf(action) : `${titleOf(action)}: ${instanceName}`;
  const tooltip = verdict.enabled ? verb : `${verb}. ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid={
        instanceName === ALL_INSTANCES
          ? "cnpg-fenced-lift-all"
          : `cnpg-instance-${lifting ? "lift-fence" : "fence"}-${instanceName}`
      }
      onClick={(event) => {
        event.stopPropagation();
        // The guard again on the click, against the object as the store holds it now (W2).
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        openFencing(liveCluster(cluster), action, extension);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material={lifting ? "lock_open" : "block"} tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
