/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Restart" and "Reload" in the menu of a PostgreSQL cluster, and "Restart" on
// the row of an instance in its drawer (SPEC-0023). The decisions are in
// `components/restart-reload.ts`; this file reads the stores, renders the plan
// of a rollout and sends one request per action: an annotation on the
// cluster, the delete of the pod of a standby, or the status write that asks
// the primary to restart PostgreSQL in place.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { requestPrimaryRestart } from "../api/writes/cluster-status-writes";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog, actionDialogStyles as styles } from "../components/action-dialog";
import {
  canReload,
  canRestartCluster,
  canRestartInstance,
  instanceRestartKind,
  isInstancePodOf,
  reloadAnnotationPatch,
  reloadFacts,
  restartAnnotationPatch,
  restartClusterFacts,
  restartPlan,
  restartPrimaryFacts,
  restartStandbyFacts,
} from "../components/restart-reload";
import { apiFailureFacts, failureSentence, firstRefusal, writeWithConflictRetry } from "../components/write-actions";
import { timelineUrl } from "../navigation";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";
import { instancePods, liveCluster, loadPods, podsKnown } from "./cluster-live";

import type { AccessQuestion } from "../components/access-review";
import type { RestartClusterFacts } from "../components/restart-reload";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
  K8sApi: { podsStore },
} = Renderer;

export interface ClusterRestartMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function restartFacts(object: Cluster): RestartClusterFacts {
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    resourceVersion: object.metadata?.resourceVersion,
    hibernated: Cluster.getHibernation(object),
    fenced: Cluster.getFencedInstances(object),
    spec: object.spec,
    status: object.status,
  };
}

function question(
  object: Cluster,
  verb: AccessQuestion["verb"],
  resource: string,
  group: string,
  subresource?: string,
): AccessQuestion {
  return { verb, group, resource, subresource, namespace: object.metadata?.namespace ?? "" };
}

const patchClusters = (object: Cluster) => [question(object, "patch", "clusters", "postgresql.cnpg.io")];

function reportFailure(error: unknown, lead: string, verb: "patch" | "delete", resource: string, namespace: string) {
  const failure = apiFailureFacts(error);
  if (!failure.alreadyNotified) {
    Notifications.error(`${lead} ${failureSentence(failure, { verb, resource, namespace })}`);
  }
}

interface PlanProps {
  object: Cluster;
}

/** The plan of the rollout, read from the live object: what the dialog of a cluster restart is for. */
const RestartPlan = observer(({ object }: PlanProps) => {
  const steps = restartPlan(restartFacts(liveCluster(object)));

  return (
    <div className={styles.field}>
      <span className={styles.label}>What happens, in order</span>
      <ol className={styles.plan} data-testid="cnpg-restart-plan">
        {steps.map((step) => (
          <li key={step.text} data-kind={step.kind}>
            {step.text}
          </li>
        ))}
      </ol>
    </div>
  );
});

function openRestartCluster(object: Cluster, extension: Renderer.LensExtension): void {
  const cluster = restartFacts(object);

  const run = async () => {
    const store = maybe(() => Cluster.getStore<Cluster>());
    if (!store) {
      Notifications.error(`Could not restart ${cluster.namespace}/${cluster.name}: the clusters are not available.`);
      return;
    }
    try {
      // A fresh timestamp at the moment of the write: the value only has to differ from the one the pods carry.
      await store.patch(liveCluster(object), restartAnnotationPatch(new Date()), "merge");
    } catch (error) {
      reportFailure(
        error,
        `Could not restart ${cluster.namespace}/${cluster.name}.`,
        "patch",
        "clusters",
        cluster.namespace,
      );
      return;
    }
    Notifications.ok(
      <p data-testid="cnpg-restart-requested">
        {`Restart of ${cluster.namespace}/${cluster.name} requested. The operator does the rest, one instance at a time: follow it in the `}
        <MaybeLink to={timelineUrl(extension.name, cluster.namespace, cluster.name)}>Timeline</MaybeLink>
        {" of the cluster."}
      </p>,
    );
  };

  openActionDialog({
    title: "Restart",
    testId: "cnpg-restart-dialog",
    accent: true,
    facts: () => restartClusterFacts(restartFacts(liveCluster(object))),
    form: () => <RestartPlan object={object} />,
    blockReason: () => canRestartCluster(restartFacts(liveCluster(object))).reason,
    run,
  });
}

function openReload(object: Cluster): void {
  const cluster = restartFacts(object);

  const run = async () => {
    const store = maybe(() => Cluster.getStore<Cluster>());
    if (!store) {
      Notifications.error(`Could not reload ${cluster.namespace}/${cluster.name}: the clusters are not available.`);
      return;
    }
    try {
      await store.patch(liveCluster(object), reloadAnnotationPatch(new Date()), "merge");
    } catch (error) {
      reportFailure(
        error,
        `Could not reload ${cluster.namespace}/${cluster.name}.`,
        "patch",
        "clusters",
        cluster.namespace,
      );
      return;
    }
    Notifications.ok(
      <p data-testid="cnpg-reload-requested">
        {`Reload of ${cluster.namespace}/${cluster.name} requested. The operator and the instance managers reconcile now; nothing reports when they are done.`}
      </p>,
    );
  };

  openActionDialog({
    title: "Reload",
    testId: "cnpg-reload-dialog",
    facts: () => reloadFacts(restartFacts(liveCluster(object))),
    blockReason: () => canReload(restartFacts(liveCluster(object))).reason,
    run,
  });
}

export function ClusterRestartMenuItem({ object, toolbar, extension }: ClusterRestartMenuItemProps) {
  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title="Restart"
      icon="restart_alt"
      testId="cnpg-cluster-restart-menu-item"
      access={patchClusters}
      guard={(cluster) => canRestartCluster(restartFacts(cluster))}
      live={liveCluster}
      open={(cluster) => openRestartCluster(cluster, extension)}
    />
  );
}

export function ClusterReloadMenuItem({ object, toolbar }: Omit<ClusterRestartMenuItemProps, "extension">) {
  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title="Reload"
      icon="sync"
      testId="cnpg-cluster-reload-menu-item"
      access={patchClusters}
      guard={(cluster) => canReload(restartFacts(cluster))}
      live={liveCluster}
      open={(cluster) => openReload(cluster)}
    />
  );
}

function instanceAccess(object: Cluster, instance: string): AccessQuestion[] {
  return instanceRestartKind(restartFacts(object), instance) === "primary"
    ? [question(object, "patch", "clusters", "postgresql.cnpg.io", "status")]
    : [question(object, "delete", "pods", "")];
}

function instanceGuard(object: Cluster, instance: string): ActionGuard {
  const cluster = restartFacts(object);
  const known = podsKnown(cluster.namespace, cluster.status?.currentPrimary);
  return canRestartInstance(cluster, instance, known ? instancePods(cluster.namespace) : undefined);
}

async function openRestartInstance(
  object: Cluster,
  instance: string,
  extension: Renderer.LensExtension,
): Promise<void> {
  const opened = restartFacts(object);

  await loadPods(opened.namespace);

  if (instanceRestartKind(opened, instance) === "primary") {
    const run = async () => {
      const confirmed = restartPrimaryFacts(restartFacts(liveCluster(object)), instance).writes;
      const outcome = await writeWithConflictRetry({
        confirmed,
        send: () => {
          const cluster = restartFacts(liveCluster(object));
          return requestPrimaryRestart({
            namespace: cluster.namespace,
            name: cluster.name,
            resourceVersion: cluster.resourceVersion ?? "",
          });
        },
        refresh: async () => {
          await maybe(() => Cluster.getStore<Cluster>())?.load({ name: opened.name, namespace: opened.namespace });
          const cluster = restartFacts(liveCluster(object));
          const stillPrimary = instanceRestartKind(cluster, instance) === "primary";
          return {
            guard: stillPrimary
              ? canRestartInstance(cluster, instance, instancePods(cluster.namespace))
              : { enabled: false, reason: `${instance} is not the primary anymore` },
            writes: restartPrimaryFacts(cluster, instance).writes,
          };
        },
      });

      switch (outcome.kind) {
        case "written":
          Notifications.ok(
            <p data-testid="cnpg-restart-instance-requested">
              {`Restart in place of the primary ${instance} of ${opened.namespace}/${opened.name} requested. Its instance manager does the rest: follow it in the `}
              <MaybeLink to={timelineUrl(extension.name, opened.namespace, opened.name)}>Timeline</MaybeLink>
              {" of the cluster."}
            </p>,
          );
          return;
        case "changed":
        case "refused":
          Notifications.error(
            `Restart of ${instance} not requested: the cluster changed in the meantime${
              outcome.kind === "refused" ? `. ${outcome.reason}` : ""
            }. Nothing was written.`,
          );
          return;
        case "failed":
          if (!outcome.failure.alreadyNotified) {
            Notifications.error(
              `Could not restart ${instance}. ${failureSentence(outcome.failure, {
                verb: "patch",
                resource: "clusters/status",
                namespace: opened.namespace,
              })}`,
            );
          }
      }
    };

    openActionDialog({
      title: "Restart",
      testId: "cnpg-restart-primary-dialog",
      accent: true,
      facts: () => restartPrimaryFacts(restartFacts(liveCluster(object)), instance),
      blockReason: () => instanceGuard(liveCluster(object), instance).reason,
      run,
    });
    return;
  }

  const run = async () => {
    const cluster = restartFacts(liveCluster(object));
    const pod = maybe(() => podsStore.getByName(instance, cluster.namespace));
    const facts = instancePods(cluster.namespace).find((candidate) => candidate.name === instance);
    // Safety of SPEC-0023: a pod is deleted only after its labels say it is an instance of this cluster.
    if (!pod || !isInstancePodOf(cluster, facts)) {
      Notifications.error(
        `Restart of ${instance} not requested: its pod is not there, or it is not an instance of ${cluster.namespace}/${cluster.name}. Nothing was deleted.`,
      );
      return;
    }
    try {
      await podsStore.remove(pod);
    } catch (error) {
      reportFailure(error, `Could not restart ${instance}.`, "delete", "pods", cluster.namespace);
      return;
    }
    Notifications.ok(
      <p data-testid="cnpg-restart-instance-requested">
        {`Restart of the standby ${instance} of ${cluster.namespace}/${cluster.name} requested: its pod is deleted, and the operator recreates it on the same volumes. Follow it in the `}
        <MaybeLink to={timelineUrl(extension.name, cluster.namespace, cluster.name)}>Timeline</MaybeLink>
        {" of the cluster."}
      </p>,
    );
  };

  openActionDialog({
    title: "Restart",
    testId: "cnpg-restart-standby-dialog",
    facts: () => {
      const cluster = restartFacts(liveCluster(object));
      return restartStandbyFacts(cluster, instance, instancePods(cluster.namespace));
    },
    blockReason: () => instanceGuard(liveCluster(object), instance).reason,
    run,
  });
}

export interface RestartInstanceButtonProps {
  cluster: Cluster;
  instanceName: string;
  extension: Renderer.LensExtension;
}

/** "Restart" on the row of an instance in the Instances table of the drawer (W1). */
export const RestartInstanceButton = observer(({ cluster, instanceName, extension }: RestartInstanceButtonProps) => {
  const live = liveCluster(cluster);
  const accessVerdict = useAccessGuard(instanceAccess(live, instanceName));
  const verdictOf = (object: Cluster): ActionGuard => firstRefusal(instanceGuard(object, instanceName), accessVerdict);
  const verdict = verdictOf(live);
  const primary = instanceRestartKind(restartFacts(live), instanceName) === "primary";
  const verb = primary ? `Restart PostgreSQL in place on the primary ${instanceName}` : `Restart ${instanceName}`;
  const tooltip = verdict.enabled ? verb : `${verb}: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid={`cnpg-instance-restart-${instanceName}`}
      onClick={(event) => {
        event.stopPropagation();
        // The guard again on the click, against the object as the store holds it now (W2).
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        void openRestartInstance(liveCluster(cluster), instanceName, extension);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material="restart_alt" tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
