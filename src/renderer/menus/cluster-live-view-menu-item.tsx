/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Live view" in the menu of a PostgreSQL cluster (SPEC-0006 "Placement and
// addressing"). It is navigation, not an action: it opens the Live View with
// the cluster in the URL and issues no API call, so it asks for no
// confirmation. One registration renders in the row menu of the list and in
// the toolbar of the drawer, where the host hides the title and keeps the icon.

import { Renderer } from "@freelensapp/extensions";
import { Cluster } from "../api/cnpg/cluster-v1";
import { liveViewUrl } from "../navigation";

const {
  Component: { Icon, MenuItem },
  Navigation: { hideDetails, navigate },
} = Renderer;

export interface ClusterLiveViewMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function ClusterLiveViewMenuItem({ object, toolbar, extension }: ClusterLiveViewMenuItemProps) {
  // The host hands the menu a plain copy of the object (AGENTS.md): guard on the kind.
  if (!object || object.kind !== Cluster.kind) return null;

  const open = () => {
    hideDetails();
    navigate(liveViewUrl(extension.name, object.metadata?.namespace, object.metadata?.name));
  };

  return (
    <MenuItem onClick={open} data-testid="cnpg-cluster-live-view-menu-item">
      <Icon material="timeline" interactive={toolbar} tooltip="Live view" />
      <span className="title">Live view</span>
    </MenuItem>
  );
}
