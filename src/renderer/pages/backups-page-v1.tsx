/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Backups list (SPEC-0005 "Backups list"): the standard list layout with
// the column grammar of DESIGN.md section 1, fed by the pure backup
// classifier so it never disagrees with the drawer and the history strip.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Backup, type BackupApi } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { backupDuration, backupStart, classifyBackup, humanizeDuration } from "../components/backup-health";
import { withErrorPage } from "../components/error-page";
import { MethodLabel } from "../components/method-label";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./backups-page.module.scss";
import stylesInline from "./backups-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, KubeObjectAge, KubeObjectListLayout, NamespaceSelectBadge, ReactiveDuration, WithTooltip },
  K8sApi: { podsStore },
} = Renderer;

const KubeObject = Backup;
type KubeObject = Backup;
type KubeObjectApi = BackupApi;

const notAvailable = "N/A";

/** Terms the doors from the other views search for: the cluster, the parent schedule, the method, the outcome. */
function backupSearchFields(object: KubeObject): string[] {
  const health = classifyBackup(object);
  return [
    KubeObject.getClusterName(object) ?? "",
    KubeObject.getParentSchedule(object) ?? "",
    KubeObject.getMethod(object),
    health.state,
    health.reason,
  ];
}

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  method: (object: KubeObject) => KubeObject.getMethod(object),
  schedule: (object: KubeObject) => KubeObject.getParentSchedule(object) ?? "",
  instance: (object: KubeObject) => KubeObject.getInstancePod(object) ?? "",
  started: (object: KubeObject) => backupStart(object)?.getTime() ?? 0,
  duration: (object: KubeObject) => backupDuration(object) ?? -1,
  condition: (object: KubeObject) => classifyBackup(object).state,
  status: (object: KubeObject) => classifyBackup(object).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Method", sortBy: "method", className: styles.method },
  { title: "Schedule", sortBy: "schedule", className: styles.schedule },
  { title: "Instance", sortBy: "instance", className: styles.instance },
  { title: "Started", sortBy: "started", className: styles.started },
  { title: "Duration", sortBy: "duration", className: styles.duration },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface BackupsPageProps {
  extension: Renderer.LensExtension;
}

export const BackupsPage = observer((props: BackupsPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const scheduleStore = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());

    // The Cluster, Schedule and Instance columns link only to objects that are
    // in their stores: the loader keeps those stores filled and watched while
    // the page is mounted (DESIGN.md section 3).
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: ScheduledBackup.crd.plural, store: scheduleStore },
      { label: "pods", store: podsStore },
    ]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgBackupsTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[(object: KubeObject) => object.getSearchFields(), backupSearchFields]}
          renderHeaderTitle={KubeObject.crd.title}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const health = classifyBackup(object);
            const namespace = object.getNs() ?? "";
            const started = backupStart(object);
            const duration = backupDuration(object);

            return [
              <WithTooltip key="name">{object.getName()}</WithTooltip>,
              <NamespaceSelectBadge key="namespace" namespace={namespace} />,
              <StoreLink
                key="cluster"
                store={clusterStore}
                name={KubeObject.getClusterName(object)}
                namespace={namespace}
                missing="The Cluster is not there (anymore)"
              />,
              <MethodLabel
                key="method"
                method={KubeObject.getMethod(object)}
                declared={Boolean(object.spec?.method)}
              />,
              <StoreLink
                key="schedule"
                store={scheduleStore}
                name={KubeObject.getParentSchedule(object)}
                namespace={namespace}
                missing="The ScheduledBackup is not there (anymore)"
              />,
              <StoreLink
                key="instance"
                store={podsStore}
                name={KubeObject.getInstancePod(object)}
                namespace={namespace}
                missing="The instance pod is not there (anymore)"
              />,
              started && object.status?.startedAt ? (
                <WithTooltip key="started" tooltip={started.toISOString()}>
                  <ReactiveDuration timestamp={started.toISOString()} />
                </WithTooltip>
              ) : (
                <span key="started">{notAvailable}</span>
              ),
              duration !== undefined ? (
                <WithTooltip key="duration" tooltip={`${duration / 1000} s`}>
                  {humanizeDuration(duration)}
                </WithTooltip>
              ) : (
                <span key="duration">{notAvailable}</span>
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
