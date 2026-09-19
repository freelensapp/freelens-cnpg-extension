/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Failover Quorums list (SPEC-0011): for every cluster with the failover
// quorum on, whether a failover could be decided safely right now.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { FailoverQuorum, type FailoverQuorumApi } from "../api/cnpg/failover-quorum-v1";
import { withErrorPage } from "../components/error-page";
import { clusterOfQuorum, quorumFacts } from "../components/failover-quorum";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./failover-quorums-page.module.scss";
import stylesInline from "./failover-quorums-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = FailoverQuorum;
type KubeObject = FailoverQuorum;
type KubeObjectApi = FailoverQuorumApi;

function clusters(): Cluster[] {
  return (maybe(() => Cluster.getStore<Cluster>())?.items ?? []) as Cluster[];
}

const factsOf = (object: KubeObject) => quorumFacts(object, clusterOfQuorum(object, clusters()));

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => object.getName(),
  method: (object: KubeObject) => factsOf(object).method ?? "",
  mustConfirm: (object: KubeObject) => factsOf(object).mustConfirm,
  standbys: (object: KubeObject) => factsOf(object).named,
  condition: (object: KubeObject) => factsOf(object).state,
  status: (object: KubeObject) => factsOf(object).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Method", sortBy: "method", className: styles.method },
  { title: "Must confirm", sortBy: "mustConfirm", className: styles.number },
  { title: "Standbys", sortBy: "standbys", className: styles.standbys },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface FailoverQuorumsPageProps {
  extension: Renderer.LensExtension;
}

export const FailoverQuorumsPage = observer((props: FailoverQuorumsPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    // The condition derives from the cluster of the quorum: the loader keeps the clusters loaded.
    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgFailoverQuorumsTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[
            (object: KubeObject) => object.getSearchFields(),
            (object: KubeObject) => [factsOf(object).state, ...(object.status?.standbyNames ?? [])],
          ]}
          renderHeaderTitle={KubeObject.crd.title}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const facts = quorumFacts(object, clusterOfQuorum(object, (clusterStore?.items ?? []) as Cluster[]));

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
              <StoreLink
                key="cluster"
                store={clusterStore}
                name={object.getName()}
                namespace={object.getNs()}
                missing="Its cluster is not there"
              />,
              <WithTooltip key="method" tooltip="ANY: any of the named standbys; FIRST: the first ones, in order">
                {facts.method ?? "N/A"}
              </WithTooltip>,
              <WithTooltip key="mustConfirm" tooltip="How many standbys a commit waits for (W)">
                {String(facts.mustConfirm)}
              </WithTooltip>,
              <WithTooltip
                key="standbys"
                tooltip={
                  facts.standbys.map((standby) => standby.name).join(", ") || "No potentially synchronous standby named"
                }
              >
                {`${facts.healthy}/${facts.named}`}
              </WithTooltip>,
              <Badge key="condition" className={facts.className} label={facts.label} tooltip={facts.reason} />,
              <WithTooltip key="status">{facts.reason}</WithTooltip>,
              <KubeObjectAge key="age" object={object} />,
            ];
          }}
        />
      </>
    );
  }),
);
