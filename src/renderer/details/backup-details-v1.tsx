/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Backup drawer (SPEC-0005 "Backup drawer"): what happened to the backup,
// where it came from, how long it took, the coordinates an operator needs to
// restore from it and where it was written. Every section guards itself and
// disappears when the backup never got far enough to fill it.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import {
  backupDuration,
  backupTimeline,
  classifyBackup,
  humanizeDuration,
  walDuringBackup,
} from "../components/backup-health";
import { exactBytes, formatBytes } from "../components/bytes";
import { withErrorPage } from "../components/error-page";
import { parseGoTime } from "../components/go-time";
import { MethodLabel } from "../components/method-label";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./backup-details.module.scss";
import stylesInline from "./backup-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, LocaleDate, Table, TableCell, TableHead, TableRow, WithTooltip },
  K8sApi: { podsStore },
} = Renderer;

const notAvailable = "N/A";

export interface BackupDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Backup> {
  extension: Renderer.LensExtension;
}

function Moment({ value }: { value: string | undefined }) {
  const date = parseGoTime(value);
  return date ? <LocaleDate date={date} /> : <>{notAvailable}</>;
}

/** The object store the plugin wrote to: declared on the backup, else on the cluster's plugin entry. */
function objectStoreName(backup: Backup, cluster: Cluster | undefined): string | undefined {
  const declared = backup.spec?.pluginConfiguration?.parameters?.barmanObjectName;
  if (declared) return declared;
  const pluginName = backup.spec?.pluginConfiguration?.name;
  const entry = cluster?.spec?.plugins?.find((plugin) => plugin.name === pluginName);
  return entry?.parameters?.barmanObjectName;
}

export const BackupDetails = observer((props: BackupDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object, never an instance
    // of this class (AGENTS.md "CRD KubeObject Pattern"): guard on the kind.
    if (!object || object.kind !== Backup.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const spec = object.spec;
    const status = object.status;
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());
    const scheduleStore = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
    const clusterName = Backup.getClusterName(object);
    const parentSchedule = Backup.getParentSchedule(object);
    const instancePod = Backup.getInstancePod(object);

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: ScheduledBackup.crd.plural, store: scheduleStore, namespaces: [namespace] },
      { label: "pods", store: podsStore, namespaces: [namespace] },
    ]);

    const health = classifyBackup(object);
    const method = Backup.getMethod(object);
    const duration = backupDuration(object);
    const timeline = backupTimeline(object);
    const wal = walDuringBackup(object);
    const cluster = clusterName ? (clusterStore?.getByName(clusterName, namespace) as Cluster | undefined) : undefined;
    const objectStore = objectStoreName(object, cluster);
    const errorText = [status?.error, status?.commandError].filter(Boolean).join("\n").trim();
    const errorLines = errorText ? errorText.split("\n").length : 0;
    const hasCoordinates = Boolean(
      status?.backupId ||
        status?.backupName ||
        status?.beginWal ||
        status?.beginLSN ||
        status?.endWal ||
        status?.endLSN,
    );
    const pluginMetadata = Object.entries(status?.pluginMetadata ?? {});
    const snapshotElements = status?.snapshotBackupStatus?.elements ?? [];
    const online = status?.online ?? spec?.online;

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Outcome</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{health.reason}</DrawerItem>
        <DrawerItem name="Phase">{status?.phase || notAvailable}</DrawerItem>
        <DrawerItem name="Method" labelsOnly={method === "barmanObjectStore"}>
          <MethodLabel method={method} declared={Boolean(spec?.method)} />
        </DrawerItem>
        <DrawerItem name="Mode" hidden={online === undefined}>
          {online ? "Online (hot backup)" : "Offline (cold backup)"}
        </DrawerItem>
        <DrawerItem name="Target" hidden={!spec?.target}>
          {spec?.target}
        </DrawerItem>
        {errorLines > 1 ? <pre className={styles.errorText}>{errorText}</pre> : null}

        <DrawerTitle>Source</DrawerTitle>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={clusterName}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Instance">
          <StoreLink
            store={podsStore}
            name={instancePod}
            namespace={namespace}
            missing="The instance pod is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="PostgreSQL major" hidden={status?.majorVersion === undefined}>
          {status?.majorVersion}
        </DrawerItem>
        <DrawerItem name="Schedule">
          <StoreLink
            store={scheduleStore}
            name={parentSchedule}
            namespace={namespace}
            missing="The ScheduledBackup is not there (anymore)"
            empty="On demand"
          />
        </DrawerItem>

        <DrawerTitle>Timing</DrawerTitle>
        <DrawerItem name="Started">
          <Moment value={status?.startedAt} />
        </DrawerItem>
        <DrawerItem name="Stopped">
          <Moment value={status?.stoppedAt} />
        </DrawerItem>
        <DrawerItem name="Duration" hidden={duration === undefined}>
          <WithTooltip tooltip={duration !== undefined ? `${duration / 1000} s` : undefined}>
            {duration !== undefined ? humanizeDuration(duration) : notAvailable}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Reconciliation started" hidden={!status?.reconciliationStartedAt}>
          <Moment value={status?.reconciliationStartedAt} />
        </DrawerItem>
        <DrawerItem name="Reconciliation ended" hidden={!status?.reconciliationTerminatedAt}>
          <Moment value={status?.reconciliationTerminatedAt} />
        </DrawerItem>

        {hasCoordinates ? (
          <>
            <DrawerTitle>Restore coordinates</DrawerTitle>
            <DrawerItem name="Backup ID" hidden={!status?.backupId}>
              <span className={styles.coordinate}>{status?.backupId}</span>
            </DrawerItem>
            <DrawerItem name="Backup name" hidden={!status?.backupName}>
              <span className={styles.coordinate}>{status?.backupName}</span>
            </DrawerItem>
            <DrawerItem name="Timeline" hidden={timeline === undefined}>
              <span className={styles.coordinate}>{timeline}</span>
            </DrawerItem>
            <DrawerItem name="Begin WAL" hidden={!status?.beginWal}>
              <span className={styles.coordinate}>{status?.beginWal}</span>
            </DrawerItem>
            <DrawerItem name="End WAL" hidden={!status?.endWal}>
              <span className={styles.coordinate}>{status?.endWal}</span>
            </DrawerItem>
            <DrawerItem name="Begin LSN" hidden={!status?.beginLSN}>
              <span className={styles.coordinate}>{status?.beginLSN}</span>
            </DrawerItem>
            <DrawerItem name="End LSN" hidden={!status?.endLSN}>
              <span className={styles.coordinate}>{status?.endLSN}</span>
            </DrawerItem>
            <DrawerItem name="WAL during backup" hidden={wal === undefined}>
              <WithTooltip tooltip={wal !== undefined ? exactBytes(wal) : undefined}>
                {wal !== undefined ? formatBytes(wal) : notAvailable}
              </WithTooltip>
            </DrawerItem>
          </>
        ) : null}

        <DrawerTitle>Destination</DrawerTitle>
        {method === "plugin" ? (
          <>
            <DrawerItem name="Plugin">{spec?.pluginConfiguration?.name ?? notAvailable}</DrawerItem>
            <DrawerItem name="Plugin version" hidden={!status?.pluginMetadata?.version}>
              {status?.pluginMetadata?.version}
            </DrawerItem>
            <DrawerItem name="Object store">
              <WithTooltip tooltip={objectStore ? "ObjectStore of the Barman Cloud plugin, same namespace" : undefined}>
                {objectStore ?? notAvailable}
              </WithTooltip>
            </DrawerItem>
          </>
        ) : null}
        {method === "barmanObjectStore" ? (
          <>
            <DrawerItem name="Destination path">
              <WithTooltip>{status?.destinationPath ?? notAvailable}</WithTooltip>
            </DrawerItem>
            <DrawerItem name="Server name" hidden={!status?.serverName}>
              {status?.serverName}
            </DrawerItem>
          </>
        ) : null}
        {method === "volumeSnapshot" ? (
          snapshotElements.length > 0 ? (
            <Table scrollable={false} sortSyncWithUrl={false} className={styles.snapshots}>
              <TableHead flat sticky={false}>
                <TableCell className={styles.name}>Volume snapshot</TableCell>
                <TableCell className={styles.type}>Type</TableCell>
                <TableCell className={styles.tablespace}>Tablespace</TableCell>
              </TableHead>
              {snapshotElements.map((element, index) => (
                <TableRow key={String(element.name ?? index)} nowrap>
                  <TableCell className={styles.name}>
                    <WithTooltip>{String(element.name ?? notAvailable)}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.type}>{String(element.type ?? notAvailable)}</TableCell>
                  <TableCell className={styles.tablespace}>{String(element.tablespaceName ?? "")}</TableCell>
                </TableRow>
              ))}
            </Table>
          ) : (
            <DrawerItem name="Volume snapshots">None reported yet</DrawerItem>
          )
        ) : null}

        {pluginMetadata.length > 0 ? (
          <>
            <DrawerTitle>Plugin metadata</DrawerTitle>
            <Table scrollable={false} sortSyncWithUrl={false} className={styles.metadata}>
              <TableHead flat sticky={false}>
                <TableCell className={styles.key}>Key</TableCell>
                <TableCell className={styles.value}>Value</TableCell>
              </TableHead>
              {pluginMetadata.map(([key, value]) => (
                <TableRow key={key} nowrap>
                  <TableCell className={styles.key}>
                    <WithTooltip>{key}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.value}>
                    <WithTooltip>{value}</WithTooltip>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </>
        ) : null}
      </>
    );
  }),
);
