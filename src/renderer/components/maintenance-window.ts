/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The maintenance window of a cluster's nodes (SPEC-0037):
// `spec.nodeMaintenanceWindow` `{ inProgress, reusePVC }`, as `kubectl cnpg
// maintenance set|unset` merge-patches it. What the operator does with each
// choice is the upstream documentation of v1.30 ("Kubernetes upgrade and
// maintenance"). Pure.

import { disabledGuard, enabledGuard, subjectOf } from "./write-actions";

import type { ActionDialogFacts, ActionGuard } from "./write-actions";

export interface MaintenanceClusterFacts {
  name: string;
  namespace: string;
  instances: number;
  window?: { inProgress?: boolean; reusePVC?: boolean };
}

export interface MaintenanceWindowState {
  open: boolean;
  /** On when unset (the API's default). */
  reusePVC: boolean;
}

export function maintenanceWindowState(cluster: MaintenanceClusterFacts): MaintenanceWindowState {
  return { open: cluster.window?.inProgress === true, reusePVC: cluster.window?.reusePVC !== false };
}

export function maintenanceWindowWords(state: MaintenanceWindowState): string {
  if (!state.open) return "Closed";
  return state.reusePVC
    ? "Open, volumes reused: an instance on a drained node waits for the node to come back"
    : "Open, volumes not reused: an instance on a drained node is recreated elsewhere";
}

export function canOpenMaintenanceWindow(cluster: MaintenanceClusterFacts): ActionGuard {
  return maintenanceWindowState(cluster).open ? disabledGuard("The maintenance window is open already") : enabledGuard;
}

export function canCloseMaintenanceWindow(cluster: MaintenanceClusterFacts): ActionGuard {
  return maintenanceWindowState(cluster).open ? enabledGuard : disabledGuard("The maintenance window is not open");
}

export function openMaintenancePatch(reusePVC: boolean): {
  spec: { nodeMaintenanceWindow: { inProgress: true; reusePVC: boolean } };
} {
  return { spec: { nodeMaintenanceWindow: { inProgress: true, reusePVC } } };
}

/** Closing keeps the choice about the volumes as it is: only the window closes. */
export function closeMaintenancePatch(): { spec: { nodeMaintenanceWindow: { inProgress: false } } } {
  return { spec: { nodeMaintenanceWindow: { inProgress: false } } };
}

const LIMITED =
  "While the window is open, self-healing, rolling updates and the PodDisruptionBudgets of the cluster are disabled or limited: close it as soon as the maintenance of the nodes is over.";

export function openMaintenanceFacts(cluster: MaintenanceClusterFacts, reusePVC: boolean): ActionDialogFacts {
  const before = maintenanceWindowState(cluster);
  const notes = reusePVC
    ? [
        "An instance on a drained node is not moved: Kubernetes waits for the node to come back, and the instance starts again on its own volumes.",
        "The operator removes the PodDisruptionBudgets of the cluster for the time of the window, so a drain is not held back by them.",
      ]
    : [
        "An instance on a drained node is recreated on another node, on a new volume, as a copy of the primary through streaming replication; its old volume is deleted with its pod.",
      ];
  const warnings: string[] = [];
  if (!reusePVC && cluster.instances <= 1) {
    warnings.push(
      "One instance and the volumes not reused: the operator still keeps its node from being drained, since the only copy of the data would be lost. Reuse the volumes and accept the downtime, or add an instance on another node and switch over first.",
    );
  } else if (!reusePVC) {
    warnings.push("Each recreated instance copies the whole database from the primary: it takes as long as that copy.");
  } else if (cluster.instances <= 1) {
    warnings.push("One instance: the database is down while its node is.");
  }
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: spec.nodeMaintenanceWindow inProgress ${before.open} -> true, reusePVC ${before.reusePVC} -> ${reusePVC}`,
      },
    ],
    notes: [
      ...notes,
      LIMITED,
      "The upstream documentation keeps the window for compatibility and recommends managing the PodDisruptionBudgets with spec.enablePDB instead.",
    ],
    warnings,
  };
}

export function closeMaintenanceFacts(cluster: MaintenanceClusterFacts): ActionDialogFacts {
  const before = maintenanceWindowState(cluster);
  return {
    subject: subjectOf("Cluster", cluster.namespace, cluster.name),
    writes: [
      {
        verb: "patch",
        text: `patch Cluster ${cluster.namespace}/${cluster.name}: spec.nodeMaintenanceWindow inProgress ${before.open} -> false (reusePVC stays ${before.reusePVC})`,
      },
    ],
    notes: ["Self-healing, rolling updates and the PodDisruptionBudgets of the cluster come back as usual."],
    warnings: [],
  };
}
