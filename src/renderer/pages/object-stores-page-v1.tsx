/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Object Stores list (SPEC-0009): where the backups and the WAL go, who
// writes there, and how far back the plugin says each store can recover.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore, type ObjectStoreApi } from "../api/barmancloud/object-store-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { humanizeRelative } from "../components/backup-health";
import { withErrorPage } from "../components/error-page";
import { openCreateObjectStoreDialog } from "../components/object-store-create-dialog";
import {
  classifyStore,
  clustersOfStore,
  oldestRecoveryPoint,
  recoveryWindows,
  storeProvider,
} from "../components/object-stores";
import { useReferenceStores } from "../components/reference-loader";
import styles from "./object-stores-page.module.scss";
import stylesInline from "./object-stores-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = ObjectStore;
type KubeObject = ObjectStore;
type KubeObjectApi = ObjectStoreApi;

const notAvailable = "N/A";

function clusters(): Cluster[] {
  return (maybe(() => Cluster.getStore<Cluster>())?.items ?? []) as Cluster[];
}

function storeSearchFields(object: KubeObject): string[] {
  const health = classifyStore(object, clusters());
  return [
    storeProvider(object),
    object.spec?.configuration?.destinationPath ?? "",
    health.state,
    ...clustersOfStore(object, clusters()).map((writer) => writer.name),
  ];
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  provider: (object: KubeObject) => storeProvider(object),
  destination: (object: KubeObject) => object.spec?.configuration?.destinationPath ?? "",
  clusters: (object: KubeObject) => clustersOfStore(object, clusters()).length,
  retention: (object: KubeObject) => object.spec?.retentionPolicy ?? "",
  oldest: (object: KubeObject) => oldestRecoveryPoint(recoveryWindows(object, clusters()))?.getTime() ?? 0,
  condition: (object: KubeObject) => classifyStore(object, clusters()).state,
  status: (object: KubeObject) => classifyStore(object, clusters()).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Provider", sortBy: "provider", className: styles.provider },
  { title: "Destination", sortBy: "destination", className: styles.destination },
  { title: "Clusters", sortBy: "clusters", className: styles.clusters },
  { title: "Retention", sortBy: "retention", className: styles.retention },
  { title: "Oldest recovery point", sortBy: "oldest", className: styles.oldest },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface ObjectStoresPageProps {
  extension: Renderer.LensExtension;
}

export const ObjectStoresPage = observer((props: ObjectStoresPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    // The Clusters column and the condition derive from the clusters that name
    // the store: the loader keeps them loaded while the page is mounted.
    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgObjectStoresTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[(object: KubeObject) => object.getSearchFields(), storeSearchFields]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreateObjectStoreDialog(), addTooltip: "Create object store" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const all = (clusterStore?.items ?? []) as Cluster[];
            const health = classifyStore(object, all);
            const writers = clustersOfStore(object, all);
            const oldest = oldestRecoveryPoint(recoveryWindows(object, all));
            const configuration = object.spec?.configuration;

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
              <WithTooltip key="provider" tooltip={configuration?.endpointURL}>
                {storeProvider(object)}
              </WithTooltip>,
              <WithTooltip key="destination">{configuration?.destinationPath ?? notAvailable}</WithTooltip>,
              <WithTooltip
                key="clusters"
                tooltip={
                  writers.length > 0 ? writers.map((writer) => writer.name).join(", ") : "No cluster writes here"
                }
              >
                {String(writers.length)}
              </WithTooltip>,
              <WithTooltip key="retention">{object.spec?.retentionPolicy ?? notAvailable}</WithTooltip>,
              oldest ? (
                <WithTooltip key="oldest" tooltip={`${oldest.toISOString()}, as the Barman Cloud plugin reports it`}>
                  {humanizeRelative(oldest, new Date())}
                </WithTooltip>
              ) : (
                <WithTooltip key="oldest" tooltip="The plugin reports no recoverability point yet">
                  {notAvailable}
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
