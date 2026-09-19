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
import * as checks from "../helpers/cnpg-design-checks";
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

/** Reads a value until it satisfies the predicate: the live view fills in as the instances answer. */
async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();

  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await read();
  }

  return value;
}

/** The visible text of the dock terminal, whitespace dropped: xterm's DOM renderer splits and pads the rows. */
async function terminalText(frame: Frame): Promise<string> {
  const rows = frame.locator(".xterm-rows:visible").last();

  return ((await rows.innerText().catch(() => "")) ?? "").replace(/\s+/g, "");
}

/** Types a line into the dock terminal: xterm keeps the keyboard in a hidden textarea, so the screen is clicked first. */
async function typeInTerminal(frame: Frame, line: string): Promise<void> {
  await frame.locator(".xterm-screen:visible").last().click();
  await frame.page().keyboard.type(line);
  await frame.page().keyboard.press("Enter");
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

        // The Live View (SPEC-0006) on the light theme.
        await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
        await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]').click();
        await frame.locator('[data-testid="cnpg-live-sessions-total"]').waitFor({ state: "visible", timeout: 90_000 });
        await cluster.captureScreenshot(frame, "live-main-light");
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

      // The next backup line tells a time to come, and opens the drawer of the schedule behind it.
      const nextBackup = frame.locator('[data-testid="cnpg-overview-door-schedule-cnpg-e2e-e2e-main"]');

      expect(await nextBackup.innerText()).toMatch(/next backup in \d+[smhd]/);
      await nextBackup.click();

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
    "shows the replication topology and the live tiles of e2e-main (SPEC-0006)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
      await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]').click();

      const topology = frame.locator('[data-testid="cnpg-live-topology"]');

      await topology.waitFor({ state: "visible", timeout: 60_000 });

      // The instance that says it is the primary is the one the cluster status names.
      const declaredPrimary = cluster.kubectlField(
        "clusters.postgresql.cnpg.io",
        "e2e-main",
        "{.status.currentPrimary}",
      );
      const primaryCard = topology.locator('[data-role="primary"]');

      await primaryCard.waitFor({ state: "visible", timeout: 60_000 });
      expect(await primaryCard.getAttribute("data-testid")).toBe(`cnpg-live-instance-${declaredPrimary}`);
      expect(await primaryCard.innerText()).toMatch(/LSN [0-9A-F]+\/[0-9A-F]+/);
      expect(
        await waitUntil(
          () => topology.locator('[data-role="standby"]').count(),
          (count) => count === 2,
        ),
      ).toBe(2);

      // One edge per standby, streaming, with a lag figure.
      const edges = topology.locator('[data-testid^="cnpg-live-edge-"]');

      expect(
        await waitUntil(
          () => edges.count(),
          (count) => count === 2,
        ),
      ).toBe(2);
      for (const text of await edges.allInnerTexts()) {
        expect(text).toMatch(/async|sync|quorum|potential/);
        expect(text).toMatch(/lag \d/);
      }

      // The tiles fed by the metrics exporter and by the status of the primary.
      const total = frame.locator('[data-testid="cnpg-live-sessions-total"]');

      await total.waitFor({ state: "visible", timeout: 90_000 });
      expect(Number((await total.innerText()).replace(/,/g, ""))).toBeGreaterThanOrEqual(1);

      const databases = await frame.locator('[data-testid="cnpg-live-databases"]').innerText();

      expect(databases).toContain("app");
      expect(databases).toContain("postgres");
      expect(await frame.locator('[data-testid="cnpg-live-wal-state"]').innerText()).toBe("Archiving");
      expect(await frame.locator('[data-testid="cnpg-live-wal"]').innerText()).toMatch(/[0-9A-F]{24}/);

      const slots = await frame.locator('[data-testid="cnpg-live-slots"]').innerText();

      expect(slots).toContain("_cnpg_e2e_main_2");
      expect(slots).toContain("_cnpg_e2e_main_3");
      expect(await frame.locator('[data-testid="cnpg-live-manager"]').innerText()).toContain("1.30.0");
      expect(await frame.locator('[data-testid="cnpg-live-last-read"]').innerText()).toContain("last read");
      await cluster.captureScreenshot(frame, "live-main-dark");
      await frame.locator('[data-testid="cnpg-live-tiles"]').scrollIntoViewIfNeeded();
      await frame.locator('[data-testid="cnpg-live-manager"]').scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "live-main-tiles-dark");
    },
    TIMEOUT,
  );

  it(
    "reads a TLS metrics endpoint and says that the archive of e2e-single is failing (SPEC-0006)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
      await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-single"]').click();

      const state = frame.locator('[data-testid="cnpg-live-wal-state"]');

      await state.waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await waitUntil(
          () => state.innerText(),
          (text) => text === "Failing",
        ),
      ).toBe("Failing");
      await frame.locator('[data-testid="cnpg-live-sessions-total"]').waitFor({ state: "visible", timeout: 90_000 });
      expect(await frame.locator('[data-testid="cnpg-live-topology"]').innerText()).toContain("A single instance");
      await cluster.captureScreenshot(frame, "live-single-dark");
    },
    TIMEOUT,
  );

  it(
    "issues no request for a hibernated cluster and draws a fenced instance with what it says (SPEC-0006)",
    async () => {
      const proxied: string[] = [];
      const record = (request: { url(): string }) => {
        if (request.url().includes("/proxy/")) proxied.push(request.url());
      };

      window.on("request", record);
      try {
        await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
        await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-hibernated"]').click();
        await frame.locator('[data-testid="cnpg-live-hibernated"]').waitFor({ state: "visible", timeout: 60_000 });
        await frame.waitForTimeout(6000);
        expect(proxied.filter((url) => url.includes("e2e-hibernated"))).toEqual([]);
      } finally {
        window.off("request", record);
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
      await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-fenced"]').click();

      const fenced = frame.locator('[data-testid="cnpg-live-instance-e2e-fenced-1"]');

      await fenced.waitFor({ state: "visible", timeout: 60_000 });
      const downSentence = "PostgreSQL does not answer on this instance (fenced)";

      expect(
        await waitUntil(
          () => fenced.innerText(),
          (text) => text.includes(downSentence),
        ),
      ).toContain(downSentence);
      // The page stays alive around the instance that is down.
      expect(await frame.locator('[data-testid="cnpg-live-tiles"]').count()).toBe(1);
      await cluster.captureScreenshot(frame, "live-fenced-dark");
    },
    TIMEOUT,
  );

  it(
    "opens the Live View of a cluster from its drawer, its row menu and its Overview tile (SPEC-0006)",
    async () => {
      const landedOnMain = async () => {
        await frame
          .locator('[data-testid="cnpg-live-instance-e2e-main-1"]')
          .waitFor({ state: "visible", timeout: 60_000 });
      };

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await tableRowName(frame, "e2e-main").click();
      await frame.locator('[data-testid="cnpg-cluster-live-view-link"]').click();
      await landedOnMain();

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.openRowMenu(frame, "e2e-main");
      await frame.locator(".Menu").getByText("Live view", { exact: true }).click();
      await landedOnMain();

      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame.locator('[data-testid="cnpg-overview-door-live-cnpg-e2e-e2e-main"]').click();
      await landedOnMain();
    },
    TIMEOUT,
  );

  it(
    "opens psql on the primary from the row menu and on a standby from the drawer (SPEC-0007)",
    async () => {
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
      const standby = ["e2e-main-1", "e2e-main-2", "e2e-main-3"].find((name) => name !== primary) as string;

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);

      // A hibernated cluster has no instance to connect to: the entry says so instead of vanishing.
      await cluster.openRowMenu(frame, "e2e-hibernated");

      const refused = frame.locator(".Menu .MenuItem", { hasText: "Open psql" }).first();

      await refused.waitFor({ state: "visible", timeout: 60_000 });
      expect(await refused.getAttribute("class")).toContain("disabled");
      expect(await refused.getAttribute("title")).toContain("The cluster is hibernated");
      await cluster.closeRowMenu(frame);

      // The primary, from the row menu.
      await cluster.openRowMenu(frame, "e2e-main");
      await frame.locator(".Menu .MenuItem", { hasText: "Open psql" }).first().click();
      await frame
        .locator(".Dock .Tab", { hasText: `psql: ${primary}` })
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await waitUntil(
          () => terminalText(frame),
          (text) => text.includes("postgres=#"),
          90_000,
        ),
      ).toContain("postgres=#");
      await typeInTerminal(frame, "select 'recovery:' || pg_is_in_recovery();");
      expect(
        await waitUntil(
          () => terminalText(frame),
          (text) => text.includes("recovery:false"),
          60_000,
        ),
      ).toContain("recovery:false");
      await cluster.captureScreenshot(frame, "psql-primary-dark");
      await typeInTerminal(frame, "\\q");

      // A standby, by name, from the Instances table of the drawer: a read-only session.
      await tableRowName(frame, "e2e-main").click();

      const button = frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-psql-${standby}"]`);

      await button.waitFor({ state: "visible", timeout: 60_000 });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await frame
        .locator(".Dock .Tab", { hasText: `psql: ${standby}` })
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      // The drawer covers the dock: it goes away before the terminal is typed into.
      await cluster.closeDetails(frame);
      expect(
        await waitUntil(
          () => terminalText(frame),
          (text) => text.includes("postgres=#"),
          90_000,
        ),
      ).toContain("postgres=#");
      await typeInTerminal(frame, "select 'recovery:' || pg_is_in_recovery();");
      expect(
        await waitUntil(
          () => terminalText(frame),
          (text) => text.includes("recovery:true"),
          60_000,
        ),
      ).toContain("recovery:true");
      await typeInTerminal(frame, "\\q");
    },
    TIMEOUT,
  );

  it(
    "keeps the rules of DESIGN.md on every list and agrees with the instance manager on the LSN (SPEC-0008)",
    async () => {
      // Graduated from the pre-review pass: what it proved once stays proven.
      for (const [menuId, title] of [
        ["cnpg-clusters-clusters", "PostgreSQL Clusters"],
        ["cnpg-backups-backups", "Backups"],
        ["cnpg-backups-scheduledbackups", "Scheduled Backups"],
      ] as const) {
        await cluster.openCnpgPage(frame, menuId, title);
        await frame.locator(".TableRow:not(.TableHead)").first().waitFor({ state: "visible", timeout: 60_000 });
        await checks.expectColumnGrammar(frame, title);
        await checks.expectNoEmptyCells(frame, title);
        await checks.expectNoNestedLinks(frame, title);
        await checks.expectNoAuthoredColors(frame, title);
      }

      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame.locator('[data-testid="cnpg-overview-grid"]').waitFor({ state: "visible", timeout: 60_000 });
      await checks.expectNoNestedLinks(frame, "Overview");
      await checks.expectNoAuthoredColors(frame, "Overview");

      // The write position only grows: what the live view shows for the primary
      // lies between two answers of the instance manager taken around it.
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");

      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");

      const door = frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]');

      if ((await door.count()) > 0) await door.click();

      const card = frame.locator(`[data-testid="cnpg-live-instance-${primary}"][data-role="primary"]`);

      await card.waitFor({ state: "visible", timeout: 60_000 });
      await checks.expectNoNestedLinks(frame, "Live View");
      await checks.expectNoAuthoredColors(frame, "Live View");

      const read = async () =>
        (
          JSON.parse(
            (await fetchFromClusterFrame(frame, podProxyPath(primary, "https", 8000, "/pg/status"))).body,
          ) as InstanceManagerStatus
        ).currentLsn as string;
      const before = await read();

      await frame.waitForTimeout(6000);

      const shown = /LSN\s+([0-9A-F]+\/[0-9A-F]+)/.exec(await card.innerText())?.[1] ?? "";
      const after = await read();

      checks.expectLsnBetween(shown, before, after);
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
