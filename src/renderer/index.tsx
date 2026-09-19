/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { Backup as BackupV1 } from "./api/cnpg/backup-v1";
import { Cluster as ClusterV1 } from "./api/cnpg/cluster-v1";
import { ScheduledBackup as ScheduledBackupV1 } from "./api/cnpg/scheduled-backup-v1";
import { createAvailableVersionPage } from "./components/available-version";
import { BackupDetails as BackupDetailsV1 } from "./details/backup-details-v1";
import { ClusterDetails as ClusterDetailsV1 } from "./details/cluster-details-v1";
import { ScheduledBackupDetails as ScheduledBackupDetailsV1 } from "./details/scheduled-backup-details-v1";
import { CnpgIcon } from "./icons";
import { ClusterLiveViewMenuItem } from "./menus/cluster-live-view-menu-item";
import { ClusterPsqlMenuItem } from "./menus/open-psql";
import {
  BACKUPS_GROUP_ID,
  BACKUPS_PAGE_ID,
  CLUSTERS_GROUP_ID,
  CLUSTERS_PAGE_ID,
  LIVE_PAGE_ID,
  OVERVIEW_GROUP_ID,
  OVERVIEW_PAGE_ID,
  ROOT_MENU_ID,
  SCHEDULED_BACKUPS_PAGE_ID,
} from "./navigation";
import { BackupsPage as BackupsPageV1 } from "./pages/backups-page-v1";
import { ClustersPage as ClustersPageV1 } from "./pages/clusters-page-v1";
import { LivePage } from "./pages/live-page";
import { OverviewPage } from "./pages/overview-page";
import { ScheduledBackupsPage as ScheduledBackupsPageV1 } from "./pages/scheduled-backups-page-v1";

// Sidebar: one root "CloudNativePG" with an icon, then text-only groups with a
// target on their first leaf (DESIGN.md section 4). The Overview group comes
// first so the root opens it (SPEC-0004 "Placement"); the Clusters group holds
// the PostgreSQL Clusters list (SPEC-0003 "Sidebar"; the title is qualified
// because the host already has a "Cluster" sidebar item). The Backups group
// holds the Backups and the Scheduled Backups lists (SPEC-0005 "Sidebar"); the
// Live View sits in the Clusters group (SPEC-0006 "Placement and addressing").
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
const AvailableBackupsPage = createAvailableVersionPage(BackupV1.crd.title, [
  { kubeObjectClass: BackupV1, PageComponent: BackupsPageV1, version: "v1" },
]);
const AvailableScheduledBackupsPage = createAvailableVersionPage(ScheduledBackupV1.crd.title, [
  { kubeObjectClass: ScheduledBackupV1, PageComponent: ScheduledBackupsPageV1, version: "v1" },
]);

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
  ];
}
