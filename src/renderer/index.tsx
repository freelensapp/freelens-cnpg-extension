/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { Cluster as ClusterV1 } from "./api/cnpg/cluster-v1";
import { createAvailableVersionPage } from "./components/available-version";
import { ClusterDetails as ClusterDetailsV1 } from "./details/cluster-details-v1";
import { CnpgIcon } from "./icons";
import { CLUSTERS_GROUP_ID, CLUSTERS_PAGE_ID, OVERVIEW_GROUP_ID, OVERVIEW_PAGE_ID, ROOT_MENU_ID } from "./navigation";
import { ClustersPage as ClustersPageV1 } from "./pages/clusters-page-v1";
import { OverviewPage } from "./pages/overview-page";

// Sidebar: one root "CloudNativePG" with an icon, then text-only groups with a
// target on their first leaf (DESIGN.md section 4). The Overview group comes
// first so the root opens it (SPEC-0004 "Placement"); the Clusters group holds
// the PostgreSQL Clusters list (SPEC-0003 "Sidebar"; the title is qualified
// because the host already has a "Cluster" sidebar item).
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
  ];

  clusterPages = [
    {
      id: OVERVIEW_PAGE_ID,
      components: {
        Page: createAvailableVersionPage("PostgreSQL Clusters", [
          { kubeObjectClass: ClusterV1, PageComponent: OverviewPage, version: "v1" },
        ]),
      },
    },
    {
      id: CLUSTERS_PAGE_ID,
      components: {
        Page: createAvailableVersionPage(ClusterV1.crd.title, [
          { kubeObjectClass: ClusterV1, PageComponent: ClustersPageV1, version: "v1" },
        ]),
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
  ];
}
