/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The PostgreSQL Clusters list (SPEC-0003 "List page"): the standard list
// layout with the column grammar of DESIGN.md section 1, fed by the pure
// health model so it never disagrees with the drawer and the Overview.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster, type ClusterApi } from "../api/cnpg/cluster-v1";
import { openCreateClusterDialog } from "../components/cluster-create-dialog";
import { archivingState, backupFacts, classifyCluster, instanceFacts } from "../components/cluster-health";
import { withErrorPage } from "../components/error-page";
import { InstanceBricks } from "../components/instance-bricks";
import { useReferenceStores } from "../components/reference-loader";
import styles from "./clusters-page.module.scss";
import stylesInline from "./clusters-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, BadgeBoolean, Icon, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, WithTooltip },
} = Renderer;

const KubeObject = Cluster;
type KubeObject = Cluster;
type KubeObjectApi = ClusterApi;

const notAvailable = "N/A";

/** Search terms that match the health words, so "Degraded" filters the list (SPEC-0004 strip). */
function healthSearchFields(object: KubeObject): string[] {
  const health = classifyCluster(object);
  return [health.state, health.reason, archivingState(object).state];
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  instances: (object: KubeObject) => KubeObject.getReadyInstances(object),
  primary: (object: KubeObject) => KubeObject.getPrimary(object) ?? "",
  postgres: (object: KubeObject) => object.status?.pgDataImageInfo?.majorVersion ?? 0,
  archiving: (object: KubeObject) => archivingState(object).state,
  backup: (object: KubeObject) =>
    backupFacts(object, backupsOf(object), storesOf(object)).lastSuccessful?.getTime() ?? 0,
  condition: (object: KubeObject) => classifyCluster(object).state,
  status: (object: KubeObject) => classifyCluster(object).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Instances", sortBy: "instances", className: styles.instances },
  { title: "Primary", sortBy: "primary", className: styles.primary },
  { title: "PostgreSQL", sortBy: "postgres", className: styles.postgres },
  { title: "Archiving", sortBy: "archiving", className: styles.archiving },
  { title: "Last backup", sortBy: "backup", className: styles.backup },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

/** The Backup objects the store currently holds; the list column reads them, SPEC-0005 pages them. */
function backupsOf(object: KubeObject): Backup[] {
  const store = maybe(() => Backup.getStore<Backup>());
  const items = (store?.items ?? []) as Backup[];
  return items.filter((backup) => backup.getNs() === object.getNs());
}

/** The object stores of the row's namespace, when the Barman Cloud plugin is installed (SPEC-0009). */
function storesOf(object: KubeObject): ObjectStore[] {
  const store = maybe(() => ObjectStore.getStore<ObjectStore>());
  const items = (store?.items ?? []) as ObjectStore[];
  return items.filter((item) => item.getNs() === object.getNs());
}

export interface ClustersPageProps {
  extension: Renderer.LensExtension;
}

export const ClustersPage = observer((props: ClustersPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const backupStore = maybe(() => Backup.getStore<Backup>());

    // The Last backup column derives from the Backup objects of the same
    // namespaces the list shows; the loader keeps the store filled and watched
    // for as long as the page is mounted (DESIGN.md section 3 rule, applied to
    // a list column).
    useReferenceStores([
      { label: Backup.crd.plural, store: backupStore },
      { label: ObjectStore.crd.plural, store: maybe(() => ObjectStore.getStore<ObjectStore>()) },
    ]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgClustersTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[(object: KubeObject) => object.getSearchFields(), healthSearchFields]}
          renderHeaderTitle={KubeObject.crd.title}
          addRemoveButtons={{ onAdd: () => openCreateClusterDialog(), addTooltip: "Create PostgreSQL cluster" }}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = classifyCluster(object);
            const archiving = archivingState(object);
            const backups = backupFacts(object, backupsOf(object), storesOf(object));
            const declared = KubeObject.getInstances(object);
            const ready = KubeObject.getReadyInstances(object);
            const primary = KubeObject.getPrimary(object);
            const targetPrimary = object.status?.targetPrimary;
            const switching = Boolean(primary && targetPrimary && targetPrimary !== primary);
            const major = object.status?.pgDataImageInfo?.majorVersion;
            const image = object.status?.pgDataImageInfo?.image ?? object.status?.image;
            const lastBackup = backups.lastSuccessful;

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={object.getNs() ?? ""} />,
              <div key="instances" className={styles.instancesCell}>
                <span>
                  {ready}/{declared}
                </span>
                <InstanceBricks instances={instanceFacts(object)} />
              </div>,
              <span key="primary" className={styles.primaryCell}>
                <WithTooltip>{primary ?? notAvailable}</WithTooltip>
                {switching ? (
                  <Icon
                    small
                    material="swap_horiz"
                    className={styles.switching}
                    tooltip={`Switching to the target primary ${targetPrimary}`}
                  />
                ) : null}
              </span>,
              <WithTooltip key="postgres" tooltip={image}>
                {major !== undefined ? String(major) : notAvailable}
              </WithTooltip>,
              <span key="archiving" title={archiving.message}>
                {archiving.state === "Unknown" ? (
                  <BadgeBoolean />
                ) : (
                  <BadgeBoolean value={archiving.state === "Archiving"} />
                )}
              </span>,
              lastBackup ? (
                <WithTooltip
                  key="backup"
                  tooltip={`${lastBackup.toISOString()} (source: ${backups.source === "backups" ? "Backup objects" : backups.source === "object store" ? "object store, no Backup object" : "cluster status, deprecated"})`}
                >
                  <Renderer.Component.ReactiveDuration timestamp={lastBackup.toISOString()} />
                </WithTooltip>
              ) : (
                <WithTooltip key="backup" tooltip="No successful backup found">
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
