/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Hibernate" or "Resume" in the menu of a PostgreSQL cluster, and the
// resuming control on the "Hibernation" row of its drawer (SPEC-0024). The
// decisions are in `components/hibernation.ts`; this file reads what is
// attached to the cluster from the stores the extension already has, renders
// the consequences and sends one merge patch of one annotation.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { Database } from "../api/cnpg/database-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { useAccessGuard } from "../components/access-review";
import { openActionDialog, actionDialogStyles as styles } from "../components/action-dialog";
import {
  canHibernate,
  canResumeCluster,
  HIBERNATION_ANNOTATION,
  HIBERNATION_CONDITION,
  hibernateFacts,
  hibernationConsequences,
  hibernationPatch,
  resumeClusterFacts,
} from "../components/hibernation";
import { resolvePublisher } from "../components/logical-replication";
import { apiFailureFacts, failureSentence, firstRefusal } from "../components/write-actions";
import { timelineUrl } from "../navigation";
import { ActionIcon } from "./action-icon";
import { ActionMenuItem } from "./action-menu-item";
import { liveCluster } from "./cluster-live";

import type { AccessQuestion } from "../components/access-review";
import type { HibernationClusterFacts, HibernationRelated } from "../components/hibernation";
import type { ActionGuard } from "../components/write-actions";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Notifications },
  K8sApi: { pvcStore },
  Navigation: { getDetailsUrl },
} = Renderer;

export interface ClusterHibernationProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function hibernationFacts(object: Cluster): HibernationClusterFacts {
  const condition = Cluster.getCondition(object, HIBERNATION_CONDITION);
  return {
    name: object.metadata?.name ?? "",
    namespace: object.metadata?.namespace ?? "",
    annotation: object.metadata?.annotations?.[HIBERNATION_ANNOTATION],
    condition: condition
      ? { status: condition.status, reason: condition.reason, message: condition.message }
      : undefined,
    spec: object.spec,
    status: {
      phase: object.status?.phase,
      currentPrimary: object.status?.currentPrimary,
      readyInstances: Cluster.getReadyInstances(object),
      instanceNames: object.status?.instanceNames,
    },
  };
}

function access(object: Cluster): AccessQuestion[] {
  return [
    { verb: "patch", group: "postgresql.cnpg.io", resource: "clusters", namespace: object.metadata?.namespace ?? "" },
  ];
}

interface ClaimShape {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string | undefined> };
  spec?: { resources?: { requests?: { storage?: string } } };
}

function itemsOf<T>(read: () => { items: T[] } | undefined): T[] {
  return maybe(read)?.items ?? [];
}

/** What is attached to the cluster, from the stores as they are right now. */
export function hibernationRelated(object: Cluster): HibernationRelated {
  const name = object.metadata?.name ?? "";
  const namespace = object.metadata?.namespace ?? "";
  const mine = <T extends { metadata?: { namespace?: string } }>(
    items: T[],
    clusterOf: (item: T) => string | undefined,
  ) => items.filter((item) => item.metadata?.namespace === namespace && clusterOf(item) === name);

  const clusters = itemsOf(() => Cluster.getStore<Cluster>());
  const subscriptions = itemsOf(() => Subscription.getStore<Subscription>());

  return {
    volumes: ((maybe(() => pvcStore.items) ?? []) as ClaimShape[])
      .filter(
        (claim) => claim.metadata?.namespace === namespace && claim.metadata?.labels?.["cnpg.io/cluster"] === name,
      )
      .map((claim) => ({ name: claim.metadata?.name ?? "", size: claim.spec?.resources?.requests?.storage }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    poolers: mine(
      itemsOf(() => Pooler.getStore<Pooler>()),
      Pooler.getClusterName,
    ).map((pooler) => pooler.metadata?.name ?? ""),
    schedules: mine(
      itemsOf(() => ScheduledBackup.getStore<ScheduledBackup>()),
      ScheduledBackup.getClusterName,
    ).map((schedule) => ({ name: schedule.metadata?.name ?? "", suspended: ScheduledBackup.isSuspended(schedule) })),
    declared: {
      databases: mine(
        itemsOf(() => Database.getStore<Database>()),
        Database.getClusterName,
      ).length,
      roles: mine(
        itemsOf(() => DatabaseRole.getStore<DatabaseRole>()),
        DatabaseRole.getClusterName,
      ).length,
      publications: mine(
        itemsOf(() => Publication.getStore<Publication>()),
        Publication.getClusterName,
      ).length,
      subscriptions: mine(subscriptions, Subscription.getClusterName).length,
    },
    // The subscriptions of other clusters whose publisher resolves to this one (SPEC-0015).
    subscribersElsewhere: subscriptions
      .filter((subscription) => {
        const subscriberName = Subscription.getClusterName(subscription);
        const subscriberNamespace = subscription.metadata?.namespace;
        if (subscriberName === name && subscriberNamespace === namespace) return false;
        const subscriber = clusters.find(
          (candidate) =>
            candidate.metadata?.name === subscriberName && candidate.metadata?.namespace === subscriberNamespace,
        );
        const publisher = resolvePublisher(subscription, subscriber, clusters).cluster;
        return publisher?.metadata?.name === name && publisher?.metadata?.namespace === namespace;
      })
      .map((subscription) => `${subscription.metadata?.namespace}/${subscription.metadata?.name}`),
  };
}

/** Asks for everything the consequences are computed from, and waits: the dialog states facts. */
async function loadRelated(namespace: string): Promise<void> {
  const stores = [
    maybe(() => pvcStore),
    maybe(() => Pooler.getStore<Pooler>()),
    maybe(() => ScheduledBackup.getStore<ScheduledBackup>()),
    maybe(() => Database.getStore<Database>()),
    maybe(() => DatabaseRole.getStore<DatabaseRole>()),
    maybe(() => Publication.getStore<Publication>()),
    maybe(() => Subscription.getStore<Subscription>()),
  ];
  await Promise.all(
    stores.map((store) =>
      Promise.resolve(store?.loadAll({ namespaces: [namespace], merge: true, onLoadFailure: () => undefined })).catch(
        () => undefined,
      ),
    ),
  );
}

interface ConsequencesProps {
  object: Cluster;
}

const Consequences = observer(({ object }: ConsequencesProps) => {
  const live = liveCluster(object);
  const lists = hibernationConsequences(hibernationFacts(live), hibernationRelated(live));
  const namespace = live.metadata?.namespace ?? "";
  const schedules = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());

  return (
    <div data-testid="cnpg-hibernation-consequences">
      {lists.map((list) => (
        <div key={list.id} className={styles.field} data-testid={`cnpg-hibernation-${list.id}`}>
          <span className={styles.label}>{list.heading}</span>
          <ul className={styles.list}>
            {list.lines.map((line) => {
              const schedule = list.scheduleNames?.includes(line) ? schedules?.getByName(line, namespace) : undefined;
              return (
                <li key={line}>
                  {schedule ? (
                    <>
                      <MaybeLink to={getDetailsUrl(schedule.selfLink)}>{line}</MaybeLink>
                      {": suspend it from its own menu"}
                    </>
                  ) : (
                    line
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
});

type HibernationAction = "hibernate" | "resume";

function guardOf(object: Cluster, action: HibernationAction): ActionGuard {
  const cluster = hibernationFacts(object);
  return action === "hibernate" ? canHibernate(cluster) : canResumeCluster(cluster);
}

export async function openHibernation(
  object: Cluster,
  action: HibernationAction,
  extension: Renderer.LensExtension,
): Promise<void> {
  const opened = hibernationFacts(object);
  const hibernating = action === "hibernate";

  await loadRelated(opened.namespace);

  const run = async () => {
    const store = maybe(() => Cluster.getStore<Cluster>());
    if (!store) {
      Notifications.error(`Could not ${action} ${opened.namespace}/${opened.name}: the clusters are not available.`);
      return;
    }
    try {
      await store.patch(liveCluster(object), hibernationPatch(hibernating ? "on" : "off"), "merge");
    } catch (error) {
      const failure = apiFailureFacts(error);
      if (!failure.alreadyNotified) {
        Notifications.error(
          `Could not ${action} ${opened.namespace}/${opened.name}. ${failureSentence(failure, {
            verb: "patch",
            resource: "clusters",
            namespace: opened.namespace,
          })}`,
        );
      }
      return;
    }
    Notifications.ok(
      <p data-testid={hibernating ? "cnpg-hibernate-requested" : "cnpg-resume-requested"}>
        {`${hibernating ? "Hibernation" : "Resume"} of ${opened.namespace}/${opened.name} requested. The operator does the rest: follow it in the Hibernation row of the drawer and in the `}
        <MaybeLink to={timelineUrl(extension.name, opened.namespace, opened.name)}>Timeline</MaybeLink>
        {" of the cluster."}
      </p>,
    );
  };

  openActionDialog({
    title: hibernating ? "Hibernate" : "Resume",
    testId: hibernating ? "cnpg-hibernate-dialog" : "cnpg-resume-cluster-dialog",
    accent: hibernating,
    facts: () => {
      const live = liveCluster(object);
      return hibernating
        ? hibernateFacts(hibernationFacts(live))
        : resumeClusterFacts(hibernationFacts(live), hibernationRelated(live));
    },
    form: hibernating ? () => <Consequences object={object} /> : undefined,
    blockReason: () => guardOf(liveCluster(object), action).reason,
    run,
  });
}

/** Exactly one of the two, by the annotation of the object as the store holds it. */
export const ClusterHibernationMenuItem = observer(({ object, toolbar, extension }: ClusterHibernationProps) => {
  if (!object || object.kind !== Cluster.kind) return null;

  const action: HibernationAction = Cluster.getHibernation(liveCluster(object)) ? "resume" : "hibernate";

  return (
    <ActionMenuItem
      object={object}
      toolbar={toolbar}
      kind={Cluster.kind}
      title={action === "hibernate" ? "Hibernate" : "Resume"}
      icon={action === "hibernate" ? "bedtime" : "wb_sunny"}
      testId={action === "hibernate" ? "cnpg-cluster-hibernate-menu-item" : "cnpg-cluster-resume-menu-item"}
      access={access}
      guard={(cluster) => guardOf(cluster, action)}
      live={liveCluster}
      open={(cluster) => openHibernation(cluster, action, extension)}
    />
  );
});

export interface ResumeButtonProps {
  cluster: Cluster;
  extension: Renderer.LensExtension;
}

/** The resuming control on the "Hibernation" row of the drawer: next to the fact it reverses (W1). */
export const ResumeButton = observer(({ cluster, extension }: ResumeButtonProps) => {
  const live = liveCluster(cluster);
  const accessVerdict = useAccessGuard(access(live));
  const verdictOf = (object: Cluster): ActionGuard => firstRefusal(guardOf(object, "resume"), accessVerdict);
  const verdict = verdictOf(live);
  const tooltip = verdict.enabled ? "Resume" : `Resume: ${verdict.reason}`;

  return (
    <span
      role="button"
      tabIndex={0}
      title={tooltip}
      aria-disabled={!verdict.enabled}
      data-testid="cnpg-hibernation-resume"
      onClick={(event) => {
        event.stopPropagation();
        if (!verdictOf(liveCluster(cluster)).enabled) return;
        void openHibernation(liveCluster(cluster), "resume", extension);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).click();
      }}
    >
      <ActionIcon material="wb_sunny" tooltip={tooltip} disabled={!verdict.enabled} toolbar />
    </span>
  );
});
