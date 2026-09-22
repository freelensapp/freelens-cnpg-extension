/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Subscriptions list (SPEC-0015): the consuming end of every logical
// replication, and the publisher it points to, resolved to a cluster of this
// Kubernetes cluster when it is one.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Subscription, type SubscriptionApi } from "../api/cnpg/subscription-v1";
import { clusterOf } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { resolvePublisher, subscriptionHealth } from "../components/logical-replication";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import { openCreateSubscriptionDialog } from "../components/subscription-create-dialog";
import styles from "./logical-replication-page.module.scss";
import stylesInline from "./logical-replication-page.module.scss?inline";

import type { ClusterLookup } from "../components/declarative";
import type { PublisherView } from "../components/logical-replication";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = Subscription;
type KubeObject = Subscription;
type KubeObjectApi = SubscriptionApi;

function lookup(object: KubeObject): ClusterLookup {
  const store = maybe(() => Cluster.getStore<Cluster>());
  return { cluster: clusterOf(object, store?.items ?? []), known: Boolean(store?.isLoaded) };
}

function publisherOf(object: KubeObject): PublisherView {
  const all = maybe(() => Cluster.getStore<Cluster>())?.items ?? [];
  return resolvePublisher(object, clusterOf(object, all), all);
}

/** What the Publisher column shows: the cluster when resolved, the host when external, the entry name otherwise. */
function publisherLabel(publisher: PublisherView): string {
  if (publisher.outcome === "resolved") return publisher.cluster?.metadata?.name ?? publisher.externalClusterName;
  return publisher.host ?? publisher.externalClusterName;
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  database: (object: KubeObject) => object.spec?.dbname ?? "",
  pgName: (object: KubeObject) => object.spec?.name ?? "",
  publisher: (object: KubeObject) => publisherLabel(publisherOf(object)),
  publication: (object: KubeObject) => object.spec?.publicationName ?? "",
  condition: (object: KubeObject) => subscriptionHealth(object, lookup(object)).state,
  status: (object: KubeObject) => subscriptionHealth(object, lookup(object)).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Database", sortBy: "database", className: styles.database },
  { title: "Subscription", sortBy: "pgName", className: styles.pgName },
  { title: "Publisher", sortBy: "publisher", className: styles.publisher },
  { title: "Publication", sortBy: "publication", className: styles.publication },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface SubscriptionsPageProps {
  extension: Renderer.LensExtension;
}

export const SubscriptionsPage = observer((props: SubscriptionsPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgSubscriptionsTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [
              KubeObject.getClusterName(object) ?? "",
              object.spec?.dbname ?? "",
              object.spec?.name ?? "",
              object.spec?.publicationName ?? "",
              publisherLabel(publisherOf(object)),
              subscriptionHealth(object, lookup(object)).state,
            ],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreateSubscriptionDialog(), addTooltip: "Create subscription" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = subscriptionHealth(object, lookup(object));
            const publisher = publisherOf(object);

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
              <StoreLink
                key="cluster"
                store={clusterStore}
                name={KubeObject.getClusterName(object)}
                namespace={object.getNs()}
                missing="The Cluster is not there (anymore)"
              />,
              <WithTooltip key="database">{object.spec?.dbname ?? "N/A"}</WithTooltip>,
              <WithTooltip key="pgName" tooltip="The name of the subscription inside PostgreSQL">
                {object.spec?.name ?? "N/A"}
              </WithTooltip>,
              publisher.outcome === "resolved" ? (
                <StoreLink
                  key="publisher"
                  store={clusterStore}
                  name={publisher.cluster?.metadata?.name}
                  namespace={publisher.cluster?.metadata?.namespace}
                />
              ) : (
                <WithTooltip key="publisher" tooltip={publisher.words}>
                  {publisherLabel(publisher) || "N/A"}
                </WithTooltip>
              ),
              <WithTooltip key="publication" tooltip="The name of the publication inside the publisher's PostgreSQL">
                {object.spec?.publicationName ?? "N/A"}
              </WithTooltip>,
              <Badge key="condition" className={health.className} label={health.label} tooltip={health.reason} />,
              <WithTooltip key="status">{health.reason}</WithTooltip>,
              <KubeObjectAge key="age" object={object} />,
            ];
          }}
        />
      </>
    );
  }),
);
