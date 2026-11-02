/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The write cases of M9 (SPEC-0032 onwards) on Freelens dev over CDP, against
// the kind cluster of `pnpm e2e:cluster:up`: the server check of the creation
// forms, the parameter presets, a recovery from an object store and the image
// catalog forms. They write in the namespace `cnpg-e2e-actions` (and one
// cluster scoped catalog), and delete what they created.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as cluster from "./cnpg-cluster";
import { appReady, connectApp, dismissNotifications, installExtension, openLabCluster } from "./cnpg-session";
import { waitUntil } from "./cnpg-steps";

import type { Frame, Locator } from "playwright";

import type { AppSession } from "./cnpg-session";

const TIMEOUT = 10 * 60 * 1000;
const CLUSTERS = "clusters.postgresql.cnpg.io";

/** Picks a value in a react-select of a form (type, then Enter). `id` is the id of the select's input. */
async function pickInSelect(frame: Frame, id: string, value: string): Promise<void> {
  const picker = frame.locator(`#${id}`);

  await picker.waitFor({ state: "visible", timeout: 60_000 });
  await picker.fill(value);
  await picker.press("Enter");
}

/** The YAML pane of a creation form, once it holds every one of `parts`. */
async function yamlWith(dialog: Locator, testId: string, ...parts: string[]): Promise<string> {
  return (
    (await waitUntil(
      async () => (await dialog.locator(`[data-testid="${testId}-yaml"]`).getAttribute("data-yaml")) ?? "",
      (yaml) => parts.every((part) => yaml.includes(part)),
      30_000,
    )) ?? ""
  );
}

/** Deletes a leftover of an interrupted run before a create. */
function deleteIfThere(resource: string, name: string, clusterScoped = false): void {
  const kubectl = clusterScoped ? cluster.kubectlE2E : cluster.kubectlActions;

  if (kubectl("get", resource, name).status === 0) {
    kubectl("delete", resource, name, "--wait=true", "--timeout=180s");
  }
}

/** Applies a manifest in the write namespace, through a file: the helpers of kubectl take no input. */
function applyActions(manifest: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cnpg-m9-")), "object.yaml");

  fs.writeFileSync(file, manifest);
  try {
    const { status, stderr } = cluster.kubectlActions("apply", "-f", file);

    if (status !== 0) throw new Error(`kubectl apply failed: ${stderr}`);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** The names of the instances of the write cluster, its primary first. */
function actionsInstances(): { primary: string; replicas: string[] } {
  const primary = cluster.kubectlActionsField(CLUSTERS, cluster.E2E_ACTIONS_CLUSTER, "{.status.currentPrimary}");
  const names = cluster
    .kubectlActionsField(CLUSTERS, cluster.E2E_ACTIONS_CLUSTER, "{.status.instanceNames[*]}")
    .split(" ")
    .filter(Boolean);

  return { primary, replicas: names.filter((name) => name !== primary) };
}

describe.skipIf(!(await appReady({ cluster: true })))(
  "CloudNativePG extension: the M9 writes on the lab cluster",
  () => {
    let session: AppSession;
    let frame: Frame;

    beforeAll(async () => {
      if (!cluster.fixturesReady()) {
        throw new Error(
          `The CloudNativePG fixtures are missing from ${cluster.E2E_CLUSTER_NAME}. Run \`pnpm e2e:cluster:up\` first.`,
        );
      }

      session = await connectApp();
      await installExtension(session);
      frame = await openLabCluster(session);
    }, TIMEOUT);

    afterEach(async () => {
      if (frame) {
        await cluster.clearNotifications(frame).catch(() => {});
        await dismissNotifications(session.window);
      }
    });

    afterAll(async () => {
      await session?.close();
    });

    it(
      "shows the operator's refusal before submit, and a preset sized on the form fixes it (SPEC-0032)",
      async () => {
        const name = "e2e-g-refused";

        deleteIfThere(CLUSTERS, name);
        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
        await frame.locator(".AddRemoveButtons .add-button").click();

        const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });
        // Nothing is sent while the form itself says what is missing.
        expect(await dialog.locator('[data-testid="cnpg-server-check"]').count()).toBe(0);

        await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill(name);
        await dialog.locator('[data-testid="cnpg-create-cluster-instances"]').fill("1");
        await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("1Gi");
        expect(await cluster.waitServerCheck(dialog)).toBe("valid");

        // A pair the form does not check, the operator's webhook does: min_wal_size above max_wal_size.
        await dialog.locator('[data-testid="cnpg-create-cluster-updates-section-toggle"]').click();
        await dialog.locator('[data-testid="cnpg-create-cluster-parameters-add"]').click();
        await dialog.locator('input[data-testid="cnpg-create-cluster-parameters-0-key"]').fill("min_wal_size");
        await dialog.locator('input[data-testid="cnpg-create-cluster-parameters-0-value"]').fill("2GB");
        await dialog.locator('[data-testid="cnpg-create-cluster-parameters-add"]').click();
        await dialog.locator('input[data-testid="cnpg-create-cluster-parameters-1-key"]').fill("max_wal_size");
        await dialog.locator('input[data-testid="cnpg-create-cluster-parameters-1-value"]').fill("1MB");
        await yamlWith(dialog, "cnpg-create-cluster", "min_wal_size: 2GB", "max_wal_size: 1MB");

        expect(await cluster.waitServerCheck(dialog)).toBe("refused");
        const answer = (await dialog.locator('[data-testid="cnpg-server-check"]').innerText()).replace(/\s+/g, " ");

        expect(answer).toContain("The API server refuses it, before anything is created");
        expect(answer).toContain("PostgreSQL parameters (spec.postgresql.parameters.min_wal_size)");
        expect(answer).toContain("min_wal_size");
        expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toMatch(
          /^The API server refuses it \(PostgreSQL parameters\): Invalid value: "2GB"/,
        );
        expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
        await cluster.captureScreenshot(frame, "create-cluster-server-refusal-dark");

        // The general purpose preset, sized on an assumed 1GB of memory and the 1Gi volume, replaces both values.
        await pickInSelect(frame, "cnpg-create-cluster-preset", "General purpose");
        await yamlWith(
          dialog,
          "cnpg-create-cluster",
          "shared_buffers: 256MB",
          "min_wal_size: 64MB",
          "max_wal_size: 256MB",
        );
        expect(await dialog.locator('[data-testid="cnpg-create-cluster-preset-field"]').innerText()).toContain(
          "Sized for an assumed 1GB of memory",
        );
        expect(await cluster.waitServerCheck(dialog)).toBe("valid");
        expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(false);

        // The values follow the memory request until one is edited.
        await dialog.locator('[data-testid="cnpg-create-cluster-resources-section-toggle"]').click();
        await dialog.locator('[data-testid="cnpg-create-cluster-requests-memory"]').fill("2Gi");
        await yamlWith(dialog, "cnpg-create-cluster", "shared_buffers: 512MB", "effective_cache_size: 1536MB");
        await dialog.locator('input[data-testid="cnpg-create-cluster-parameters-2-value"]').fill("384MB");
        expect(await dialog.locator('[data-testid="cnpg-create-cluster-preset-field"]').innerText()).toContain(
          "Edited: the values no longer follow",
        );
        await dialog.locator('[data-testid="cnpg-create-cluster-requests-memory"]').fill("4Gi");
        await yamlWith(dialog, "cnpg-create-cluster", "shared_buffers: 384MB", "memory: 4Gi");
        await cluster.captureScreenshot(frame, "create-cluster-preset-dark");

        await cluster.cancelDialog(frame);
        // W8: the dry runs created nothing.
        expect(cluster.kubectlActions("get", CLUSTERS, name).status).not.toBe(0);
        await cluster.selectNamespace(frame);
      },
      TIMEOUT,
    );

    it(
      "recovers a server of an object store into a new cluster, with the last row written (SPEC-0032)",
      async () => {
        const name = `${cluster.E2E_ACTIONS_CLUSTER}-recovered`;
        const store = "actions-store";

        deleteIfThere(CLUSTERS, name);

        // A row written after the last backup: the recovery has it only through the WAL archive.
        const primary = cluster.kubectlActionsField(CLUSTERS, cluster.E2E_ACTIONS_CLUSTER, "{.status.currentPrimary}");
        const marker = `g-${Date.now()}`;

        cluster.psqlActions(primary, "CREATE TABLE IF NOT EXISTS recovery_marker (v text)");
        cluster.psqlActions(primary, `INSERT INTO recovery_marker VALUES ('${marker}')`);
        const walFile = cluster.psqlActions(primary, "SELECT pg_walfile_name(pg_switch_wal())");

        expect(walFile).toMatch(/^[0-9A-F]{24}$/);
        const archived = await waitUntil(
          async () => cluster.psqlActions(primary, "SELECT last_archived_wal FROM pg_stat_archiver"),
          (last) => last !== "" && last >= walFile,
          3 * 60_000,
        );

        expect(archived >= walFile, `archived ${archived}, switched ${walFile}`).toBe(true);

        await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
        await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
        await frame
          .locator(".TableRow", { hasText: store })
          .first()
          .locator(".TableCell", { hasText: store })
          .first()
          .click();

        const drawer = frame.locator(".Drawer.KubeObjectDetails");
        const recover = drawer.locator(`[data-testid="cnpg-recover-${cluster.E2E_ACTIONS_CLUSTER}"]`);

        await recover.waitFor({ state: "visible", timeout: 60_000 });
        // A server with no complete backup has nothing to recover from.
        expect(
          await drawer
            .locator(`[data-testid="cnpg-recover-${cluster.E2E_SNAPSHOT_CLUSTER}"]`)
            .getAttribute("data-disabled"),
        ).toBe("true");
        await recover.click();

        const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });
        expect(await dialog.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(
          `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
        );
        const storage = cluster.kubectlActionsField(CLUSTERS, cluster.E2E_ACTIONS_CLUSTER, "{.spec.storage.size}");
        const yaml = await yamlWith(
          dialog,
          "cnpg-create-cluster",
          "  bootstrap:\n    recovery:\n      source: e2e-actions\n",
          `        barmanObjectName: ${store}\n        serverName: ${cluster.E2E_ACTIONS_CLUSTER}\n`,
          `    size: ${storage}\n`,
        );

        expect(yaml).toContain("  imageName: ");
        expect(await cluster.waitServerCheck(dialog)).toBe("valid");
        await cluster.captureScreenshot(frame, "recover-into-new-cluster-dark");
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(
          frame,
          "ok",
          `Requested the PostgreSQL cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
        );
        await cluster.closeDetails(frame);

        // The same image as the source: a recovery needs the same major.
        expect(cluster.kubectlActionsField(CLUSTERS, name, "{.spec.imageName}")).toBe(
          cluster.kubectlActionsField(CLUSTERS, cluster.E2E_ACTIONS_CLUSTER, "{.status.image}"),
        );
        expect(
          await waitUntil(
            async () => cluster.kubectlActionsField(CLUSTERS, name, "{.status.phase}"),
            (phase) => phase === "Cluster in healthy state",
            8 * 60_000,
          ),
        ).toBe("Cluster in healthy state");
        expect(cluster.psqlActions(`${name}-1`, "SELECT v FROM recovery_marker")).toContain(marker);

        cluster.kubectlActions("delete", CLUSTERS, name, "--wait=true", "--timeout=180s");
        expect(cluster.kubectlActions("get", CLUSTERS, name).status).not.toBe(0);
        await cluster.selectNamespace(frame);
      },
      TIMEOUT,
    );

    it(
      "creates an image catalog and a cluster image catalog from their lists (SPEC-0032)",
      async () => {
        const name = "e2e-g-catalog";
        const image17 = "ghcr.io/cloudnative-pg/postgresql:17.5-standard-trixie";
        const image18 = "ghcr.io/cloudnative-pg/postgresql:18.1-standard-trixie";

        for (const [kind, resource, menuId, title, testId] of [
          [
            "ImageCatalog",
            "imagecatalogs.postgresql.cnpg.io",
            "cnpg-images-imagecatalogs",
            "Image Catalogs",
            "cnpg-create-image-catalog",
          ],
          [
            "ClusterImageCatalog",
            "clusterimagecatalogs.postgresql.cnpg.io",
            "cnpg-images-clusterimagecatalogs",
            "Cluster Image Catalogs",
            "cnpg-create-cluster-image-catalog",
          ],
        ] as const) {
          const clusterScoped = kind === "ClusterImageCatalog";
          const kubectl = clusterScoped ? cluster.kubectlE2E : cluster.kubectlActions;

          deleteIfThere(resource, name, clusterScoped);
          await cluster.openCnpgPage(frame, menuId, title);
          if (!clusterScoped) await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          await frame.locator(".AddRemoveButtons .add-button").click();

          const dialog = frame.locator(`[data-testid="${testId}"]`);

          await dialog.waitFor({ state: "visible", timeout: 60_000 });
          await dialog.locator(`[data-testid="${testId}-name"]`).fill(name);
          await dialog.locator(`input[data-testid="${testId}-images-0-key"]`).fill("17");
          await dialog.locator(`input[data-testid="${testId}-images-0-value"]`).fill(image17);
          await dialog.locator(`[data-testid="${testId}-images-add"]`).click();
          // The same major twice is refused inline; a tag of another major only warns.
          await dialog.locator(`input[data-testid="${testId}-images-1-key"]`).fill("17");
          await dialog.locator(`input[data-testid="${testId}-images-1-value"]`).fill(image18);
          expect(await dialog.locator(`[data-testid="${testId}-images-1-error"]`).innerText()).toContain(
            "PostgreSQL 17 is listed twice",
          );
          expect(await dialog.locator(`[data-testid="${testId}-images-field-warning"]`).innerText()).toContain(
            "The tag reads PostgreSQL 18, not 17",
          );
          expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
          await dialog.locator(`input[data-testid="${testId}-images-1-key"]`).fill("18");
          expect(await dialog.locator(`[data-testid="${testId}-images-field-warning"]`).count()).toBe(0);

          expect(await cluster.waitServerCheck(dialog)).toBe("valid");
          expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toBe(
            clusterScoped
              ? `create ClusterImageCatalog ${name}: PostgreSQL 17, 18`
              : `create ImageCatalog ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: PostgreSQL 17, 18`,
          );
          await cluster.captureScreenshot(frame, `create-${testId.replace("cnpg-create-", "")}-dark`);
          await cluster.confirmDialog(frame);
          await cluster.expectNotification(
            frame,
            "ok",
            clusterScoped
              ? `Created the cluster image catalog ${name}`
              : `Created the image catalog ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
          );

          const read = kubectl("get", resource, name, "-o", "jsonpath={.spec.images[*].major} {.spec.images[*].image}");

          expect(read.stdout.trim()).toBe(`17 18 ${image17} ${image18}`);
          await cluster.expectRow(frame, name);

          kubectl("delete", resource, name, "--wait=true", "--timeout=120s");
          expect(kubectl("get", resource, name).status).not.toBe(0);
          if (!clusterScoped) await cluster.selectNamespace(frame);
        }
      },
      TIMEOUT,
    );

    it(
      "pauses a pooler from its menu and resumes it from its drawer (SPEC-0037)",
      async () => {
        const name = "e2e-m9-pause-pooler";
        const poolers = "poolers.postgresql.cnpg.io";

        deleteIfThere(poolers, name);
        applyActions(
          [
            "apiVersion: postgresql.cnpg.io/v1",
            "kind: Pooler",
            "metadata:",
            `  name: ${name}`,
            "spec:",
            `  cluster: { name: ${cluster.E2E_ACTIONS_CLUSTER} }`,
            "  type: rw",
            "  instances: 1",
            "  pgbouncer: { poolMode: session }",
            "",
          ].join("\n"),
        );
        expect(
          await waitUntil(
            async () => cluster.kubectlActionsField(poolers, name, "{.status.phase}"),
            (phase) => phase === "active",
            4 * 60_000,
          ),
        ).toBe("active");
        // The proxy answers 400 for a pod without an address yet: the exporter is read once the pod is ready.
        // The pooler reads active before its pod exists: wait for the pod first, then for it to be ready.
        await waitUntil(
          async () => cluster.kubectlActions("get", "pods", "-l", `cnpg.io/poolerName=${name}`, "-o", "name").stdout,
          (pods) => pods !== "",
          3 * 60_000,
        );
        expect(
          cluster.kubectlActions(
            "wait",
            "--for=condition=Ready",
            "pod",
            "-l",
            `cnpg.io/poolerName=${name}`,
            "--timeout=180s",
          ).status,
        ).toBe(0);

        await cluster.openCnpgPage(frame, "cnpg-pooling-poolers", "Poolers");
        await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
        await cluster.expectRow(frame, name);
        await cluster.openRowMenu(frame, name);
        await frame.locator('.Menu [data-testid="cnpg-pooler-pause-menu-item"]').first().click();

        const dialog = frame.locator('[data-testid="cnpg-pooler-pause-dialog"]');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });
        expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toBe(
          `patch Pooler ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: spec.pgbouncer.paused false -> true`,
        );
        // The clients connected right now, from the exporter of the pooler's pod.
        expect(
          await waitUntil(
            async () => dialog.locator('[data-testid="cnpg-pooler-pause-clients"]').innerText(),
            (text) => /connected through the pooler right now/.test(text),
            60_000,
          ),
        ).toMatch(/connected through the pooler right now/);
        await cluster.captureScreenshot(frame, "pooler-pause-dialog-dark");
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(
          frame,
          "ok",
          `Pause of the pooler ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`,
        );
        expect(cluster.kubectlActionsField(poolers, name, "{.spec.pgbouncer.paused}")).toBe("true");
        expect(
          await waitUntil(
            async () => cluster.kubectlActionsField(poolers, name, "{.status.phase}"),
            (phase) => phase === "paused",
            2 * 60_000,
          ),
        ).toBe("paused");

        // The drawer says it, with the way back next to it.
        await frame
          .locator(".TableRow", { hasText: name })
          .first()
          .locator(".TableCell", { hasText: name })
          .first()
          .click();
        const drawer = frame.locator(".Drawer.KubeObjectDetails");
        const state = drawer.locator('[data-testid="cnpg-pooler-pause-state"]');

        await state.waitFor({ state: "visible", timeout: 60_000 });
        expect(
          await waitUntil(
            async () => state.innerText(),
            (text) => text.startsWith("Paused"),
            30_000,
          ),
        ).toMatch(/^Paused: PgBouncer holds every new query/);
        await drawer.locator('[data-testid="cnpg-pooler-resume-button"]').click();
        await frame.locator('[data-testid="cnpg-pooler-resume-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(
          frame,
          "ok",
          `Resume of the pooler ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`,
        );
        expect(cluster.kubectlActionsField(poolers, name, "{.spec.pgbouncer.paused}")).toBe("false");
        expect(
          await waitUntil(
            async () => cluster.kubectlActionsField(poolers, name, "{.status.phase}"),
            (phase) => phase === "active",
            2 * 60_000,
          ),
        ).toBe("active");
        await cluster.closeDetails(frame);

        cluster.kubectlActions("delete", poolers, name, "--wait=true", "--timeout=120s");
        await cluster.selectNamespace(frame);
      },
      TIMEOUT,
    );

    it(
      "opens the maintenance window with the choice about the volumes, and closes it from the drawer (SPEC-0037)",
      async () => {
        const name = cluster.E2E_ACTIONS_CLUSTER;

        // A leftover of an interrupted run.
        if (cluster.kubectlActionsField(CLUSTERS, name, "{.spec.nodeMaintenanceWindow.inProgress}") === "true") {
          cluster.kubectlActions(
            "patch",
            CLUSTERS,
            name,
            "--type=merge",
            "-p",
            '{"spec":{"nodeMaintenanceWindow":{"inProgress":false}}}',
          );
        }
        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
        await cluster.openRowMenu(frame, name);
        await frame.locator('.Menu [data-testid="cnpg-cluster-maintenance-open-menu-item"]').first().click();

        const dialog = frame.locator('[data-testid="cnpg-maintenance-open-dialog"]');
        const write = dialog.locator('[data-testid="cnpg-action-writes"] li').first();

        await dialog.waitFor({ state: "visible", timeout: 60_000 });
        const before =
          cluster.kubectlActionsField(CLUSTERS, name, "{.spec.nodeMaintenanceWindow.reusePVC}") !== "false";

        expect(await write.innerText()).toBe(
          `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: spec.nodeMaintenanceWindow inProgress false -> true, reusePVC ${before} -> ${before}`,
        );
        // The facts follow the choice: off recreates an instance elsewhere.
        if (before) await dialog.locator('[data-testid="cnpg-maintenance-reuse-pvc"]').uncheck();
        expect(await write.innerText()).toBe(
          `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: spec.nodeMaintenanceWindow inProgress false -> true, reusePVC ${before} -> false`,
        );
        expect((await dialog.innerText()).replace(/\s+/g, " ")).toContain("recreated on another node, on a new volume");
        await dialog.locator('[data-testid="cnpg-maintenance-reuse-pvc"]').check();
        expect((await dialog.innerText()).replace(/\s+/g, " ")).toContain("waits for the node to come back");
        await cluster.captureScreenshot(frame, "maintenance-open-dialog-dark");
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(
          frame,
          "ok",
          `Maintenance window of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} open`,
        );
        expect(cluster.kubectlActionsField(CLUSTERS, name, "{.spec.nodeMaintenanceWindow.inProgress}")).toBe("true");
        expect(cluster.kubectlActionsField(CLUSTERS, name, "{.spec.nodeMaintenanceWindow.reusePVC}")).toBe("true");

        // The Overview tells it on the tile.
        await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
        await frame
          .locator(`[data-testid="cnpg-overview-maintenance-${cluster.E2E_ACTIONS_NAMESPACE}-${name}"]`)
          .waitFor({ state: "visible", timeout: 60_000 });

        // The drawer says it, and closes it.
        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await frame
          .locator(".TableRow", { hasText: name })
          .first()
          .locator(".TableCell", { hasText: name })
          .first()
          .click();
        const drawer = frame.locator(".Drawer.KubeObjectDetails");

        await drawer.locator('[data-testid="cnpg-maintenance-state"]').waitFor({ state: "visible", timeout: 60_000 });
        expect(await drawer.locator('[data-testid="cnpg-maintenance-state"]').innerText()).toBe(
          "Open, volumes reused: an instance on a drained node waits for the node to come back",
        );
        await drawer.locator('[data-testid="cnpg-maintenance-close"]').click();
        await frame
          .locator('[data-testid="cnpg-maintenance-close-dialog"]')
          .waitFor({ state: "visible", timeout: 60_000 });
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(
          frame,
          "ok",
          `Maintenance window of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} closed`,
        );
        expect(cluster.kubectlActionsField(CLUSTERS, name, "{.spec.nodeMaintenanceWindow.inProgress}")).toBe("false");
        await drawer.locator('[data-testid="cnpg-maintenance-state"]').waitFor({ state: "detached", timeout: 60_000 });
        await cluster.closeDetails(frame);
        await cluster.selectNamespace(frame);
      },
      TIMEOUT,
    );

    it(
      "destroys a replica, and the operator recreates it from the primary; never the primary (SPEC-0037)",
      async () => {
        const name = cluster.E2E_ACTIONS_CLUSTER;
        const ns = cluster.E2E_ACTIONS_NAMESPACE;
        const { primary, replicas } = actionsInstances();
        const [replica] = replicas;

        expect(replicas).toHaveLength(1);
        const uid = (kind: string) =>
          cluster.kubectlActions("get", kind, replica, "-o", "jsonpath={.metadata.uid}").stdout;
        const podBefore = uid("pod");
        const claimBefore = uid("pvc");

        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await cluster.selectNamespace(frame, ns);
        await frame
          .locator(".TableRow", { hasText: name })
          .first()
          .locator(".TableCell", { hasText: name })
          .first()
          .click();

        const drawer = frame.locator(".Drawer.KubeObjectDetails");

        await drawer
          .locator(`[data-testid="cnpg-instance-destroy-${replica}"]`)
          .waitFor({ state: "visible", timeout: 60_000 });
        // Never on the primary.
        expect(await drawer.locator(`[data-testid="cnpg-instance-destroy-${primary}"]`).count()).toBe(0);
        await drawer.locator(`[data-testid="cnpg-instance-destroy-${replica}"]`).click();

        const dialog = frame.locator('[data-testid="cnpg-destroy-instance-dialog"]');
        const writes = dialog.locator('[data-testid="cnpg-action-writes"] li');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });
        const listed = await waitUntil(
          async () => writes.allInnerTexts(),
          (texts) => texts.length >= 2,
          30_000,
        );
        const pod = listed.indexOf(`delete Pod ${ns}/${replica}`);

        // The volumes first, then the pod, then the jobs.
        expect(listed[0]).toMatch(new RegExp(`^delete PersistentVolumeClaim ${ns}/${replica} \\(PG_DATA`));
        expect(pod).toBeGreaterThan(0);
        expect(listed.slice(0, pod).every((text) => text.startsWith("delete PersistentVolumeClaim"))).toBe(true);
        expect(listed.slice(pod + 1).every((text) => text.startsWith("delete Job"))).toBe(true);
        // W5: OK waits for the instance name.
        expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
        await dialog.locator('[data-testid="cnpg-action-typed-name"]').fill(replica);
        expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(false);
        await cluster.captureScreenshot(frame, "destroy-instance-dark");
        await cluster.confirmDialog(frame);
        await cluster.expectNotification(frame, "ok", `${replica} of ${ns}/${name} destroyed`);
        await cluster.closeDetails(frame);

        // CloudNativePG 1.30 gives the new instance the first free serial: the same name, a new pod and volume.
        const recreated = await waitUntil(
          async () => {
            const phase = cluster.kubectlActionsField(CLUSTERS, name, "{.status.phase}");
            const ready = cluster.kubectlActionsField(CLUSTERS, name, "{.status.readyInstances}");
            const podNow = uid("pod");
            const claimNow = uid("pvc");

            return (
              phase === "Cluster in healthy state" &&
              ready === "2" &&
              podNow !== "" &&
              podNow !== podBefore &&
              claimNow !== "" &&
              claimNow !== claimBefore
            );
          },
          (done) => done,
          8 * 60_000,
        );

        expect(recreated).toBe(true);
        expect(actionsInstances().primary).toBe(primary);
        await cluster.selectNamespace(frame);
      },
      TIMEOUT,
    );

    it(
      "shows the restart a parameter change waits for on the primary, and the value of the spec (SPEC-0035)",
      async () => {
        const name = cluster.E2E_ACTIONS_CLUSTER;
        const patch = (body: unknown) =>
          cluster.kubectlActions("patch", CLUSTERS, name, "--type=merge", "-p", JSON.stringify(body));

        // Supervised: the replicas restart on their own, the primary waits for a switchover, so its restart stays pending.
        expect(
          patch({
            spec: { primaryUpdateStrategy: "supervised", postgresql: { parameters: { max_connections: "110" } } },
          }).status,
        ).toBe(0);
        try {
          const { primary } = actionsInstances();

          await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          await frame
            .locator(".TableRow", { hasText: name })
            .first()
            .locator(".TableCell", { hasText: name })
            .first()
            .click();
          await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-config-link"]').click();

          const panel = frame.locator('[data-testid="cnpg-config-panel"]');
          const value = panel.locator('[data-testid="cnpg-config-param-max_connections"]');

          // The file follows the spec once the instance manager wrote it: read again until it is there.
          expect(
            await waitUntil(
              async () => {
                if ((await value.count()) === 0) await panel.locator('[data-testid="cnpg-config-read"]').click();
                return value.count();
              },
              (count) => count === 1,
              3 * 60_000,
            ),
          ).toBe(1);
          expect(await value.getAttribute("data-origin")).toBe("spec");
          await panel
            .locator(`[data-testid="cnpg-config-instance-${primary}"][data-pending="true"]`)
            .waitFor({ state: "visible", timeout: 3 * 60_000 });
          expect((await panel.innerText()).replace(/\s+/g, " ")).toContain(
            "restart pending: a changed parameter needs a restart",
          );
          await cluster.captureScreenshot(frame, "m9-config-pending-dark");
        } finally {
          // Away from the page first: the revert restarts the primary, whose status port answers 503 meanwhile.
          await cluster.openCnpgPage(frame, "cnpg-overview", "Overview").catch(() => {});
          // The replicas this case restarts answer 503 (or 400, without an address yet) on their status port while the strip asks them: on purpose.
          session.forgetErrors(
            /^\[renderer\] Failed to load resource: the server responded with a status of (400|503) \(\) @ \S+\/namespaces\/cnpg-e2e-actions\/pods\/https?:e2e-actions-\d+:8000\/proxy\/pg\/status$/,
          );
          patch({
            spec: { primaryUpdateStrategy: "unsupervised", postgresql: { parameters: { max_connections: null } } },
          });
          await waitUntil(
            async () =>
              cluster.kubectlActionsField(CLUSTERS, name, "{.status.phase}") === "Cluster in healthy state" &&
              cluster.kubectlActionsField(CLUSTERS, name, "{.status.readyInstances}") === "2",
            (healthy) => healthy,
            5 * 60_000,
          );
          await cluster.selectNamespace(frame).catch(() => {});
        }
      },
      TIMEOUT,
    );

    it("logs no error while the M9 writes run", () => {
      expect(session.errors()).toEqual([]);
    });
  },
);
