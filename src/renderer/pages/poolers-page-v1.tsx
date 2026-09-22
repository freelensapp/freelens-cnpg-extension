/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Poolers list (SPEC-0012): every PgBouncer pooler, what it fronts, how it
// pools and whether it is up.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { Pooler, type PoolerApi } from "../api/cnpg/pooler-v1";
import { withErrorPage } from "../components/error-page";
import { imageShort } from "../components/image-catalogs";
import { openCreatePoolerDialog } from "../components/pooler-create-dialog";
import { classifyPooler, poolerInstances, poolerTypeWords } from "../components/poolers";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./poolers-page.module.scss";
import stylesInline from "./poolers-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = Pooler;
type KubeObject = Pooler;
type KubeObjectApi = PoolerApi;

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  type: (object: KubeObject) => object.spec?.type ?? "rw",
  poolMode: (object: KubeObject) => object.spec?.pgbouncer?.poolMode ?? "",
  instances: (object: KubeObject) => poolerInstances(object).ready,
  image: (object: KubeObject) => object.status?.image ?? "",
  condition: (object: KubeObject) => classifyPooler(object).state,
  status: (object: KubeObject) => classifyPooler(object).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Type", sortBy: "type", className: styles.type },
  { title: "Pool mode", sortBy: "poolMode", className: styles.poolMode },
  { title: "Instances", sortBy: "instances", className: styles.instances },
  { title: "Image", sortBy: "image", className: styles.image },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface PoolersPageProps {
  extension: Renderer.LensExtension;
}

export const PoolersPage = observer((props: PoolersPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgPoolersTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [
              KubeObject.getClusterName(object) ?? "",
              poolerTypeWords(object),
              object.spec?.pgbouncer?.poolMode ?? "",
              classifyPooler(object).state,
            ],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreatePoolerDialog(), addTooltip: "Create pooler" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = classifyPooler(object);
            const { ready, declared } = poolerInstances(object);
            const image = object.status?.image ?? object.spec?.pgbouncer?.image;

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
              <WithTooltip key="type" tooltip="The service of the cluster the pooler connects to">
                {poolerTypeWords(object)}
              </WithTooltip>,
              <WithTooltip
                key="poolMode"
                tooltip="session: a server connection per client session; transaction: per transaction"
              >
                {object.spec?.pgbouncer?.poolMode ?? "session"}
              </WithTooltip>,
              <span key="instances">
                {ready}/{declared}
              </span>,
              <WithTooltip key="image" tooltip={image}>
                {image ? imageShort(image) : "N/A"}
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
