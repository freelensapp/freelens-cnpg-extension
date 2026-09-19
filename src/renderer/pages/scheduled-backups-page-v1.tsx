/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Scheduled Backups list (SPEC-0005 "Scheduled Backups list"): the
// standard list layout, the schedule as written and in words, the last and
// the next run, and the pure schedule classifier that makes a suspended
// schedule impossible to miss.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup, type ScheduledBackupApi } from "../api/cnpg/scheduled-backup-v1";
import { classifySchedule, humanizeRelative } from "../components/backup-health";
import { describeSchedule, SCHEDULE_TIME_ZONE_NOTE } from "../components/cron-text";
import { withErrorPage } from "../components/error-page";
import { parseGoTime } from "../components/go-time";
import { MethodLabel } from "../components/method-label";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./scheduled-backups-page.module.scss";
import stylesInline from "./scheduled-backups-page.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: {
    Badge,
    BadgeBoolean,
    KubeObjectAge,
    KubeObjectListLayout,
    NamespaceSelectBadge,
    ReactiveDuration,
    WithTooltip,
  },
} = Renderer;

const KubeObject = ScheduledBackup;
type KubeObject = ScheduledBackup;
type KubeObjectApi = ScheduledBackupApi;

const notAvailable = "N/A";

function scheduleSearchFields(object: KubeObject): string[] {
  const health = classifySchedule(object);
  return [
    KubeObject.getClusterName(object) ?? "",
    KubeObject.getMethod(object),
    object.spec?.schedule ?? "",
    health.state,
    health.reason,
  ];
}

const time = (value: string | undefined) => parseGoTime(value)?.getTime() ?? 0;

const sortingCallbacks = {
  name: (object: KubeObject) => object.getName(),
  namespace: (object: KubeObject) => object.getNs(),
  cluster: (object: KubeObject) => KubeObject.getClusterName(object) ?? "",
  schedule: (object: KubeObject) => object.spec?.schedule ?? "",
  method: (object: KubeObject) => KubeObject.getMethod(object),
  lastRun: (object: KubeObject) => time(object.status?.lastScheduleTime),
  nextRun: (object: KubeObject) => time(object.status?.nextScheduleTime),
  active: (object: KubeObject) => String(!KubeObject.isSuspended(object)),
  condition: (object: KubeObject) => classifySchedule(object).state,
  status: (object: KubeObject) => classifySchedule(object).reason,
  age: (object: KubeObject) => object.getCreationTimestamp(),
};

const renderTableHeader: { title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[] = [
  { title: "Name", sortBy: "name" },
  { title: "Namespace", sortBy: "namespace" },
  { title: "Cluster", sortBy: "cluster", className: styles.cluster },
  { title: "Schedule", sortBy: "schedule", className: styles.schedule },
  { title: "Method", sortBy: "method", className: styles.method },
  { title: "Last run", sortBy: "lastRun", className: styles.lastRun },
  { title: "Next run", sortBy: "nextRun", className: styles.nextRun },
  { title: "Active", sortBy: "active", className: styles.active },
  { title: "Condition", sortBy: "condition", className: styles.condition },
  { title: "Status", sortBy: "status", className: styles.status },
  { title: "Age", sortBy: "age", className: styles.age },
];

export interface ScheduledBackupsPageProps {
  extension: Renderer.LensExtension;
}

export const ScheduledBackupsPage = observer((props: ScheduledBackupsPageProps) =>
  withErrorPage(props, () => {
    const store = KubeObject.getStore<KubeObject>();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([{ label: Cluster.crd.plural, store: clusterStore }]);

    return (
      <>
        <style>{stylesInline}</style>
        <KubeObjectListLayout<KubeObject, KubeObjectApi>
          tableId="cnpgScheduledBackupsTable"
          className={styles.page}
          store={store}
          sortingCallbacks={sortingCallbacks}
          searchFilters={[(object: KubeObject) => object.getSearchFields(), scheduleSearchFields]}
          renderHeaderTitle={KubeObject.crd.title}
          renderTableHeader={renderTableHeader}
          renderTableContents={(object: KubeObject) => {
            const now = new Date();
            const health = classifySchedule(object, now);
            const namespace = object.getNs() ?? "";
            const expression = object.spec?.schedule ?? "";
            const words = describeSchedule(expression);
            const suspended = KubeObject.isSuspended(object);
            const lastRun = parseGoTime(object.status?.lastScheduleTime);
            const nextRun = parseGoTime(object.status?.nextScheduleTime);

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
              <WithTooltip
                key="schedule"
                tooltip={
                  words
                    ? `${words}, ${SCHEDULE_TIME_ZONE_NOTE} (the first field is the seconds)`
                    : "Six fields, the first one is the seconds; descriptors such as @daily are accepted"
                }
              >
                <span className={styles.expression}>{expression || notAvailable}</span>
              </WithTooltip>,
              <MethodLabel
                key="method"
                method={KubeObject.getMethod(object)}
                declared={Boolean(object.spec?.method)}
              />,
              lastRun ? (
                <WithTooltip key="lastRun" tooltip={lastRun.toISOString()}>
                  <ReactiveDuration timestamp={lastRun.toISOString()} />
                </WithTooltip>
              ) : (
                <WithTooltip key="lastRun" tooltip="No run yet">
                  {notAvailable}
                </WithTooltip>
              ),
              nextRun && !suspended ? (
                <WithTooltip key="nextRun" tooltip={nextRun.toISOString()}>
                  {humanizeRelative(nextRun, now)}
                </WithTooltip>
              ) : (
                <WithTooltip
                  key="nextRun"
                  tooltip={suspended ? "Suspended: no run is planned" : "The operator has not reported a next run yet"}
                >
                  {notAvailable}
                </WithTooltip>
              ),
              <BadgeBoolean key="active" value={!suspended} />,
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
