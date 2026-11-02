/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canCloseMaintenanceWindow,
  canOpenMaintenanceWindow,
  closeMaintenanceFacts,
  closeMaintenancePatch,
  maintenanceWindowState,
  maintenanceWindowWords,
  openMaintenanceFacts,
  openMaintenancePatch,
} from "./maintenance-window";

const CLUSTER = { name: "e2e-actions", namespace: "cnpg-e2e-actions", instances: 2 };

describe("the maintenance window of a cluster (SPEC-0037)", () => {
  it("reads closed when unset, and reuses the volumes unless told not to", () => {
    expect(maintenanceWindowState(CLUSTER)).toEqual({ open: false, reusePVC: true });
    expect(maintenanceWindowState({ ...CLUSTER, window: { inProgress: true, reusePVC: false } })).toEqual({
      open: true,
      reusePVC: false,
    });
    expect(maintenanceWindowWords({ open: false, reusePVC: true })).toBe("Closed");
    expect(maintenanceWindowWords({ open: true, reusePVC: true })).toContain("waits for the node to come back");
  });

  it("guards opening an open window and closing a closed one", () => {
    expect(canOpenMaintenanceWindow(CLUSTER).enabled).toBe(true);
    expect(canCloseMaintenanceWindow(CLUSTER)).toEqual({
      enabled: false,
      reason: "The maintenance window is not open",
    });
    const open = { ...CLUSTER, window: { inProgress: true } };
    expect(canOpenMaintenanceWindow(open)).toEqual({
      enabled: false,
      reason: "The maintenance window is open already",
    });
    expect(canCloseMaintenanceWindow(open).enabled).toBe(true);
  });

  it("patches both settings to open, and only inProgress to close", () => {
    expect(openMaintenancePatch(true)).toEqual({
      spec: { nodeMaintenanceWindow: { inProgress: true, reusePVC: true } },
    });
    expect(closeMaintenancePatch()).toEqual({ spec: { nodeMaintenanceWindow: { inProgress: false } } });
    expect(openMaintenanceFacts(CLUSTER, false).writes[0].text).toBe(
      "patch Cluster cnpg-e2e-actions/e2e-actions: spec.nodeMaintenanceWindow inProgress false -> true, reusePVC true -> false",
    );
    expect(closeMaintenanceFacts({ ...CLUSTER, window: { inProgress: true, reusePVC: false } }).writes[0].text).toBe(
      "patch Cluster cnpg-e2e-actions/e2e-actions: spec.nodeMaintenanceWindow inProgress true -> false (reusePVC stays false)",
    );
  });

  it("states what the operator does for the choice made, and what it costs", () => {
    expect(openMaintenanceFacts(CLUSTER, true).notes[0]).toContain("waits for the node to come back");
    expect(openMaintenanceFacts(CLUSTER, false).notes[0]).toContain("recreated on another node, on a new volume");
    expect(openMaintenanceFacts(CLUSTER, false).warnings[0]).toContain("copies the whole database");
    expect(openMaintenanceFacts({ ...CLUSTER, instances: 1 }, false).warnings[0]).toContain(
      "keeps its node from being drained",
    );
    expect(openMaintenanceFacts({ ...CLUSTER, instances: 1 }, true).warnings).toEqual([
      "One instance: the database is down while its node is.",
    ]);
  });
});
