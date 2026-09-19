/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Subscription drawer (SPEC-0015): the replication as one path from the
// publisher to this subscriber, whether the slot on the publisher is being
// consumed right now, whether the pair survives a failover of the publisher,
// and the declaration.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { exactBytes, formatBytes } from "../components/bytes";
import { clusterOf, conflictingObjects, reclaimWords } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { logicalSlot } from "../components/live/database-reading";
import {
  failoverSafety,
  LOGICAL_REPLICATION_LIMITS,
  publicationsOfSubscription,
  resolvePublisher,
  slotName,
  subscriptionHealth,
  subscriptionNotes,
} from "../components/logical-replication";
import { ReconciliationSection } from "../components/reconciliation-section";
import { useReferenceStores } from "../components/reference-loader";
import { RightNow } from "../components/right-now";
import { StoreLink } from "../components/store-link";
import styles from "./declarative-details.module.scss";
import stylesInline from "./declarative-details.module.scss?inline";
import { ReplicationPath } from "./replication-path";

const { observer } = MobxReact;

const {
  Component: { BadgeBoolean, DrawerItem, DrawerTitle, WithTooltip },
} = Renderer;

export interface SubscriptionDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Subscription> {
  extension: Renderer.LensExtension;
}

export const SubscriptionDetails = observer((props: SubscriptionDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== Subscription.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const publicationStore = maybe(() => Publication.getStore<Publication>());
    const subscriptionStore = maybe(() => Subscription.getStore<Subscription>());

    // The publisher may live in another namespace: the clusters and the
    // publications are read wherever the user can see them.
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: Publication.crd.plural, store: publicationStore },
      { label: Subscription.crd.plural, store: subscriptionStore, namespaces: [namespace] },
    ]);

    const spec = object.spec;
    const clusters = clusterStore?.items ?? [];
    const subscriber = clusterOf(object, clusters);
    const health = subscriptionHealth(object, { cluster: subscriber, known: Boolean(clusterStore?.isLoaded) });
    const rivals = conflictingObjects(object, subscriptionStore?.items ?? []);
    const publisher = resolvePublisher(object, subscriber, clusters);
    const publications = publicationsOfSubscription(object, publisher, publicationStore?.items ?? []);
    const slot = slotName(object);
    const notes = subscriptionNotes(object);
    const failover = failoverSafety(publisher.cluster);
    const parameters = Object.entries(spec?.parameters ?? {});

    return (
      <>
        <style>{stylesInline}</style>

        <ReconciliationSection object={object} health={health} rivals={rivals} store={subscriptionStore} />

        <DrawerTitle>Replication path</DrawerTitle>
        <ReplicationPath
          testId="cnpg-replication-path"
          publisher={{
            cluster:
              publisher.outcome === "resolved" ? (
                <StoreLink
                  store={clusterStore}
                  name={publisher.cluster?.metadata?.name}
                  namespace={publisher.cluster?.metadata?.namespace}
                />
              ) : (
                <WithTooltip tooltip={publisher.words}>{publisher.host ?? publisher.externalClusterName}</WithTooltip>
              ),
            database: publisher.database ?? "",
            object:
              publications.length > 0 ? (
                <StoreLink
                  store={publicationStore}
                  name={publications[0].getName()}
                  namespace={publications[0].getNs()}
                />
              ) : (
                <WithTooltip tooltip="No Publication object here declares it: it may be managed in PostgreSQL directly">
                  {spec?.publicationName ?? "N/A"}
                </WithTooltip>
              ),
          }}
          subscriber={{
            cluster: (
              <StoreLink
                store={clusterStore}
                name={Subscription.getClusterName(object)}
                namespace={namespace}
                missing="The Cluster is not there (anymore)"
              />
            ),
            database: spec?.dbname ?? "",
            object: spec?.name ?? "N/A",
          }}
        />
        <DrawerItem name="Publisher">{publisher.words}</DrawerItem>
        <DrawerItem name="Connects as" hidden={!publisher.user}>
          <span className={styles.mono}>{publisher.user}</span> to <span className={styles.mono}>{publisher.host}</span>
          ; the password stays in its Secret
        </DrawerItem>
        <DrawerItem name="Publisher failover" hidden={!failover}>
          <span
            data-testid="cnpg-subscription-failover"
            className={failover?.safe === false ? styles.warning : undefined}
          >
            {failover?.words}
          </span>
        </DrawerItem>
        <div className={styles.note}>{LOGICAL_REPLICATION_LIMITS}.</div>

        {publisher.outcome === "resolved" ? (
          <>
            <DrawerTitle>Right now</DrawerTitle>
            <RightNow
              cluster={publisher.cluster}
              testId="cnpg-subscription-live"
              nobody="The publisher has no primary to ask"
            >
              {(samples) => {
                const reading = logicalSlot(samples, publisher.database ?? "", slot);
                if (!reading) {
                  return (
                    <DrawerItem name="Slot">
                      <span className={styles.warning}>
                        The publisher has no logical slot named {slot} in database {publisher.database}: nothing keeps
                        the changes for this subscription
                      </span>
                    </DrawerItem>
                  );
                }
                return (
                  <>
                    <DrawerItem name="Slot">
                      <span className={styles.mono}>{reading.name}</span> on the publisher, database {reading.database}
                    </DrawerItem>
                    <DrawerItem name="Being consumed" labelsOnly>
                      <span data-testid="cnpg-subscription-slot-active">
                        <BadgeBoolean value={reading.active} />
                      </span>
                    </DrawerItem>
                    <DrawerItem name="WAL kept for it">
                      <WithTooltip
                        tooltip={
                          reading.retainedBytes === undefined
                            ? undefined
                            : `${exactBytes(reading.retainedBytes)}: what the publisher cannot recycle until the subscriber confirms it`
                        }
                      >
                        {reading.retainedBytes === undefined ? "N/A" : formatBytes(reading.retainedBytes)}
                      </WithTooltip>
                    </DrawerItem>
                  </>
                );
              }}
            </RightNow>
          </>
        ) : null}

        <DrawerTitle>Subscription</DrawerTitle>
        <DrawerItem name="Name in PostgreSQL">
          <span className={styles.mono}>{spec?.name ?? "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="External cluster">
          <span className={styles.mono}>{spec?.externalClusterName ?? "N/A"}</span>, an entry of externalClusters of{" "}
          {Subscription.getClusterName(object)}
        </DrawerItem>
        <DrawerItem name="Reclaim policy">{reclaimWords(spec?.subscriptionReclaimPolicy, "subscription")}</DrawerItem>
        {parameters.map(([key, value]) => (
          <DrawerItem key={key} name={key}>
            <span className={styles.mono}>{value}</span>
          </DrawerItem>
        ))}
        {notes.map((note) => (
          <div key={note} className={styles.note}>
            {note}
          </div>
        ))}
      </>
    );
  }),
);
