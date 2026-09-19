/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Scheduled Backup drawer (SPEC-0005 "Scheduled Backup drawer"): the
// schedule as written and in words, what each run will do, and the backups it
// generated so far, as a history strip and as a table that links both ways.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import {
  backupDuration,
  backupStart,
  classifyBackup,
  classifySchedule,
  humanizeDuration,
  humanizeRelative,
} from "../components/backup-health";
import { buildHistory } from "../components/backup-history";
import { BackupHistoryStrip } from "../components/backup-history-strip";
import { archivingState } from "../components/cluster-health";
import { describeSchedule, SCHEDULE_TIME_ZONE_NOTE } from "../components/cron-text";
import { withErrorPage } from "../components/error-page";
import { parseGoTime } from "../components/go-time";
import { MethodLabel } from "../components/method-label";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import { BACKUPS_PAGE_ID, extensionPageUrl } from "../navigation";
import styles from "./backup-details.module.scss";
import stylesInline from "./backup-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: {
    Badge,
    BadgeBoolean,
    DrawerItem,
    DrawerTitle,
    LocaleDate,
    MaybeLink,
    Table,
    TableCell,
    TableHead,
    TableRow,
    WithTooltip,
  },
  Navigation: { getDetailsUrl },
} = Renderer;

const notAvailable = "N/A";

/** How many generated backups the drawer lists; the door below leads to all of them. */
const GENERATED_LIMIT = 10;

const OWNER_REFERENCE_MEANING: Record<string, string> = {
  none: "The backups have no owner: deleting the schedule or the cluster leaves them in place",
  self: "The schedule owns its backups: deleting the schedule deletes them too",
  cluster: "The cluster owns the backups: deleting the cluster deletes them too",
};

export interface ScheduledBackupDetailsProps extends Renderer.Component.KubeObjectDetailsProps<ScheduledBackup> {
  extension: Renderer.LensExtension;
}

function Moment({ value, now }: { value: string | undefined; now: Date }) {
  const date = parseGoTime(value);
  if (!date) return <>{notAvailable}</>;
  return (
    <>
      <LocaleDate date={date} /> ({humanizeRelative(date, now)})
    </>
  );
}

export const ScheduledBackupDetails = observer((props: ScheduledBackupDetailsProps) =>
  withErrorPage(props, () => {
    const { object, extension } = props;

    // The host hands the drawer a plain copy of the object, never an instance
    // of this class (AGENTS.md "CRD KubeObject Pattern"): guard on the kind.
    if (!object || object.kind !== ScheduledBackup.kind) {
      return <></>;
    }

    const now = new Date();
    const namespace = object.getNs() ?? "";
    const name = object.getName();
    const spec = object.spec;
    const status = object.status;
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const backupStore = maybe(() => Backup.getStore<Backup>());
    const clusterName = ScheduledBackup.getClusterName(object);

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: Backup.crd.plural, store: backupStore, namespaces: [namespace] },
    ]);

    const health = classifySchedule(object, now);
    const method = ScheduledBackup.getMethod(object);
    const suspended = ScheduledBackup.isSuspended(object);
    const words = describeSchedule(spec?.schedule);
    const ownerReference = spec?.backupOwnerReference ?? "none";
    const cluster = clusterName ? (clusterStore?.getByName(clusterName, namespace) as Cluster | undefined) : undefined;

    const generated = ((backupStore?.items ?? []) as Backup[])
      .filter((backup) => backup.getNs() === namespace && Backup.getParentSchedule(backup) === name)
      .sort((a, b) => (backupStart(b)?.getTime() ?? 0) - (backupStart(a)?.getTime() ?? 0));
    const history = buildHistory(generated, [object], now, {
      archivingFailing: cluster ? archivingState(cluster).state === "Failing" : false,
    });
    const listUrl = extensionPageUrl(extension.name, BACKUPS_PAGE_ID, name);
    const backupUrl = (backupName: string) => {
      const backup = backupStore?.getByName(backupName, namespace);
      return backup ? getDetailsUrl(backup.selfLink) : undefined;
    };

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Schedule</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{health.reason}</DrawerItem>
        <DrawerItem name="Expression">
          <WithTooltip tooltip="Six fields, the first one is the seconds; descriptors such as @daily are accepted">
            <span className={styles.coordinate}>{spec?.schedule ?? notAvailable}</span>
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="In words" hidden={!words}>
          {words} ({SCHEDULE_TIME_ZONE_NOTE})
        </DrawerItem>
        <DrawerItem name="Active" labelsOnly>
          <BadgeBoolean value={!suspended} />
        </DrawerItem>
        <DrawerItem name="Immediate">
          {spec?.immediate ? "Yes: a first backup is taken as soon as the schedule is created" : "No"}
        </DrawerItem>
        <DrawerItem name="Last check">
          <Moment value={status?.lastCheckTime} now={now} />
        </DrawerItem>
        <DrawerItem name="Last run">
          <Moment value={status?.lastScheduleTime} now={now} />
        </DrawerItem>
        <DrawerItem name="Next run">
          {suspended ? "Suspended: no run is planned" : <Moment value={status?.nextScheduleTime} now={now} />}
        </DrawerItem>

        <DrawerTitle>Backup template</DrawerTitle>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={clusterName}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Method" labelsOnly={method === "barmanObjectStore"}>
          <MethodLabel method={method} declared={Boolean(spec?.method)} />
        </DrawerItem>
        <DrawerItem name="Target" hidden={!spec?.target}>
          {spec?.target}
        </DrawerItem>
        <DrawerItem name="Mode" hidden={spec?.online === undefined}>
          {spec?.online ? "Online (hot backup)" : "Offline (cold backup)"}
        </DrawerItem>
        <DrawerItem name="Plugin" hidden={!spec?.pluginConfiguration?.name}>
          {spec?.pluginConfiguration?.name}
        </DrawerItem>
        <DrawerItem name="Backup owner">
          <WithTooltip tooltip={OWNER_REFERENCE_MEANING[ownerReference]}>{ownerReference}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Ownership means" hidden={!OWNER_REFERENCE_MEANING[ownerReference]}>
          {OWNER_REFERENCE_MEANING[ownerReference]}
        </DrawerItem>

        <DrawerTitle>Generated backups</DrawerTitle>
        <BackupHistoryStrip history={history} now={now} backupUrl={backupUrl} listUrl={listUrl} />
        {generated.length > 0 ? (
          <>
            <Table scrollable={false} sortSyncWithUrl={false} className={styles.generated}>
              <TableHead flat sticky={false}>
                <TableCell className="name">Backup</TableCell>
                <TableCell className="condition">Condition</TableCell>
                <TableCell className="started">Started</TableCell>
                <TableCell className="duration">Duration</TableCell>
              </TableHead>
              {generated.slice(0, GENERATED_LIMIT).map((backup) => {
                const backupHealth = classifyBackup(backup, now);
                const started = backupStart(backup);
                const duration = backupDuration(backup);
                return (
                  <TableRow key={backup.getName()} nowrap>
                    <TableCell className="name">
                      <StoreLink store={backupStore} name={backup.getName()} namespace={namespace} />
                    </TableCell>
                    <TableCell className="condition">
                      <Badge
                        small
                        className={backupHealth.className}
                        label={backupHealth.label}
                        tooltip={backupHealth.reason}
                      />
                    </TableCell>
                    <TableCell className="started">{started ? humanizeRelative(started, now) : notAvailable}</TableCell>
                    <TableCell className="duration">
                      {duration !== undefined ? humanizeDuration(duration) : notAvailable}
                    </TableCell>
                  </TableRow>
                );
              })}
            </Table>
            <MaybeLink to={listUrl} className={styles.door} onClick={(event) => event.stopPropagation()}>
              All backups of this schedule ({generated.length})
            </MaybeLink>
          </>
        ) : null}
      </>
    );
  }),
);
