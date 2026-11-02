/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "PostgreSQL configuration" in the menu of a PostgreSQL cluster (SPEC-0035).
// Navigation, not an action: it opens the configuration page with the cluster
// in the URL and issues no API call.

import { Renderer } from "@freelensapp/extensions";
import { Cluster } from "../api/cnpg/cluster-v1";
import { configUrl } from "../navigation";

const {
  Component: { Icon, MenuItem },
  Navigation: { hideDetails, navigate },
} = Renderer;

export interface ClusterConfigMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function ClusterConfigMenuItem({ object, toolbar, extension }: ClusterConfigMenuItemProps) {
  // The host hands the menu a plain copy of the object (AGENTS.md): guard on the kind.
  if (!object || object.kind !== Cluster.kind) return null;

  const open = () => {
    hideDetails();
    navigate(configUrl(extension.name, object.metadata?.namespace, object.metadata?.name));
  };

  return (
    <MenuItem onClick={open} data-testid="cnpg-cluster-config-menu-item">
      <Icon material="tune" interactive={toolbar} tooltip="PostgreSQL configuration" />
      <span className="title">PostgreSQL configuration</span>
    </MenuItem>
  );
}
