/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// E2E suite of the CloudNativePG extension, run through the Freelens
// integration harness against the kind cluster created by
// `e2e/scripts/cluster-up.sh` (SPEC-0002). This file is copied next to the
// Freelens integration tests by `run-suite.sh`, which is why it imports the
// harness helpers from `../helpers/utils`.
//
// The cases of this file are the infrastructure ones: the extension activates
// without errors, the cluster connects, and spike S1 of SPEC-0001 (the
// instance manager and the metrics exporter are reachable through the Freelens
// cluster proxy on the API server's pod proxy path, without any database
// credential). Every view spec appends its own cases here.

import * as cluster from "../helpers/cnpg-cluster";
import * as cnpg from "../helpers/cnpg-extension";
import * as utils from "../helpers/utils";

import type { ElectronApplication, Frame, Page } from "playwright";

const TIMEOUT = 10 * 60 * 1000;

/** The path the Freelens renderer uses to reach the cluster's API server. */
const API_KUBE_PREFIX = "/api-kube";

/** The API server pod proxy path of an instance port, as `kubectl cnpg status` builds it. */
function podProxyPath(pod: string, scheme: "http" | "https", port: number, path: string): string {
  return `${API_KUBE_PREFIX}/api/v1/namespaces/${cluster.E2E_NAMESPACE}/pods/${scheme}:${pod}:${port}/proxy${path}`;
}

/**
 * Fetches a path through the cluster frame, which is the origin the host's own
 * Kubernetes JSON API client uses: same proxy, same credentials, no CORS.
 */
async function fetchFromClusterFrame(frame: Frame, path: string): Promise<{ status: number; body: string }> {
  return frame.evaluate(async (target: string) => {
    const response = await fetch(target);

    return { status: response.status, body: await response.text() };
  }, path);
}

/** The name cell of a list row: clicking it opens the drawer without hitting a link in another cell. */
function tableRowName(frame: Frame, name: string) {
  return frame.locator(".TableRow", { hasText: name }).first().locator(".TableCell", { hasText: name }).first();
}

interface InstanceManagerStatus {
  isPrimary?: boolean;
  systemID?: string;
  currentLsn?: string;
  timeLineID?: number;
  instanceManagerVersion?: string;
}

describe("CloudNativePG extension against the fixture cluster", () => {
  let app: ElectronApplication;
  let window: Page;
  let frame: Frame;
  let cleanup: undefined | (() => Promise<void>);

  const errorCollector = cnpg.createErrorCollector();

  beforeAll(async () => {
    if (!cluster.fixturesReady()) {
      throw new Error(
        `The CloudNativePG fixtures are missing from ${cluster.E2E_CLUSTER_NAME}. Run \`pnpm e2e:cluster:up\` first.`,
      );
    }

    errorCollector.start();

    ({ app, window, cleanup } = await utils.start());
    errorCollector.watch(window);

    const kubeconfig = await cluster.publishKubeconfig();

    await utils.clickWelcomeButton(window);
    await cnpg.installExtension(app, window);
    await cnpg.dismissNotifications(window);
    await cnpg.navigateToCatalog(app);

    frame = await cluster.openClusterFromCatalog(window, kubeconfig);
    // The namespace filter lives in the header of namespaced list pages; the
    // cases of this file read through the API server from the cluster frame
    // and need no page. The view specs open their page and then call
    // `cluster.selectNamespace(frame)`.
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup?.();
    errorCollector.stop(window);
  }, TIMEOUT);

  it(
    "connects the cluster and sees the fixture clusters through the API server",
    async () => {
      const { status, body } = await fetchFromClusterFrame(
        frame,
        `${API_KUBE_PREFIX}/apis/postgresql.cnpg.io/v1/namespaces/${cluster.E2E_NAMESPACE}/clusters`,
      );

      expect(status).toBe(200);

      const names = (JSON.parse(body).items as { metadata: { name: string } }[]).map((item) => item.metadata.name);

      expect(names.sort()).toEqual(["e2e-fenced", "e2e-hibernated", "e2e-main", "e2e-single"]);
    },
    TIMEOUT,
  );

  it(
    "reads the instance manager status of the primary through the pod proxy (spike S1)",
    async () => {
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
      const systemId = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.systemID}");

      expect(primary).toMatch(/^e2e-main-\d+$/);

      const { status, body } = await fetchFromClusterFrame(frame, podProxyPath(primary, "https", 8000, "/pg/status"));

      expect(status).toBe(200);

      const parsed = JSON.parse(body) as InstanceManagerStatus;

      expect(parsed.isPrimary).toBe(true);
      expect(parsed.systemID).toBe(systemId);
      expect(parsed.currentLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
      expect(parsed.instanceManagerVersion).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    "reads the instance manager status of a replica through the pod proxy (spike S1)",
    async () => {
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
      const instances = cluster
        .kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.instanceNames[*]}")
        .split(/\s+/)
        .filter(Boolean);
      const replica = instances.find((name) => name !== primary);

      expect(replica).toBeTruthy();

      const { status, body } = await fetchFromClusterFrame(
        frame,
        podProxyPath(replica as string, "https", 8000, "/pg/status"),
      );

      expect(status).toBe(200);
      expect((JSON.parse(body) as InstanceManagerStatus).isPrimary).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "reads the metrics of a plaintext and of a TLS instance through the pod proxy (spike S1)",
    async () => {
      const plaintext = await fetchFromClusterFrame(frame, podProxyPath("e2e-main-1", "http", 9187, "/metrics"));

      expect(plaintext.status).toBe(200);
      expect(plaintext.body).toContain("cnpg_collector_up");
      expect(plaintext.body).toContain("cnpg_backends_total");

      const tls = await fetchFromClusterFrame(frame, podProxyPath("e2e-single-1", "https", 9187, "/metrics"));

      expect(tls.status).toBe(200);
      expect(tls.body).toContain("cnpg_collector_up");
    },
    TIMEOUT,
  );

  it(
    "lists the fixture clusters with their health on the PostgreSQL Clusters page (SPEC-0003)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);

      await cluster.expectRow(frame, "e2e-main", "3/3", "e2e-main-1", "Healthy");
      await cluster.expectRow(frame, "e2e-single", "1/1", "Degraded");
      await cluster.expectRow(frame, "e2e-hibernated", "Hibernated");
      await cluster.expectRow(frame, "e2e-fenced", "0/1", "Degraded", "Fenced instances: e2e-fenced-1");
    },
    TIMEOUT,
  );

  it(
    "tells the whole story of e2e-main in its drawer (SPEC-0003)",
    async () => {
      await cluster.expectDetails(
        frame,
        "e2e-main",
        "Health",
        "Healthy",
        "Instances",
        "3/3",
        "e2e-main-1",
        "e2e-main-2",
        "e2e-main-3",
        "primary",
        "Replication",
        "Topology",
        "PostgreSQL",
        "Storage",
        "Backups and archiving",
        "Archiving",
        "Backup objects",
        "Certificates",
        "server CA",
        "replication TLS",
        "Services and secrets",
        "e2e-main-rw",
        "e2e-main-app",
        "Plugins",
        "barman-cloud.cloudnative-pg.io",
      );
    },
    TIMEOUT,
  );

  it(
    "shows the fleet on the Overview and opens a cluster from its tile (SPEC-0004)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");

      const strip = frame.locator('[data-testid="cnpg-overview-strip"]');

      await strip.waitFor({ state: "visible", timeout: 60_000 });
      expect(await frame.locator('[data-testid="cnpg-stat-clusters"]').innerText()).toContain("4");
      expect(await frame.locator('[data-testid="cnpg-stat-instances"]').innerText()).toContain("4/6");
      expect(await frame.locator('[data-testid="cnpg-stat-archiving"]').innerText()).toContain("1");

      const tiles = frame.locator('[data-testid^="cnpg-overview-tile-"]');

      await tiles.first().waitFor({ state: "visible", timeout: 60_000 });
      expect(await tiles.count()).toBe(4);
      expect(await tiles.first().getAttribute("data-state")).toBe("Degraded");

      const single = frame.locator('[data-testid="cnpg-overview-tile-cnpg-e2e-e2e-single"]');

      expect(await single.innerText()).toContain("barman-cloud");

      await cluster.captureScreenshot(frame, "overview");
      await frame
        .locator('[data-testid="cnpg-overview-tile-cnpg-e2e-e2e-main"]')
        .getByText("e2e-main", { exact: true })
        .first()
        .click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Health" });

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      expect(await drawer.innerText()).toContain("e2e-main");
      await cluster.captureScreenshot(frame, "overview-drawer");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "opens the list filtered on the failing clusters from the Overview strip (SPEC-0004)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame.locator('[data-testid="cnpg-stat-archiving"]').click();
      await frame.waitForSelector('h5 >> text="PostgreSQL Clusters"', { timeout: 60_000 });

      await cluster.expectRow(frame, "e2e-single", "Degraded");
      await cluster.expectNoRow(frame, "e2e-main");

      // Leave the list unfiltered for the cases that follow.
      const search = frame.locator(".SearchInput input").first();

      await search.fill("");
      await cluster.expectRow(frame, "e2e-main", "Healthy");
    },
    TIMEOUT,
  );

  it(
    "captures the M1 and M2 views on both themes for the review",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.expectRow(frame, "e2e-main", "Healthy");
      await cluster.captureScreenshot(frame, "clusters-dark");

      await cnpg.setColorTheme(app, window, "Light");
      try {
        await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
        await frame.locator('[data-testid="cnpg-overview-grid"]').waitFor({ state: "visible", timeout: 60_000 });
        await cluster.captureScreenshot(frame, "overview-light");
        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await cluster.expectRow(frame, "e2e-main", "Healthy");
        await cluster.captureScreenshot(frame, "clusters-light");
        await frame
          .locator(".TableRow", { hasText: "e2e-main" })
          .first()
          .locator(".TableCell", { hasText: "e2e-main" })
          .first()
          .click();
        await frame
          .locator(".Drawer.KubeObjectDetails", { hasText: "Certificates" })
          .waitFor({ state: "visible", timeout: 60_000 });
        await cluster.captureScreenshot(frame, "drawer-light");
        await cluster.closeDetails(frame);

        // The M2 backup views (SPEC-0005) on the light theme.
        await cluster.openCnpgPage(frame, "cnpg-backups-backups", "Backups");
        await cluster.expectRow(frame, "e2e-backup-ok", "Completed");
        await cluster.captureScreenshot(frame, "backups-light");
        await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
        await cluster.expectRow(frame, "e2e-suspended", "Suspended");
        await cluster.captureScreenshot(frame, "scheduled-backups-light");
        await tableRowName(frame, "e2e-immediate").click();

        const history = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-backup-history"]');

        await history.waitFor({ state: "visible", timeout: 60_000 });
        await history.scrollIntoViewIfNeeded();
        await cluster.captureScreenshot(frame, "scheduled-backup-history-light");
        await cluster.closeDetails(frame);
      } finally {
        await cnpg.setColorTheme(app, window, "Dark");
      }
    },
    TIMEOUT,
  );

  it(
    "lists the backups with their outcome, their cluster and their schedule (SPEC-0005)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-backups-backups", "Backups");
      await cluster.selectNamespace(frame);

      await cluster.expectRow(frame, "e2e-backup-ok", "e2e-main", "plugin", "Completed", "Completed in");
      await cluster.expectRow(frame, "e2e-backup-failed", "e2e-single", "Failed", "rpc error");
      // The backup the immediate schedule generated carries its parent in the Schedule column.
      await cluster.expectRow(frame, "e2e-immediate-", "e2e-main", "e2e-immediate", "Completed");
      await cluster.captureScreenshot(frame, "backups-dark");
    },
    TIMEOUT,
  );

  it(
    "shows the restore coordinates of a completed backup in its drawer (SPEC-0005)",
    async () => {
      const backupId = cluster.kubectlField("backups.postgresql.cnpg.io", "e2e-backup-ok", "{.status.backupId}");
      const beginWal = cluster.kubectlField("backups.postgresql.cnpg.io", "e2e-backup-ok", "{.status.beginWal}");
      const endLsn = cluster.kubectlField("backups.postgresql.cnpg.io", "e2e-backup-ok", "{.status.endLSN}");
      const pod = cluster.kubectlField("backups.postgresql.cnpg.io", "e2e-backup-ok", "{.status.instanceID.podName}");

      expect(backupId).not.toBe("");

      await cluster.expectDetails(
        frame,
        "e2e-backup-ok",
        "Outcome",
        "Completed",
        "Source",
        "e2e-main",
        pod,
        "On demand",
        "Timing",
        "Restore coordinates",
        backupId,
        beginWal,
        endLsn,
        "Timeline",
        "WAL during backup",
        "Destination",
        "barman-cloud.cloudnative-pg.io",
        "e2e-store",
        "Plugin metadata",
      );

      // A failed backup never got coordinates: the section is not there at all.
      await cluster.expectDetails(frame, "e2e-backup-failed", "Outcome", "Failed", "rpc error", "e2e-single");
      await tableRowName(frame, "e2e-backup-failed").click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      expect(await drawer.innerText()).not.toContain("Restore coordinates");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "lists the schedules with their state and their next run (SPEC-0005)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
      await cluster.selectNamespace(frame);

      await cluster.expectRow(frame, "e2e-nightly", "e2e-main", "0 0 3 * * *", "plugin", "Active");
      await cluster.expectRow(frame, "e2e-immediate", "e2e-main", "0 30 4 * * *", "Active", "Next run in");
      await cluster.expectRow(frame, "e2e-suspended", "e2e-single", "@daily", "Suspended", "no backup will be taken");
      await cluster.captureScreenshot(frame, "scheduled-backups-dark");
    },
    TIMEOUT,
  );

  it(
    "links a schedule to the backups it generated, and back (SPEC-0005)",
    async () => {
      await cluster.expectDetails(
        frame,
        "e2e-immediate",
        "Schedule",
        "Active",
        "At 04:30",
        "Backup template",
        "e2e-main",
        "The schedule owns its backups",
        "Generated backups",
        "e2e-immediate-",
        "All backups of this schedule",
      );

      // From the schedule drawer to the generated backup's drawer.
      await tableRowName(frame, "e2e-immediate").click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      await drawer.locator('[data-testid="cnpg-backup-history"]').waitFor({ state: "visible", timeout: 60_000 });
      await cluster.captureScreenshot(frame, "scheduled-backup-drawer-dark");
      await drawer.locator(".TableRow a", { hasText: "e2e-immediate-" }).first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Restore coordinates" })
        .waitFor({ state: "visible", timeout: 60_000 });
      // And back: the backup names its schedule.
      expect(await frame.locator(".Drawer.KubeObjectDetails").innerText()).toContain("e2e-immediate");
      await cluster.captureScreenshot(frame, "backup-drawer-dark");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "shows the backup history of e2e-main in its drawer and leads to its backups (SPEC-0005)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await tableRowName(frame, "e2e-main").click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const history = drawer.locator('[data-testid="cnpg-backup-history"]');

      await history.waitFor({ state: "visible", timeout: 60_000 });
      await history.locator('[data-state="Completed"]').first().waitFor({ state: "visible", timeout: 60_000 });
      expect(await history.locator('[data-testid="cnpg-backup-history-next"]').count()).toBe(1);

      const text = (await drawer.innerText()).replace(/\s+/g, " ");

      expect(text).toContain("Last successful:");
      expect(text).toContain("Next run: in");
      expect(text).toContain("e2e-nightly");
      expect(text).toContain("e2e-immediate");
      await history.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "cluster-drawer-history-dark");

      await drawer.getByText("All backups of this cluster", { exact: false }).click();
      await frame.waitForSelector('h5 >> text="Backups"', { timeout: 60_000 });
      await cluster.expectRow(frame, "e2e-backup-ok", "e2e-main");
      await cluster.expectNoRow(frame, "e2e-backup-failed");

      // Leave the list unfiltered for whoever comes next.
      await frame.locator(".SearchInput input").first().fill("");
      await cluster.expectRow(frame, "e2e-backup-failed", "Failed");
    },
    TIMEOUT,
  );

  it(
    "leads from an Overview tile to the backups of the cluster and to its schedule (SPEC-0005)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame.locator('[data-testid="cnpg-overview-grid"]').waitFor({ state: "visible", timeout: 60_000 });

      // The next backup line opens the drawer of the schedule behind it.
      await frame.locator('[data-testid="cnpg-overview-door-schedule-cnpg-e2e-e2e-main"]').click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Backup template" });

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      expect(await drawer.innerText()).toContain("e2e-main");
      await cluster.closeDetails(frame);

      // The backup line opens the Backups list filtered to the cluster.
      await frame.locator('[data-testid="cnpg-overview-door-backups-cnpg-e2e-e2e-main"]').click();
      await frame.waitForSelector('h5 >> text="Backups"', { timeout: 60_000 });
      await cluster.expectRow(frame, "e2e-backup-ok", "e2e-main");
      await cluster.expectNoRow(frame, "e2e-backup-failed");
      await frame.locator(".SearchInput input").first().fill("");
      await cluster.expectRow(frame, "e2e-backup-failed", "Failed");

      // The rest of the tile still opens the cluster drawer.
      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame
        .locator('[data-testid="cnpg-overview-tile-cnpg-e2e-e2e-single"]')
        .click({ position: { x: 12, y: 60 } });
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Certificates" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "activated without errors",
    async () => {
      expect(errorCollector.errors()).toEqual([]);
    },
    TIMEOUT,
  );
});
