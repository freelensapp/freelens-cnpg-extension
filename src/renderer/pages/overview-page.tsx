/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Overview page (SPEC-0004): the summary strip and the cluster tiles over
// the pure `overview-model`, from the stores only, inside the host's TabLayout.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { DatabaseRole } from "../api/cnpg/database-role-v1";
import { Database } from "../api/cnpg/database-v1";
import { Publication } from "../api/cnpg/publication-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { Subscription } from "../api/cnpg/subscription-v1";
import { DECLARED_KINDS } from "../components/declarative-summary";
import { withErrorPage } from "../components/error-page";
import { ClusterTile } from "../components/overview/cluster-tile";
import { HealthPie, StatTile } from "../components/overview/stat-tile";
import styles from "../components/overview/tile-grid.module.scss";
import stylesInline from "../components/overview/tile-grid.module.scss?inline";
import { summarize } from "../components/overview-model";
import { useReferenceStores } from "../components/reference-loader";
import {
  BACKUPS_PAGE_ID,
  CLUSTERS_PAGE_ID,
  DATABASE_ROLES_PAGE_ID,
  DATABASES_PAGE_ID,
  extensionPageUrl,
  liveViewUrl,
  PUBLICATIONS_PAGE_ID,
  SUBSCRIPTIONS_PAGE_ID,
} from "../navigation";

import type { DeclaredKind } from "../components/declarative-summary";
import type { ClusterTile as ClusterTileModel } from "../components/overview-model";

const { observer } = MobxReact;

const {
  Component: { NamespaceSelectFilter, TabLayout },
  Navigation: { getDetailsUrl },
} = Renderer;

export interface OverviewPageProps {
  extension: Renderer.LensExtension;
}

export const OverviewPage = observer((props: OverviewPageProps) =>
  withErrorPage(props, () => {
    const { extension } = props;
    const clusterStore = Cluster.getStore<Cluster>();
    const backupStore = maybe(() => Backup.getStore<Backup>());
    const scheduleStore = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
    // Optional: the Barman Cloud plugin may not be installed.
    const objectStoreStore = maybe(() => ObjectStore.getStore<ObjectStore>());
    // What is declared inside the clusters (SPEC-0013): a failed one needs a human.
    const databaseStore = maybe(() => Database.getStore<Database>());
    const roleStore = maybe(() => DatabaseRole.getStore<DatabaseRole>());
    const publicationStore = maybe(() => Publication.getStore<Publication>());
    const subscriptionStore = maybe(() => Subscription.getStore<Subscription>());

    // The three stores follow the namespace filter like every page; the loader
    // keeps them filled and watched while the Overview is open.
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: Backup.crd.plural, store: backupStore },
      { label: ScheduledBackup.crd.plural, store: scheduleStore },
      { label: ObjectStore.crd.plural, store: objectStoreStore },
      { label: Database.crd.plural, store: databaseStore },
      { label: DatabaseRole.crd.plural, store: roleStore },
      { label: Publication.crd.plural, store: publicationStore },
      { label: Subscription.crd.plural, store: subscriptionStore },
    ]);

    const loading = !clusterStore.isLoaded && !clusterStore.failedLoading;
    const summary = summarize(
      clusterStore.contextItems as Cluster[],
      (backupStore?.contextItems ?? []) as Backup[],
      (scheduleStore?.contextItems ?? []) as ScheduledBackup[],
      new Date(),
      (objectStoreStore?.contextItems ?? []) as ObjectStore[],
      {
        databases: databaseStore?.contextItems,
        roles: roleStore?.contextItems,
        publications: publicationStore?.contextItems,
        subscriptions: subscriptionStore?.contextItems,
      },
    );
    // The door of the declared objects tile: the list of the first kind that has a failure.
    const declaredPages: Record<DeclaredKind, string> = {
      Databases: DATABASES_PAGE_ID,
      "Database roles": DATABASE_ROLES_PAGE_ID,
      Publications: PUBLICATIONS_PAGE_ID,
      Subscriptions: SUBSCRIPTIONS_PAGE_ID,
    };
    const failingKind = DECLARED_KINDS.find((kind) => summary.declaredFailedByKind[kind] > 0) ?? "Databases";

    const listUrl = (search?: string) => extensionPageUrl(extension.name, CLUSTERS_PAGE_ID, search);
    // The tile links to the host's own details URL of the cluster, the same
    // mechanism the LinkTo components use, so the drawer opens from any page.
    const detailsUrlOf = (tile: ClusterTileModel): string | undefined => {
      const cluster = clusterStore.getByName(tile.name, tile.namespace);
      return cluster ? getDetailsUrl(cluster.selfLink) : undefined;
    };

    // The doors of SPEC-0005: the backups of a cluster and the schedule behind
    // its next backup line.
    const backupsUrl = (search?: string) => extensionPageUrl(extension.name, BACKUPS_PAGE_ID, search);
    const scheduleUrlOf = (tile: ClusterTileModel): string | undefined => {
      const schedule = tile.nextScheduleName
        ? scheduleStore?.getByName(tile.nextScheduleName, tile.namespace)
        : undefined;
      return schedule ? getDetailsUrl(schedule.selfLink) : undefined;
    };

    return (
      <TabLayout scrollable>
        <style>{stylesInline}</style>
        <div className={styles.overview} data-testid="cnpg-overview">
          <div className={styles.header}>
            <h5 className={styles.title}>Overview</h5>
            {/* The host's own namespace filter, the one of every list: the page follows it, so it is here to move it. */}
            <div className={styles.namespaces} data-testid="cnpg-overview-namespaces">
              <NamespaceSelectFilter id="cnpg-overview-namespace-filter" />
            </div>
          </div>
          {loading ? (
            <div className={styles.strip} data-testid="cnpg-overview-skeleton">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <span key={index} className={styles.skeletonTile} />
              ))}
            </div>
          ) : (
            <div className={styles.strip} data-testid="cnpg-overview-strip">
              <StatTile
                label="Clusters"
                value={summary.clusters}
                tooltip={Object.entries(summary.byState)
                  .filter(([, count]) => count > 0)
                  .map(([state, count]) => `${state}: ${count}`)
                  .join(", ")}
                to={listUrl()}
                data-testid="cnpg-stat-clusters"
              >
                <HealthPie byState={summary.byState} />
              </StatTile>
              <StatTile
                label="Instances ready"
                value={`${summary.instancesReady}/${summary.instancesTotal}`}
                className={summary.instancesReady < summary.instancesTotal ? "warning" : ""}
                tooltip="Ready instances over declared instances, all clusters"
                to={listUrl("Degraded")}
                data-testid="cnpg-stat-instances"
              />
              <StatTile
                label="Archiving failing"
                value={summary.archivingFailing}
                className={summary.archivingFailing > 0 ? "error" : ""}
                tooltip="Clusters whose ContinuousArchiving condition is False"
                to={listUrl("Failing")}
                data-testid="cnpg-stat-archiving"
              />
              <StatTile
                label="Backups overdue"
                value={summary.backupsOverdue}
                className={summary.backupsOverdue > 0 ? "warning" : ""}
                tooltip="Clusters without a successful backup in the last 24 hours, hibernated ones excluded"
                to={backupsUrl()}
                data-testid="cnpg-stat-backups"
              />
              <StatTile
                label="Certificates expiring"
                value={summary.certificatesExpiring}
                className={summary.certificatesExpiring > 0 ? "warning" : ""}
                tooltip="Clusters with a certificate expiring within 30 days or already expired"
                to={listUrl()}
                data-testid="cnpg-stat-certificates"
              />
              <StatTile
                label="Declared objects failed"
                value={summary.declaredFailed}
                className={summary.declaredFailed > 0 ? "error" : ""}
                tooltip={
                  summary.declaredFailed > 0
                    ? DECLARED_KINDS.filter((kind) => summary.declaredFailedByKind[kind] > 0)
                        .map((kind) => `${kind}: ${summary.declaredFailedByKind[kind]}`)
                        .join(", ")
                    : "Databases, roles, publications and subscriptions PostgreSQL does not have as declared"
                }
                to={extensionPageUrl(
                  extension.name,
                  declaredPages[failingKind],
                  summary.declaredFailed > 0 ? "Failed" : undefined,
                )}
                data-testid="cnpg-stat-declared"
              />
            </div>
          )}
          {loading ? (
            <div className={styles.grid}>
              {[0, 1, 2].map((index) => (
                <span key={index} className={styles.skeletonCard} />
              ))}
            </div>
          ) : summary.tiles.length === 0 ? (
            <div className={styles.empty} data-testid="cnpg-overview-empty">
              <p>No PostgreSQL cluster in the selected namespaces.</p>
              <p>
                This page follows the namespace filter of Freelens, the one at the top of every list: on a first
                connection to a Kubernetes cluster it selects only the namespace <code>default</code>. Pick the
                namespaces of your clusters in the selector above, or create a cluster with the CloudNativePG operator,
                see{" "}
                <a href="https://cloudnative-pg.io/documentation/current/quickstart/" target="_blank" rel="noreferrer">
                  the quickstart
                </a>
                .
              </p>
            </div>
          ) : (
            <div className={styles.grid} data-testid="cnpg-overview-grid">
              {summary.tiles.map((tile) => (
                <ClusterTile
                  key={tile.id}
                  tile={tile}
                  detailsUrl={detailsUrlOf(tile)}
                  backupsUrl={backupsUrl(tile.name)}
                  scheduleUrl={scheduleUrlOf(tile)}
                  liveUrl={
                    tile.health.state === "Hibernated"
                      ? undefined
                      : liveViewUrl(extension.name, tile.namespace, tile.name)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </TabLayout>
    );
  }),
);
