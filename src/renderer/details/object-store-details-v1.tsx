/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Object Store drawer (SPEC-0009): the store, the credentials it refers to
// (names and keys, never a value), how WAL and data are written, the recovery
// window the Barman Cloud plugin reports for every server in the bucket, and
// the clusters that write there.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { humanizeRelative } from "../components/backup-health";
import { withErrorPage } from "../components/error-page";
import { classifyStore, clustersOfStore, recoveryWindows, storeProvider } from "../components/object-stores";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import { BACKUPS_PAGE_ID, extensionPageUrl } from "../navigation";
import styles from "./backup-details.module.scss";
import stylesInline from "./backup-details.module.scss?inline";

import type { SecretKeySelector } from "../api/barmancloud/object-store-v1";
import type { RecoveryWindowState } from "../components/object-stores";

const { observer } = MobxReact;

const {
  Component: { Badge, DrawerItem, DrawerTitle, MaybeLink, Table, TableCell, TableHead, TableRow, WithTooltip },
  K8sApi: { secretsStore },
} = Renderer;

const notAvailable = "N/A";

const WINDOW_CLASS: Record<RecoveryWindowState, string> = { Protected: "success", Failing: "error", Empty: "info" };

export interface ObjectStoreDetailsProps extends Renderer.Component.KubeObjectDetailsProps<ObjectStore> {
  extension: Renderer.LensExtension;
}

/** A reference into a Secret: the name as a link, the key as text, never the value. */
function SecretKey({ label, selector, namespace }: { label: string; selector?: SecretKeySelector; namespace: string }) {
  return (
    <DrawerItem name={label} hidden={!selector?.name}>
      <span className={styles.secretRef}>
        <StoreLink
          store={secretsStore}
          name={selector?.name}
          namespace={namespace}
          missing="The Secret is not in the cluster (yet)"
        />
        {selector?.key ? <span className={styles.secretKey}>key {selector.key}</span> : null}
      </span>
    </DrawerItem>
  );
}

/** A time of the recovery window: relative, so the row stays on one line, with the exact time in the tooltip. */
function Moment({ date, now }: { date: Date | undefined; now: Date }) {
  if (!date) return <>{notAvailable}</>;
  return <WithTooltip tooltip={date.toISOString()}>{humanizeRelative(date, now)}</WithTooltip>;
}

export const ObjectStoreDetails = observer((props: ObjectStoreDetailsProps) =>
  withErrorPage(props, () => {
    const { object, extension } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== ObjectStore.kind) {
      return <></>;
    }

    const now = new Date();
    const namespace = object.getNs() ?? "";
    const configuration = object.spec?.configuration;
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: "secrets", store: secretsStore, namespaces: [namespace] },
    ]);

    const clusters = (clusterStore?.items ?? []) as Cluster[];
    const health = classifyStore(object, clusters);
    const writers = clustersOfStore(object, clusters);
    const windows = recoveryWindows(object, clusters);
    const s3 = configuration?.s3Credentials;
    const azure = configuration?.azureCredentials;
    const google = configuration?.googleCredentials;
    const inherited = [
      s3?.inheritFromIAMRole ? "the IAM role of the platform" : "",
      azure?.inheritFromAzureAD ? "Azure AD workload identity" : "",
      azure?.useDefaultAzureCredentials ? "the default Azure credentials" : "",
      google?.gkeEnvironment ? "the GKE environment" : "",
    ].filter(Boolean);
    const tags = Object.entries(configuration?.tags ?? {});

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Store</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{health.reason}</DrawerItem>
        <DrawerItem name="Provider">{storeProvider(object)}</DrawerItem>
        <DrawerItem name="Destination path">
          <span className={styles.coordinate}>{configuration?.destinationPath ?? notAvailable}</span>
        </DrawerItem>
        <DrawerItem name="Endpoint" hidden={!configuration?.endpointURL}>
          <span className={styles.coordinate}>{configuration?.endpointURL}</span>
        </DrawerItem>
        <SecretKey label="Endpoint CA" selector={configuration?.endpointCA} namespace={namespace} />
        <DrawerItem name="Retention policy">
          <WithTooltip tooltip="How long the plugin keeps backups and the WAL needed to restore them">
            {object.spec?.retentionPolicy ?? "None: nothing is ever deleted"}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Server name" hidden={!configuration?.serverName}>
          <WithTooltip tooltip="Upstream asks to leave it empty and to set the server name on the cluster's plugin entry instead">
            {configuration?.serverName}
          </WithTooltip>
        </DrawerItem>

        <DrawerTitle>Credentials</DrawerTitle>
        <DrawerItem name="Inherited from" hidden={inherited.length === 0}>
          {inherited.join(", ")}
        </DrawerItem>
        <SecretKey label="Access key ID" selector={s3?.accessKeyId} namespace={namespace} />
        <SecretKey label="Secret access key" selector={s3?.secretAccessKey} namespace={namespace} />
        <SecretKey label="Session token" selector={s3?.sessionToken} namespace={namespace} />
        <SecretKey label="Region" selector={s3?.region} namespace={namespace} />
        <SecretKey label="Connection string" selector={azure?.connectionString} namespace={namespace} />
        <SecretKey label="Storage account" selector={azure?.storageAccount} namespace={namespace} />
        <SecretKey label="Storage key" selector={azure?.storageKey} namespace={namespace} />
        <SecretKey label="SAS token" selector={azure?.storageSasToken} namespace={namespace} />
        <SecretKey label="Application credentials" selector={google?.applicationCredentials} namespace={namespace} />

        <DrawerTitle>WAL and data</DrawerTitle>
        <DrawerItem name="WAL compression">{configuration?.wal?.compression ?? "none"}</DrawerItem>
        <DrawerItem name="WAL encryption" hidden={!configuration?.wal?.encryption}>
          {configuration?.wal?.encryption}
        </DrawerItem>
        <DrawerItem name="WAL parallelism" hidden={configuration?.wal?.maxParallel === undefined}>
          {configuration?.wal?.maxParallel}
        </DrawerItem>
        <DrawerItem name="Data compression">{configuration?.data?.compression ?? "none"}</DrawerItem>
        <DrawerItem name="Data encryption" hidden={!configuration?.data?.encryption}>
          {configuration?.data?.encryption}
        </DrawerItem>
        <DrawerItem name="Backup jobs" hidden={configuration?.data?.jobs === undefined}>
          {configuration?.data?.jobs}
        </DrawerItem>
        <DrawerItem name="Tags" hidden={tags.length === 0} labelsOnly>
          {tags.map(([key, value]) => (
            <Badge key={key} label={`${key}=${value}`} />
          ))}
        </DrawerItem>

        <DrawerTitle>Recovery windows</DrawerTitle>
        {windows.length === 0 ? (
          <DrawerItem name="Servers">The plugin reports no server in this store yet</DrawerItem>
        ) : (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.windows}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.server}>Server</TableCell>
              <TableCell className={styles.first}>Recoverable from</TableCell>
              <TableCell className={styles.last}>Last successful</TableCell>
              <TableCell className={styles.last}>Last failed</TableCell>
              <TableCell className={styles.windowState}>State</TableCell>
            </TableHead>
            {windows.map((window) => (
              <TableRow key={window.serverName} nowrap>
                <TableCell className={styles.server}>
                  {window.cluster ? (
                    <StoreLink store={clusterStore} name={window.cluster.name} namespace={namespace} />
                  ) : (
                    <WithTooltip tooltip="No cluster writes under this server name: the backups of a deleted or renamed cluster are still in the bucket">
                      {window.serverName} (no cluster)
                    </WithTooltip>
                  )}
                </TableCell>
                <TableCell className={styles.first}>
                  <Moment date={window.firstRecoverabilityPoint} now={now} />
                </TableCell>
                <TableCell className={styles.last}>
                  <Moment date={window.lastSuccessfulBackup} now={now} />
                </TableCell>
                <TableCell className={styles.last}>
                  <Moment date={window.lastFailedBackup} now={now} />
                </TableCell>
                <TableCell className={styles.windowState}>
                  <Badge small className={WINDOW_CLASS[window.state]} label={window.state} />
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}

        <DrawerTitle>Clusters</DrawerTitle>
        {writers.length === 0 ? (
          <DrawerItem name="Writers">No cluster of this namespace names the store in its plugins</DrawerItem>
        ) : (
          writers.map((writer) => (
            <DrawerItem key={writer.name} name={writer.walArchiver ? "WAL and backups" : "Backups only"}>
              <StoreLink store={clusterStore} name={writer.name} namespace={namespace} />
              {writer.serverName !== writer.name ? (
                <span className={styles.secretKey}> as {writer.serverName}</span>
              ) : null}
              <span className={styles.secretKey}>
                {" "}
                <MaybeLink
                  to={extensionPageUrl(extension.name, BACKUPS_PAGE_ID, writer.name)}
                  onClick={(event) => event.stopPropagation()}
                >
                  its backups
                </MaybeLink>
              </span>
            </DrawerItem>
          ))
        )}
      </>
    );
  }),
);
