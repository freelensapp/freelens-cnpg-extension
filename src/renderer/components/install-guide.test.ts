/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  BARMAN_CLOUD_PLUGIN,
  backupPluginWords,
  capabilityWords,
  guideComplete,
  guideSteps,
  KLIO_PLUGIN,
  olderThan,
  pluginTitle,
  pluginUse,
  REVIEWED,
} from "./install-guide";

import type { ClusterComponents, ComponentProbe } from "./install-guide";

const absent: ComponentProbe = { crd: "absent" };

/** As the kind cluster runs them (operator 1.30.1, cert-manager v1.21.2, Barman Cloud v0.15.1). */
const LAB: ClusterComponents = {
  operator: { crd: "present", version: "1.30.1", namespace: "cnpg-system" },
  certManager: { crd: "present", version: "v1.21.2", namespace: "cert-manager" },
  barmanCloud: { crd: "present", version: "v0.15.1", namespace: "cnpg-system" },
  klio: absent,
};

const BARE: ClusterComponents = { operator: absent, certManager: absent, barmanCloud: absent, klio: absent };

describe("the installation guide (SPEC-0036)", () => {
  it("pins the releases of the lab, the single place where versions live", () => {
    const lib = readFileSync(path.resolve(import.meta.dirname, "../../../e2e/scripts/lib.sh"), "utf8");
    const pin = (name: string) => new RegExp(`^${name}="\\$\\{${name}:-([^}"]+)\\}"`, "m").exec(lib)?.[1];
    expect(REVIEWED).toEqual({
      cnpg: pin("CNPG_VERSION"),
      certManager: pin("CERT_MANAGER_VERSION"),
      barmanCloud: pin("BARMAN_PLUGIN_VERSION"),
    });
  });

  it("is complete on the lab, each step with its version", () => {
    const steps = guideSteps(LAB);
    expect(steps.map((step) => [step.id, step.state, step.words])).toEqual([
      ["operator", "installed", "CloudNativePG 1.30.1 is installed in cnpg-system"],
      ["cert-manager", "installed", "cert-manager v1.21.2 is installed in cert-manager"],
      ["barman-cloud", "installed", "The Barman Cloud plugin v0.15.1 is installed in cnpg-system"],
    ]);
    expect(guideComplete(steps)).toBe(true);
    expect(steps.every((step) => step.older === undefined)).toBe(true);
  });

  it("gives the three steps as missing on a cluster without CloudNativePG, with the commands of the pinned releases", () => {
    const steps = guideSteps(BARE);
    expect(steps.map((step) => step.state)).toEqual(["missing", "missing", "missing"]);
    expect(guideComplete(steps)).toBe(false);
    expect(steps[0].commands[0].text).toBe(
      `kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v${REVIEWED.cnpg}/releases/cnpg-${REVIEWED.cnpg}.yaml`,
    );
    expect(steps[0].commands[1].text).toContain("helm upgrade --install cnpg");
    expect(steps[1].commands[0].text).toContain(
      `/cert-manager/releases/download/${REVIEWED.certManager}/cert-manager.yaml`,
    );
    expect(steps[2].commands[0].text).toContain(
      `/plugin-barman-cloud/releases/download/${REVIEWED.barmanCloud}/manifest.yaml`,
    );
    // The plugin's manifest asks cert-manager for its certificates: the order is said.
    expect(steps[2].after).toContain("after the operator and cert-manager");
    expect(steps[0].chart).toMatchObject({ repository: "cnpg", name: "cloudnative-pg" });
  });

  it("does not ask for Barman Cloud and cert-manager where Klio backs the clusters up", () => {
    const steps = guideSteps({ ...BARE, operator: LAB.operator, klio: { crd: "present", version: "v0.3.0" } });
    expect(steps.map((step) => step.state)).toEqual(["installed", "not needed", "not needed"]);
    expect(steps[2].words).toBe("Not needed: Klio is installed and backs the clusters up");
    expect(guideComplete(steps)).toBe(true);
  });

  it("says an operator is there when only its kinds are visible, and what it cannot see", () => {
    const [operator] = guideSteps({ ...LAB, operator: { crd: "present" } });
    expect(operator).toMatchObject({
      state: "installed",
      words: "Its kinds are installed; the operator's deployment is not visible with your permissions",
    });
    const [unknown] = guideSteps({ ...LAB, operator: { crd: "unknown" } });
    expect(unknown.state).toBe("unknown");
  });

  it("warns about an older release than the reviewed one", () => {
    const [operator, , barman] = guideSteps({
      ...LAB,
      operator: { crd: "present", version: "1.29.3" },
      barmanCloud: { crd: "present", version: "v0.14.0" },
    });
    expect(operator.older).toBe(
      `This extension was reviewed with ${REVIEWED.cnpg}: some views may miss what the newer release reports`,
    );
    expect(barman.older).toBeDefined();
    expect(olderThan("1.30.1", "1.30.10")).toBe(true);
    expect(olderThan("v0.15.1", "v0.15.1")).toBe(false);
    expect(olderThan("1.31.0", "1.30.1")).toBe(false);
    expect(olderThan("main", "1.30.1")).toBeUndefined();
  });
});

describe("the plugins (SPEC-0036)", () => {
  it("names the known plugins and says what each capability does", () => {
    expect(pluginTitle(BARMAN_CLOUD_PLUGIN)).toBe("Barman Cloud");
    expect(pluginTitle(KLIO_PLUGIN)).toBe("Klio");
    expect(pluginTitle("example.io")).toBe("example.io");
    // The three the Barman Cloud plugin v0.15.1 declares on the kind cluster.
    expect(
      ["TYPE_RECONCILER_HOOKS", "TYPE_LIFECYCLE_SERVICE", "TYPE_INSTANCE_SIDECAR_INJECTION"].map(capabilityWords),
    ).toEqual([
      "reconciler hooks: acts before and after the operator reconciles a cluster",
      "lifecycle: changes the pods and jobs the operator creates",
      "sidecar: runs a container next to PostgreSQL in every instance",
    ]);
    expect(capabilityWords("TYPE_ARCHIVE_WAL")).toBe("archive wal");
    expect(backupPluginWords(KLIO_PLUGIN)).toBe("Klio (klio.cnpg.io)");
    expect(backupPluginWords("example.io")).toBe("example.io");
  });

  it("tells what the clusters use a plugin for, from their spec and their backups", () => {
    const archived = new Cluster({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: "main", namespace: "db" },
      spec: { instances: 1, plugins: [{ name: BARMAN_CLOUD_PLUGIN, isWALArchiver: true }] },
    } as never);
    const replica = new Cluster({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: "replica", namespace: "dr" },
      spec: { instances: 1, externalClusters: [{ name: "origin", plugin: { name: BARMAN_CLOUD_PLUGIN } }] },
    } as never);
    const backup = {
      metadata: { namespace: "db" },
      spec: { method: "plugin", cluster: { name: "main" }, pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN } },
    };
    expect(pluginUse(BARMAN_CLOUD_PLUGIN, [archived, replica], [backup, backup])).toEqual({
      walArchiving: ["db/main"],
      backups: ["db/main"],
      recovery: ["dr/replica"],
    });
    expect(pluginUse(KLIO_PLUGIN, [archived, replica], [backup])).toEqual({
      walArchiving: [],
      backups: [],
      recovery: [],
    });
  });
});
