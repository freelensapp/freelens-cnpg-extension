/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { ObjectStore as ObjectStoreV1 } from "./api/barmancloud/object-store-v1";
import { Backup as BackupV1 } from "./api/cnpg/backup-v1";
import { Cluster as ClusterV1 } from "./api/cnpg/cluster-v1";
import { DatabaseRole as DatabaseRoleV1 } from "./api/cnpg/database-role-v1";
import { Database as DatabaseV1 } from "./api/cnpg/database-v1";
import { FailoverQuorum as FailoverQuorumV1 } from "./api/cnpg/failover-quorum-v1";
import {
  ClusterImageCatalog as ClusterImageCatalogV1,
  ImageCatalog as ImageCatalogV1,
} from "./api/cnpg/image-catalog-v1";
import { Pooler as PoolerV1 } from "./api/cnpg/pooler-v1";
import { Publication as PublicationV1 } from "./api/cnpg/publication-v1";
import { ScheduledBackup as ScheduledBackupV1 } from "./api/cnpg/scheduled-backup-v1";
import { Subscription as SubscriptionV1 } from "./api/cnpg/subscription-v1";
import { createAvailableVersionPage } from "./components/available-version";
import { BackupDetails as BackupDetailsV1 } from "./details/backup-details-v1";
import { ClusterDetails as ClusterDetailsV1 } from "./details/cluster-details-v1";
import { DatabaseDetails as DatabaseDetailsV1 } from "./details/database-details-v1";
import { DatabaseRoleDetails as DatabaseRoleDetailsV1 } from "./details/database-role-details-v1";
import { FailoverQuorumDetails as FailoverQuorumDetailsV1 } from "./details/failover-quorum-details-v1";
import { ImageCatalogDetails as ImageCatalogDetailsV1 } from "./details/image-catalog-details-v1";
import { ObjectStoreDetails as ObjectStoreDetailsV1 } from "./details/object-store-details-v1";
import { PoolerDetails as PoolerDetailsV1 } from "./details/pooler-details-v1";
import { PublicationDetails as PublicationDetailsV1 } from "./details/publication-details-v1";
import { ScheduledBackupDetails as ScheduledBackupDetailsV1 } from "./details/scheduled-backup-details-v1";
import { SubscriptionDetails as SubscriptionDetailsV1 } from "./details/subscription-details-v1";
import { CnpgIcon } from "./icons";
import { ClusterLiveViewMenuItem } from "./menus/cluster-live-view-menu-item";
import { ClusterLogsMenuItem } from "./menus/cluster-logs-menu-item";
import { ClusterPsqlMenuItem } from "./menus/open-psql";
import {
  BACKUPS_GROUP_ID,
  BACKUPS_PAGE_ID,
  CLUSTER_IMAGE_CATALOGS_PAGE_ID,
  CLUSTERS_GROUP_ID,
  CLUSTERS_PAGE_ID,
  DATABASE_ROLES_PAGE_ID,
  DATABASES_GROUP_ID,
  DATABASES_PAGE_ID,
  FAILOVER_QUORUMS_PAGE_ID,
  IMAGE_CATALOGS_PAGE_ID,
  IMAGES_GROUP_ID,
  LIVE_PAGE_ID,
  LOGS_PAGE_ID,
  OBJECT_STORES_PAGE_ID,
  OVERVIEW_GROUP_ID,
  OVERVIEW_PAGE_ID,
  POOLERS_PAGE_ID,
  POOLING_GROUP_ID,
  PUBLICATIONS_PAGE_ID,
  ROOT_MENU_ID,
  SCHEDULED_BACKUPS_PAGE_ID,
  SUBSCRIPTIONS_PAGE_ID,
} from "./navigation";
import { BackupsPage as BackupsPageV1 } from "./pages/backups-page-v1";
import { ClustersPage as ClustersPageV1 } from "./pages/clusters-page-v1";
import { DatabaseRolesPage as DatabaseRolesPageV1 } from "./pages/database-roles-page-v1";
import { DatabasesPage as DatabasesPageV1 } from "./pages/databases-page-v1";
import { FailoverQuorumsPage as FailoverQuorumsPageV1 } from "./pages/failover-quorums-page-v1";
import {
  ClusterImageCatalogsPage as ClusterImageCatalogsPageV1,
  ImageCatalogsPage as ImageCatalogsPageV1,
} from "./pages/image-catalogs-page-v1";
import { LivePage } from "./pages/live-page";
import { LogsPage } from "./pages/logs-page";
import { ObjectStoresPage as ObjectStoresPageV1 } from "./pages/object-stores-page-v1";
import { OverviewPage } from "./pages/overview-page";
import { PoolersPage as PoolersPageV1 } from "./pages/poolers-page-v1";
import { PublicationsPage as PublicationsPageV1 } from "./pages/publications-page-v1";
import { ScheduledBackupsPage as ScheduledBackupsPageV1 } from "./pages/scheduled-backups-page-v1";
import { SubscriptionsPage as SubscriptionsPageV1 } from "./pages/subscriptions-page-v1";

// Sidebar: one root "CloudNativePG" with an icon, then text-only groups with a
// target on their first leaf (DESIGN.md section 4). The Overview group comes
// first so the root opens it (SPEC-0004 "Placement"); the Clusters group holds
// the PostgreSQL Clusters list (SPEC-0003 "Sidebar"; the title is qualified
// because the host already has a "Cluster" sidebar item). The Backups group
// holds the Backups and the Scheduled Backups lists (SPEC-0005 "Sidebar"); the
// Live View sits in the Clusters group (SPEC-0006 "Placement and addressing").
// The Databases group follows the Clusters group: what is declared inside a
// cluster comes right after the cluster (SPEC-0013 "List").
// The pages probe the CRD store per API version (newest first) and fall back
// to the explanatory panel when the operator is absent (DESIGN.md section 6).
const AvailableOverviewPage = createAvailableVersionPage("PostgreSQL Clusters", [
  { kubeObjectClass: ClusterV1, PageComponent: OverviewPage, version: "v1" },
]);
const AvailableClustersPage = createAvailableVersionPage(ClusterV1.crd.title, [
  { kubeObjectClass: ClusterV1, PageComponent: ClustersPageV1, version: "v1" },
]);
const AvailableLivePage = createAvailableVersionPage("PostgreSQL Clusters", [
  { kubeObjectClass: ClusterV1, PageComponent: LivePage, version: "v1" },
]);
const AvailableLogsPage = createAvailableVersionPage("PostgreSQL Clusters", [
  { kubeObjectClass: ClusterV1, PageComponent: LogsPage, version: "v1" },
]);
const AvailableBackupsPage = createAvailableVersionPage(BackupV1.crd.title, [
  { kubeObjectClass: BackupV1, PageComponent: BackupsPageV1, version: "v1" },
]);
const AvailableScheduledBackupsPage = createAvailableVersionPage(ScheduledBackupV1.crd.title, [
  { kubeObjectClass: ScheduledBackupV1, PageComponent: ScheduledBackupsPageV1, version: "v1" },
]);
const AvailableFailoverQuorumsPage = createAvailableVersionPage(FailoverQuorumV1.crd.title, [
  { kubeObjectClass: FailoverQuorumV1, PageComponent: FailoverQuorumsPageV1, version: "v1" },
]);
const AvailablePoolersPage = createAvailableVersionPage(PoolerV1.crd.title, [
  { kubeObjectClass: PoolerV1, PageComponent: PoolersPageV1, version: "v1" },
]);
const AvailableDatabasesPage = createAvailableVersionPage(DatabaseV1.crd.title, [
  { kubeObjectClass: DatabaseV1, PageComponent: DatabasesPageV1, version: "v1" },
]);
const AvailableDatabaseRolesPage = createAvailableVersionPage(DatabaseRoleV1.crd.title, [
  { kubeObjectClass: DatabaseRoleV1, PageComponent: DatabaseRolesPageV1, version: "v1" },
]);
const AvailablePublicationsPage = createAvailableVersionPage(PublicationV1.crd.title, [
  { kubeObjectClass: PublicationV1, PageComponent: PublicationsPageV1, version: "v1" },
]);
const AvailableSubscriptionsPage = createAvailableVersionPage(SubscriptionV1.crd.title, [
  { kubeObjectClass: SubscriptionV1, PageComponent: SubscriptionsPageV1, version: "v1" },
]);
const AvailableImageCatalogsPage = createAvailableVersionPage(ImageCatalogV1.crd.title, [
  { kubeObjectClass: ImageCatalogV1, PageComponent: ImageCatalogsPageV1, version: "v1" },
]);
const AvailableClusterImageCatalogsPage = createAvailableVersionPage(ClusterImageCatalogV1.crd.title, [
  { kubeObjectClass: ClusterImageCatalogV1, PageComponent: ClusterImageCatalogsPageV1, version: "v1" },
]);
const AvailableObjectStoresPage = createAvailableVersionPage(
  ObjectStoreV1.crd.title,
  [{ kubeObjectClass: ObjectStoreV1, PageComponent: ObjectStoresPageV1, version: "v1" }],
  "Object stores belong to the Barman Cloud plugin of CloudNativePG, which is optional: it is the supported way to back up and archive WAL to object storage.",
);

export default class CnpgRenderer extends Renderer.LensExtension {
  kubeObjectDetailItems = [
    {
      kind: ClusterV1.kind,
      apiVersions: ClusterV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <ClusterDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: BackupV1.kind,
      apiVersions: BackupV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <BackupDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: ScheduledBackupV1.kind,
      apiVersions: ScheduledBackupV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <ScheduledBackupDetailsV1 {...props} extension={this} />
        ),
      },
    },
    ...[ImageCatalogV1, ClusterImageCatalogV1].map((catalog) => ({
      kind: catalog.kind,
      apiVersions: catalog.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <ImageCatalogDetailsV1 {...props} extension={this} />
        ),
      },
    })),
    {
      kind: FailoverQuorumV1.kind,
      apiVersions: FailoverQuorumV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <FailoverQuorumDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: PoolerV1.kind,
      apiVersions: PoolerV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <PoolerDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: DatabaseV1.kind,
      apiVersions: DatabaseV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <DatabaseDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: DatabaseRoleV1.kind,
      apiVersions: DatabaseRoleV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <DatabaseRoleDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: PublicationV1.kind,
      apiVersions: PublicationV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <PublicationDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: SubscriptionV1.kind,
      apiVersions: SubscriptionV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <SubscriptionDetailsV1 {...props} extension={this} />
        ),
      },
    },
    {
      kind: ObjectStoreV1.kind,
      apiVersions: ObjectStoreV1.crd.apiVersions,
      priority: 10,
      components: {
        Details: (props: Renderer.Component.KubeObjectDetailsProps<any>) => (
          <ObjectStoreDetailsV1 {...props} extension={this} />
        ),
      },
    },
  ];

  kubeObjectMenuItems = [
    {
      kind: ClusterV1.kind,
      apiVersions: ClusterV1.crd.apiVersions,
      components: {
        MenuItem: (props: { object: any; toolbar?: boolean }) => (
          <ClusterLiveViewMenuItem {...props} extension={this} />
        ),
      },
    },
    {
      kind: ClusterV1.kind,
      apiVersions: ClusterV1.crd.apiVersions,
      components: {
        MenuItem: (props: { object: any; toolbar?: boolean }) => <ClusterLogsMenuItem {...props} extension={this} />,
      },
    },
    {
      kind: ClusterV1.kind,
      apiVersions: ClusterV1.crd.apiVersions,
      components: {
        MenuItem: (props: { object: any; toolbar?: boolean }) => <ClusterPsqlMenuItem {...props} />,
      },
    },
  ];

  clusterPages = [
    {
      id: OVERVIEW_PAGE_ID,
      components: {
        // The extension instance is what the pages need to build their own
        // URLs and to report errors; the host passes no props of its own.
        Page: () => <AvailableOverviewPage extension={this} />,
      },
    },
    {
      id: CLUSTERS_PAGE_ID,
      components: {
        Page: () => <AvailableClustersPage extension={this} />,
      },
    },
    {
      id: LIVE_PAGE_ID,
      components: {
        Page: () => <AvailableLivePage extension={this} />,
      },
    },
    {
      id: LOGS_PAGE_ID,
      components: {
        Page: () => <AvailableLogsPage extension={this} />,
      },
    },
    {
      id: FAILOVER_QUORUMS_PAGE_ID,
      components: {
        Page: () => <AvailableFailoverQuorumsPage extension={this} />,
      },
    },
    {
      id: BACKUPS_PAGE_ID,
      components: {
        Page: () => <AvailableBackupsPage extension={this} />,
      },
    },
    {
      id: SCHEDULED_BACKUPS_PAGE_ID,
      components: {
        Page: () => <AvailableScheduledBackupsPage extension={this} />,
      },
    },
    {
      id: OBJECT_STORES_PAGE_ID,
      components: {
        Page: () => <AvailableObjectStoresPage extension={this} />,
      },
    },
    {
      id: POOLERS_PAGE_ID,
      components: {
        Page: () => <AvailablePoolersPage extension={this} />,
      },
    },
    {
      id: DATABASES_PAGE_ID,
      components: {
        Page: () => <AvailableDatabasesPage extension={this} />,
      },
    },
    {
      id: DATABASE_ROLES_PAGE_ID,
      components: {
        Page: () => <AvailableDatabaseRolesPage extension={this} />,
      },
    },
    {
      id: PUBLICATIONS_PAGE_ID,
      components: {
        Page: () => <AvailablePublicationsPage extension={this} />,
      },
    },
    {
      id: SUBSCRIPTIONS_PAGE_ID,
      components: {
        Page: () => <AvailableSubscriptionsPage extension={this} />,
      },
    },
    {
      id: IMAGE_CATALOGS_PAGE_ID,
      components: {
        Page: () => <AvailableImageCatalogsPage extension={this} />,
      },
    },
    {
      id: CLUSTER_IMAGE_CATALOGS_PAGE_ID,
      components: {
        Page: () => <AvailableClusterImageCatalogsPage extension={this} />,
      },
    },
  ];

  clusterPageMenus = [
    {
      id: ROOT_MENU_ID,
      title: "CloudNativePG",
      target: { pageId: OVERVIEW_PAGE_ID },
      components: {
        Icon: CnpgIcon,
      },
    },
    {
      id: OVERVIEW_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Overview",
      target: { pageId: OVERVIEW_PAGE_ID },
      components: {},
    },
    {
      id: CLUSTERS_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Clusters",
      target: { pageId: CLUSTERS_PAGE_ID },
      components: {},
    },
    {
      id: CLUSTERS_PAGE_ID,
      parentId: CLUSTERS_GROUP_ID,
      title: ClusterV1.crd.title,
      target: { pageId: CLUSTERS_PAGE_ID },
      components: {},
    },
    {
      id: LIVE_PAGE_ID,
      parentId: CLUSTERS_GROUP_ID,
      title: "Live View",
      target: { pageId: LIVE_PAGE_ID },
      components: {},
    },
    {
      id: LOGS_PAGE_ID,
      parentId: CLUSTERS_GROUP_ID,
      title: "Logs",
      target: { pageId: LOGS_PAGE_ID },
      components: {},
    },
    {
      id: FAILOVER_QUORUMS_PAGE_ID,
      parentId: CLUSTERS_GROUP_ID,
      title: FailoverQuorumV1.crd.title,
      target: { pageId: FAILOVER_QUORUMS_PAGE_ID },
      components: {},
    },
    {
      id: DATABASES_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Databases",
      target: { pageId: DATABASES_PAGE_ID },
      components: {},
    },
    {
      id: DATABASES_PAGE_ID,
      parentId: DATABASES_GROUP_ID,
      title: DatabaseV1.crd.title,
      target: { pageId: DATABASES_PAGE_ID },
      components: {},
    },
    {
      id: DATABASE_ROLES_PAGE_ID,
      parentId: DATABASES_GROUP_ID,
      title: DatabaseRoleV1.crd.title,
      target: { pageId: DATABASE_ROLES_PAGE_ID },
      components: {},
    },
    {
      id: PUBLICATIONS_PAGE_ID,
      parentId: DATABASES_GROUP_ID,
      title: PublicationV1.crd.title,
      target: { pageId: PUBLICATIONS_PAGE_ID },
      components: {},
    },
    {
      id: SUBSCRIPTIONS_PAGE_ID,
      parentId: DATABASES_GROUP_ID,
      title: SubscriptionV1.crd.title,
      target: { pageId: SUBSCRIPTIONS_PAGE_ID },
      components: {},
    },
    {
      id: BACKUPS_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Backups",
      target: { pageId: BACKUPS_PAGE_ID },
      components: {},
    },
    {
      id: BACKUPS_PAGE_ID,
      parentId: BACKUPS_GROUP_ID,
      title: BackupV1.crd.title,
      target: { pageId: BACKUPS_PAGE_ID },
      components: {},
    },
    {
      id: SCHEDULED_BACKUPS_PAGE_ID,
      parentId: BACKUPS_GROUP_ID,
      title: ScheduledBackupV1.crd.title,
      target: { pageId: SCHEDULED_BACKUPS_PAGE_ID },
      components: {},
    },
    {
      id: OBJECT_STORES_PAGE_ID,
      parentId: BACKUPS_GROUP_ID,
      title: ObjectStoreV1.crd.title,
      target: { pageId: OBJECT_STORES_PAGE_ID },
      components: {},
    },
    {
      id: POOLING_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Pooling",
      target: { pageId: POOLERS_PAGE_ID },
      components: {},
    },
    {
      id: POOLERS_PAGE_ID,
      parentId: POOLING_GROUP_ID,
      title: PoolerV1.crd.title,
      target: { pageId: POOLERS_PAGE_ID },
      components: {},
    },
    {
      id: IMAGES_GROUP_ID,
      parentId: ROOT_MENU_ID,
      title: "Images",
      target: { pageId: IMAGE_CATALOGS_PAGE_ID },
      components: {},
    },
    {
      id: IMAGE_CATALOGS_PAGE_ID,
      parentId: IMAGES_GROUP_ID,
      title: ImageCatalogV1.crd.title,
      target: { pageId: IMAGE_CATALOGS_PAGE_ID },
      components: {},
    },
    {
      id: CLUSTER_IMAGE_CATALOGS_PAGE_ID,
      parentId: IMAGES_GROUP_ID,
      title: ClusterImageCatalogV1.crd.title,
      target: { pageId: CLUSTER_IMAGE_CATALOGS_PAGE_ID },
      components: {},
    },
  ];
}
