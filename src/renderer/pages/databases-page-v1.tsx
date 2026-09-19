/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Databases list (SPEC-0013): every database declared for a cluster, and
// whether PostgreSQL has it as declared.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Database, type DatabaseApi } from "../api/cnpg/database-v1";
import { clusterOf, databaseHealth, managedObjects } from "../components/declarative";
import { withErrorPage } from "../components/error-page";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./databases-page.module.scss";
import stylesInline from "./databases-page.module.scss?inline";

import type { ClusterLookup } from "../components/declarative";

const { observer } = MobxReact;

const {
  Component: { Badge, Icon, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = Database;
type KubeObject = Database;
type KubeObjectApi = DatabaseApi;

function lookup(object: KubeObject): ClusterLookup {
  const store = maybe(() => Cluster.getStore<Cluster>());
  return { cluster: clusterOf(object, store?.items ?? []), known: Boolean(store?.isLoaded) };
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  database: (object: KubeObject) => object.spec?.name ?? "",
  owner: (object: KubeObject) => object.spec?.owner ?? "",
  objects: (object: KubeObject) => managedObjects(object).length,
  reclaim: (object: KubeObject) => object.spec?.databaseReclaimPolicy ?? "retain",
  condition: (object: KubeObject) => databaseHealth(object, lookup(object)).state,
  status: (object: KubeObject) => databaseHealth(object, lookup(object)).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Database", sortBy: "database", className: styles.database },
  { title: "Owner", sortBy: "owner", className: styles.owner },
  { title: "Objects", sortBy: "objects", className: styles.objects },
  { title: "Reclaim", sortBy: "reclaim", className: styles.reclaim },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface DatabasesPageProps {
  extension: Renderer.LensExtension;
}

export const DatabasesPage = observer((props: DatabasesPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgDatabasesTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [
              KubeObject.getClusterName(object) ?? "",
              object.spec?.name ?? "",
              object.spec?.owner ?? "",
              databaseHealth(object, lookup(object)).state,
            ],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = databaseHealth(object, lookup(object));
            const objects = managedObjects(object);
            const failed = objects.filter((row) => row.applied === false).length;

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
              <WithTooltip key="database" tooltip="The name of the database inside PostgreSQL">
                {object.spec?.name ?? "N/A"}
              </WithTooltip>,
              <WithTooltip key="owner">{object.spec?.owner ?? "N/A"}</WithTooltip>,
              <span key="objects" className={styles.objectsCell}>
                <WithTooltip tooltip="Extensions, schemas, foreign data wrappers and foreign servers the operator manages in it">
                  {String(objects.length)}
                </WithTooltip>
                {failed > 0 ? (
                  <Icon small material="error_outline" className={styles.failed} tooltip={`${failed} failed`} />
                ) : null}
              </span>,
              <WithTooltip
                key="reclaim"
                tooltip={
                  object.spec?.databaseReclaimPolicy === "delete"
                    ? "Deleting the object drops the database"
                    : "Deleting the object leaves the database in PostgreSQL"
                }
              >
                {object.spec?.databaseReclaimPolicy ?? "retain"}
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
