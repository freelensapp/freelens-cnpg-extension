/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Publication drawer (SPEC-0015): what is published, who consumes it as a
// replication path per subscription, and the logical slots of its database on
// the primary right now.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { exactBytes, formatBytes } from "../components/bytes";
import { clusterOf, conflictingObjects, reclaimWords } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { logicalSlots } from "../components/live/database-reading";
import {
  failoverSafety,
  LOGICAL_REPLICATION_LIMITS,
  publicationHealth,
  publicationTarget,
  slotName,
  subscriptionHealth,
  subscriptionsOfPublication,
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
  Component: { Badge, BadgeBoolean, DrawerItem, DrawerTitle, Table, TableCell, TableHead, TableRow, WithTooltip },
} = Renderer;

export interface PublicationDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Publication> {
  extension: Renderer.LensExtension;
}

export const PublicationDetails = observer((props: PublicationDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== Publication.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const publicationStore = maybe(() => Publication.getStore<Publication>());
    const subscriptionStore = maybe(() => Subscription.getStore<Subscription>());

    // A subscriber may live in another namespace: the clusters and the
    // subscriptions are read wherever the user can see them.
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: Subscription.crd.plural, store: subscriptionStore },
      { label: Publication.crd.plural, store: publicationStore, namespaces: [namespace] },
    ]);

    const spec = object.spec;
    const clusters = clusterStore?.items ?? [];
    const cluster = clusterOf(object, clusters);
    const known = Boolean(clusterStore?.isLoaded);
    const health = publicationHealth(object, { cluster, known });
    const rivals = conflictingObjects(object, publicationStore?.items ?? []);
    const target = publicationTarget(object);
    const subscriptions = subscriptionsOfPublication(object, subscriptionStore?.items ?? [], clusters);
    const failover = failoverSafety(cluster);
    const parameters = Object.entries(spec?.parameters ?? {});
    const database = spec?.dbname ?? "";

    return (
      <>
        <style>{stylesInline}</style>

        <ReconciliationSection object={object} health={health} rivals={rivals} store={publicationStore} />

        <DrawerTitle>Publication</DrawerTitle>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={Publication.getClusterName(object)}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Database">
          <span className={styles.mono}>{database || "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="Name in PostgreSQL">
          <span className={styles.mono}>{spec?.name ?? "N/A"}</span>
        </DrawerItem>
        <DrawerItem name="Publishes">
          {target.allTables ? "All tables of the database, the future ones included" : target.words}
        </DrawerItem>
        <DrawerItem name="Reclaim policy">{reclaimWords(spec?.publicationReclaimPolicy, "publication")}</DrawerItem>
        {parameters.map(([key, value]) => (
          <DrawerItem key={key} name={key}>
            <span className={styles.mono}>{value}</span>
          </DrawerItem>
        ))}
        {target.objects.length > 0 ? (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.kind}>Kind</TableCell>
              <TableCell className={styles.name}>Name</TableCell>
              <TableCell className={styles.message}>Published</TableCell>
            </TableHead>
            {target.objects.map((entry) => (
              <TableRow key={`${entry.kind}/${entry.name}`} nowrap>
                <TableCell className={styles.kind}>{entry.kind}</TableCell>
                <TableCell className={styles.name}>
                  <WithTooltip>{entry.name}</WithTooltip>
                </TableCell>
                <TableCell className={styles.message}>
                  <WithTooltip>{entry.detail}</WithTooltip>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        ) : null}

        <DrawerTitle>Subscriptions</DrawerTitle>
        {subscriptions.length === 0 ? (
          <DrawerItem name="Consumed by">
            No Subscription object of this Kubernetes cluster; a subscriber elsewhere would still show as a slot below
          </DrawerItem>
        ) : (
          subscriptions.map((subscription) => {
            const subscriber = clusterOf(subscription, clusters);
            const state = subscriptionHealth(subscription, { cluster: subscriber, known });
            return (
              <div key={`${subscription.getNs()}/${subscription.getName()}`}>
                <ReplicationPath
                  testId="cnpg-replication-path"
                  publisher={{
                    cluster: (
                      <StoreLink store={clusterStore} name={Publication.getClusterName(object)} namespace={namespace} />
                    ),
                    database,
                    object: spec?.name ?? "N/A",
                  }}
                  subscriber={{
                    cluster: (
                      <StoreLink
                        store={clusterStore}
                        name={Subscription.getClusterName(subscription)}
                        namespace={subscription.getNs()}
                        missing="The Cluster is not there (anymore)"
                      />
                    ),
                    database: subscription.spec?.dbname ?? "",
                    object: (
                      <StoreLink
                        store={subscriptionStore}
                        name={subscription.getName()}
                        namespace={subscription.getNs()}
                      />
                    ),
                  }}
                />
                <DrawerItem name={subscription.getName()} labelsOnly>
                  <Badge className={state.className} label={state.label} tooltip={state.reason} />
                </DrawerItem>
              </div>
            );
          })
        )}
        <DrawerItem name="Publisher failover" hidden={!failover}>
          <span className={failover?.safe === false ? styles.warning : undefined}>{failover?.words}</span>
        </DrawerItem>
        <div className={styles.note}>{LOGICAL_REPLICATION_LIMITS}.</div>

        <DrawerTitle>Right now</DrawerTitle>
        <RightNow
          cluster={cluster}
          testId="cnpg-publication-live"
          nobody={
            cluster ? "The cluster has no primary to ask" : "The Cluster is not there: there is no primary to ask"
          }
        >
          {(samples) => {
            const slots = logicalSlots(samples, database);
            if (slots.length === 0) {
              return (
                <DrawerItem name="Logical slots">
                  None in database {database}: nobody is subscribed to anything in it
                </DrawerItem>
              );
            }
            return (
              <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
                <TableHead flat sticky={false}>
                  <TableCell className={styles.wide}>Logical slot in {database}</TableCell>
                  <TableCell className={styles.wide}>Subscription here</TableCell>
                  <TableCell className={styles.applied}>Consumed</TableCell>
                  <TableCell className={styles.name}>WAL kept</TableCell>
                </TableHead>
                {slots.map((slot) => {
                  const owner = subscriptions.find((subscription) => slotName(subscription) === slot.name);
                  return (
                    <TableRow key={slot.name} nowrap>
                      <TableCell className={styles.wide}>
                        <WithTooltip>{slot.name}</WithTooltip>
                      </TableCell>
                      <TableCell className={styles.wide}>
                        {owner ? (
                          <StoreLink store={subscriptionStore} name={owner.getName()} namespace={owner.getNs()} />
                        ) : (
                          <WithTooltip tooltip="No Subscription object of this publication uses a slot with this name">
                            N/A
                          </WithTooltip>
                        )}
                      </TableCell>
                      <TableCell className={styles.applied}>
                        <BadgeBoolean value={slot.active} />
                      </TableCell>
                      <TableCell className={styles.name}>
                        <WithTooltip
                          tooltip={slot.retainedBytes === undefined ? undefined : exactBytes(slot.retainedBytes)}
                        >
                          {slot.retainedBytes === undefined ? "N/A" : formatBytes(slot.retainedBytes)}
                        </WithTooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Table>
            );
          }}
        </RightNow>
      </>
    );
  }),
);
