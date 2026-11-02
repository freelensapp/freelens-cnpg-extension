/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The write cases of M9 (SPEC-0032 onwards) on Freelens dev over CDP, against
// the kind cluster of `pnpm e2e:cluster:up`: the server check of the creation
// forms, the parameter presets, a recovery from an object store and the image
// catalog forms. They write in the namespace `cnpg-e2e-actions` (and one
// cluster scoped catalog), and delete what they created.

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

    it("logs no error while the M9 writes run", () => {
      expect(session.errors()).toEqual([]);
    });
  },
);
