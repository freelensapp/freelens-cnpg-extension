/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Publications list (SPEC-0015): the publishing end of every logical
// replication, what it publishes and who consumes it.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Publication, type PublicationApi } from "../api/cnpg/publication-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { clusterOf } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { publicationHealth, publicationTarget, subscriptionsOfPublication } from "../components/logical-replication";
import { openCreatePublicationDialog } from "../components/publication-create-dialog";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./logical-replication-page.module.scss";
import stylesInline from "./logical-replication-page.module.scss?inline";

import type { ClusterLookup } from "../components/declarative";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = Publication;
type KubeObject = Publication;
type KubeObjectApi = PublicationApi;

function clusters(): Cluster[] {
  return maybe(() => Cluster.getStore<Cluster>())?.items ?? [];
}

function lookup(object: KubeObject): ClusterLookup {
  const store = maybe(() => Cluster.getStore<Cluster>());
  return { cluster: clusterOf(object, store?.items ?? []), known: Boolean(store?.isLoaded) };
}

function consumers(object: KubeObject): Subscription[] {
  const store = maybe(() => Subscription.getStore<Subscription>());
  return subscriptionsOfPublication(object, store?.items ?? [], clusters());
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  database: (object: KubeObject) => object.spec?.dbname ?? "",
  pgName: (object: KubeObject) => object.spec?.name ?? "",
  target: (object: KubeObject) => publicationTarget(object).words,
  subscriptions: (object: KubeObject) => consumers(object).length,
  condition: (object: KubeObject) => publicationHealth(object, lookup(object)).state,
  status: (object: KubeObject) => publicationHealth(object, lookup(object)).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Database", sortBy: "database", className: styles.database },
  { title: "Publication", sortBy: "pgName", className: styles.pgName },
  { title: "Target", sortBy: "target", className: styles.target },
  { title: "Subscriptions", sortBy: "subscriptions", className: styles.subscriptions },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface PublicationsPageProps {
  extension: Renderer.LensExtension;
}

export const PublicationsPage = observer((props: PublicationsPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const subscriptionStore = maybe(() => Subscription.getStore<Subscription>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: Subscription.crd.plural, store: subscriptionStore },
    ]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgPublicationsTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [
              KubeObject.getClusterName(object) ?? "",
              object.spec?.dbname ?? "",
              object.spec?.name ?? "",
              publicationHealth(object, lookup(object)).state,
            ],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreatePublicationDialog(), addTooltip: "Create publication" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = publicationHealth(object, lookup(object));
            const target = publicationTarget(object);
            const subscriptions = consumers(object);

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
              <WithTooltip key="pgName" tooltip="The name of the publication inside PostgreSQL">
                {object.spec?.name ?? "N/A"}
              </WithTooltip>,
              <WithTooltip
                key="target"
                tooltip={
                  target.allTables
                    ? "Every table of the database, the future ones included"
                    : target.objects.map((entry) => entry.name).join(", ")
                }
              >
                {target.words}
              </WithTooltip>,
              subscriptions.length === 1 ? (
                <StoreLink
                  key="subscriptions"
                  store={subscriptionStore}
                  name={subscriptions[0].getName()}
                  namespace={subscriptions[0].getNs()}
                />
              ) : (
                <WithTooltip
                  key="subscriptions"
                  tooltip={
                    subscriptions.length === 0
                      ? "No Subscription object of this Kubernetes cluster consumes it"
                      : subscriptions.map((subscription) => subscription.getName()).join(", ")
                  }
                >
                  {subscriptions.length === 0 ? "None here" : String(subscriptions.length)}
                </WithTooltip>
              ),
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
