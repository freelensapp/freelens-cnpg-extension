/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Logs" in the menu of a PostgreSQL cluster (SPEC-0018). Navigation, not an
// action: it opens the Logs page with the cluster in the URL and issues no API
// call. One registration renders in the row menu of the list and in the
// toolbar of the drawer.

import { Renderer } from "@freelensapp/extensions";
import { Cluster } from "../api/cnpg/cluster-v1";
import { logsUrl } from "../navigation";

const {
  Component: { Icon, MenuItem },
  Navigation: { hideDetails, navigate },
} = Renderer;

export interface ClusterLogsMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function ClusterLogsMenuItem({ object, toolbar, extension }: ClusterLogsMenuItemProps) {
  // The host hands the menu a plain copy of the object (AGENTS.md): guard on the kind.
  if (!object || object.kind !== Cluster.kind) return null;

  const open = () => {
    hideDetails();
    navigate(logsUrl(extension.name, object.metadata?.namespace, object.metadata?.name));
  };

  return (
    <MenuItem onClick={open} data-testid="cnpg-cluster-logs-menu-item">
      <Icon material="subject" interactive={toolbar} tooltip="Logs" />
      <span className="title">Logs</span>
    </MenuItem>
  );
}
