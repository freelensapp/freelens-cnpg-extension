/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// "Timeline" in the menu of a PostgreSQL cluster (SPEC-0017). Navigation, not
// an action: it opens the Timeline page with the cluster in the URL and issues
// no API call.

import { Renderer } from "@freelensapp/extensions";
import { Cluster } from "../api/cnpg/cluster-v1";
import { timelineUrl } from "../navigation";

const {
  Component: { Icon, MenuItem },
  Navigation: { hideDetails, navigate },
} = Renderer;

export interface ClusterTimelineMenuItemProps {
  object: Cluster;
  toolbar?: boolean;
  extension: Renderer.LensExtension;
}

export function ClusterTimelineMenuItem({ object, toolbar, extension }: ClusterTimelineMenuItemProps) {
  // The host hands the menu a plain copy of the object (AGENTS.md): guard on the kind.
  if (!object || object.kind !== Cluster.kind) return null;

  const open = () => {
    hideDetails();
    navigate(timelineUrl(extension.name, object.metadata?.namespace, object.metadata?.name));
  };

  return (
    <MenuItem onClick={open} data-testid="cnpg-cluster-timeline-menu-item">
      <Icon material="history" interactive={toolbar} tooltip="Timeline" />
      <span className="title">Timeline</span>
    </MenuItem>
  );
}
