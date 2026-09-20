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

/**
 * Types a line into the dock terminal: xterm keeps the keyboard in a hidden
 * textarea, so the screen is clicked first. On a slow runner the first key
 * after the click was seen to get lost ("elect" for "select"): the focus gets
 * a moment to settle, the keys go one at a time, and the line starts with a
 * space, which both psql and the shell ignore, so a lost first key costs nothing.
 */
async function typeInTerminal(frame: Frame, line: string): Promise<void> {
  await frame.locator(".xterm-screen:visible").last().click();
  await frame.waitForTimeout(500);
  await frame.page().keyboard.type(` ${line}`, { delay: 20 });
  await frame.page().keyboard.press("Enter");
}

/** Closes the dock tabs whose title starts with the given text, so they do not cover the views that follow. */
async function closeDockTabs(frame: Frame, title: string): Promise<void> {
  const tabs = frame.locator(".Dock .Tab", { hasText: title });

  for (let guard = 0; guard < 10 && (await tabs.count()) > 0; guard += 1) {
    const tab = tabs.first();

    await tab.hover();
    await tab.locator(".Icon").last().click();
    await frame.waitForTimeout(500);
  }
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
      // The declared objects PostgreSQL does not have as declared (SPEC-0013): three databases, one role and
      // one publication on e2e-main, one role and one subscription on e2e-single.
      // Their stores fill in after the clusters: the figure is read until it settles.
      expect(
        await waitUntil(
          () => frame.locator('[data-testid="cnpg-stat-declared"]').innerText(),
          (text) => text.includes("7"),
        ),
      ).toContain("7");
      expect(await frame.locator('[data-testid="cnpg-overview-declared-cnpg-e2e-e2e-main"]').innerText()).toBe(
        "5 declared objects failed",
      );
      expect(await frame.locator('[data-testid="cnpg-overview-declared-cnpg-e2e-e2e-single"]').innerText()).toBe(
        "2 declared objects failed",
      );

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
      await closeDockTabs(frame, "psql:");
      expect(await frame.locator(".Dock .Tab", { hasText: "psql:" }).count()).toBe(0);

      // The dock falls back to its own Terminal tab, open: it is folded away so
      // that it does not cover half of every view that follows.
      const fold = frame.locator('.Dock .Icon:has([data-icon-name="keyboard_arrow_down"])').first();

      if ((await fold.count()) > 0) await fold.click();
    },
    TIMEOUT,
  );

  it(
    "lists the object stores with their writers and shows the recovery window the plugin reports (SPEC-0009)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
      await cluster.selectNamespace(frame);

      await cluster.expectRow(frame, "e2e-store", "S3 compatible", "s3://backups/", "In use", "e2e-main");
      await cluster.expectRow(frame, "e2e-store-broken", "Failing", "The last backup failed for e2e-single");
      await cluster.captureScreenshot(frame, "object-stores-dark");

      // What the drawer says about e2e-main is what the plugin wrote in the status of the store.
      const first = cluster.kubectlField(
        "objectstores.barmancloud.cnpg.io",
        "e2e-store",
        "{.status.serverRecoveryWindow.e2e-main.firstRecoverabilityPoint}",
      );

      expect(first).not.toBe("");
      await cluster.expectDetails(
        frame,
        "e2e-store",
        "Store",
        "In use",
        "S3 compatible",
        "http://minio.cnpg-e2e.svc:9000",
        "Credentials",
        "e2e-store-creds",
        "ACCESS_KEY_ID",
        "WAL and data",
        "gzip",
        "Recovery windows",
        "Protected",
        "Clusters",
        "WAL and backups",
        "e2e-main",
      );
      await tableRowName(frame, "e2e-store").click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Recovery windows" });

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      await drawer.getByText("Recovery windows").scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "object-store-drawer-dark");

      const shown = (await drawer.locator(".TableRow", { hasText: "e2e-main" }).first().innerText()).replace(
        /\s+/g,
        " ",
      );

      // The row tells the times as relative ones (the exact time is in the tooltip); the exact
      // first recoverability point is compared with the plugin's in the Cluster drawer below.
      expect(shown).toMatch(/e2e-main .*ago .*Protected/);
      // The secret is a link by name: the drawer never shows a value.
      expect(await drawer.innerText()).not.toContain("e2e-minio-secret-1");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "leads from a backup and from a cluster to their object store (SPEC-0009)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-backups-backups", "Backups");
      await tableRowName(frame, "e2e-backup-ok").click();

      const backupDrawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Destination" });

      await backupDrawer.waitFor({ state: "visible", timeout: 60_000 });
      await backupDrawer.locator("a", { hasText: "e2e-store" }).first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Recovery windows" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-main").click();

      const clusterDrawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Backups and archiving" });

      await clusterDrawer.waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await waitUntil(
          async () => (await clusterDrawer.innerText()).replace(/\s+/g, " "),
          (text) => text.includes("as the Barman Cloud plugin reports it"),
        ),
      ).toContain("as the Barman Cloud plugin reports it");

      // The point the drawer shows is the one the plugin wrote in the status of the store.
      const reported = cluster.kubectlField(
        "objectstores.barmancloud.cnpg.io",
        "e2e-store",
        "{.status.serverRecoveryWindow.e2e-main.firstRecoverabilityPoint}",
      );
      const row = clusterDrawer.locator(".DrawerItem", { hasText: "First recoverability point" }).first();
      const shownPoint = /\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?/.exec(await row.innerText())?.[0] ?? "";

      expect(Math.abs(Date.parse(shownPoint) - Date.parse(reported))).toBeLessThan(1000);
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "lists the image catalogs and tells which clusters follow them (SPEC-0010)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-images-imagecatalogs", "Image Catalogs");
      await cluster.selectNamespace(frame);
      await cluster.expectRow(frame, "e2e-images", "18, 17", "18.4-system-trixie", "In use", "1 cluster");
      await cluster.captureScreenshot(frame, "image-catalogs-dark");

      await cluster.expectDetails(
        frame,
        "e2e-images",
        "Catalog",
        "In use",
        "The namespace cnpg-e2e",
        "Images",
        "postgresql:17.6-system-trixie",
        "postgresql:18.4-system-trixie",
        "Clusters",
        "e2e-hibernated",
        "Aligned",
      );
      await tableRowName(frame, "e2e-images").click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Clusters" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.captureScreenshot(frame, "image-catalog-drawer-dark");
      await cluster.closeDetails(frame);

      // The cluster scoped kind: no namespace, nobody follows it.
      await cluster.openCnpgPage(frame, "cnpg-images-clusterimagecatalogs", "Cluster Image Catalogs");
      await cluster.expectRow(frame, "e2e-cluster-images", "18", "Unused", "No cluster takes its image from here");
      await checks.expectColumnGrammar(frame, "Cluster Image Catalogs", { namespaced: false });
      await cluster.expectDetails(
        frame,
        "e2e-cluster-images",
        "The whole Kubernetes cluster",
        "No cluster takes its image",
      );

      // From the cluster that follows the catalog to the catalog.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-hibernated").click();

      const clusterDrawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Image catalog" });

      await clusterDrawer.waitFor({ state: "visible", timeout: 60_000 });
      await clusterDrawer.locator("a", { hasText: "e2e-images" }).first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "The namespace cnpg-e2e" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "tells whether a failover could be decided safely, from the quorum of e2e-main (SPEC-0011)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-failoverquorums", "Failover Quorums");
      await cluster.selectNamespace(frame);
      await cluster.expectRow(frame, "e2e-main", "ANY", "2/2", "Safe", "A failover could be decided safely");
      await cluster.captureScreenshot(frame, "failover-quorums-dark");

      const writtenBy = cluster.kubectlField("failoverquorums.postgresql.cnpg.io", "e2e-main", "{.status.primary}");

      await cluster.expectDetails(
        frame,
        "e2e-main",
        "Quorum",
        "Safe",
        "ANY: any of the named standbys",
        "Must confirm",
        "Written by",
        writtenBy,
        "R + W is greater than N",
        "Standbys",
      );
      await tableRowName(frame, "e2e-main").click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Standbys" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.captureScreenshot(frame, "failover-quorum-drawer-dark");
      await cluster.closeDetails(frame);

      // The cluster leads to its quorum, and its live view labels the edges with the sync state.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-main").click();

      const clusterDrawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Failover quorum" });

      await clusterDrawer.waitFor({ state: "visible", timeout: 60_000 });
      await clusterDrawer.locator(".DrawerItem", { hasText: "Failover quorum" }).locator("a").first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "How to read it" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");

      const door = frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]');

      if ((await door.count()) > 0) await door.click();

      const edges = frame.locator('[data-testid^="cnpg-live-edge-"]');

      expect(
        await waitUntil(
          () => edges.count(),
          (count) => count === 2,
        ),
      ).toBe(2);
      for (const text of await edges.allInnerTexts()) {
        expect(text).toContain("quorum");
      }
    },
    TIMEOUT,
  );

  it(
    "lists the poolers and reads what PgBouncer is doing right now through the pod proxy (SPEC-0012)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-pooling-poolers", "Poolers");
      await cluster.selectNamespace(frame);
      await cluster.expectRow(frame, "e2e-main-pooler", "e2e-main", "rw (primary)", "session", "1/1", "Active");
      await cluster.captureScreenshot(frame, "poolers-dark");

      await cluster.expectDetails(
        frame,
        "e2e-main-pooler",
        "Pooler",
        "Active",
        "rw (primary)",
        "e2e-main-pooler.cnpg-e2e.svc",
        "session: a server connection for the length of a client session",
        "Right now",
        "PgBouncer parameters",
        "max_client_conn",
        "default_pool_size",
        "Pods, service and secrets",
      );

      // The live section: read from the exporter of the pooler pod, whoever is connected through it.
      await tableRowName(frame, "e2e-main-pooler").click();

      const live = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-pooler-live"]');

      await live.waitFor({ state: "visible", timeout: 90_000 });
      expect(await live.innerText()).toContain("every 15 s from 1 pod");

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const text = (await drawer.innerText()).replace(/\s+/g, " ");

      expect(text).toMatch(/Clients \d+ active, \d+ waiting for a server connection, \d+ free/);
      expect(text).toMatch(/Servers \d+ active, \d+ idle/);
      await live.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "pooler-drawer-dark");
      await cluster.closeDetails(frame);

      // The cluster and its live view lead to the pooler.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-main").click();

      const clusterDrawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Poolers" });

      await clusterDrawer.waitFor({ state: "visible", timeout: 60_000 });
      await clusterDrawer.locator(".DrawerItem", { hasText: "Poolers" }).locator("a").first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Right now" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");

      const door = frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]');

      if ((await door.count()) > 0) await door.click();

      const chips = frame.locator('[data-testid="cnpg-live-poolers"]');

      await chips.waitFor({ state: "visible", timeout: 60_000 });
      expect(await chips.innerText()).toContain("e2e-main-pooler");
      await chips.locator("a", { hasText: "e2e-main-pooler" }).first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Right now" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "lists the declared databases with the reason of each condition and reads a database from the primary (SPEC-0013)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
      await cluster.selectNamespace(frame);

      // One fixture per state the list tells apart.
      await cluster.expectRow(frame, "e2e-db-inventory", "e2e-main", "inventory", "app", "2", "retain", "Applied");
      await cluster.expectRow(frame, "e2e-db-absent", "legacy", "Absent", "Absent as declared");
      await cluster.expectRow(frame, "e2e-db-no-owner", "orders", "Failed", 'role "e2e_nobody" does not exist');
      await cluster.expectRow(
        frame,
        "e2e-db-bad-extension",
        "analytics",
        "delete",
        "Failed",
        'Extension "e2e_no_such_extension" failed',
      );
      await cluster.expectRow(
        frame,
        "e2e-db-inventory-again",
        "Failed",
        'the object "e2e-db-inventory" already manages the same database',
      );
      await cluster.expectRow(frame, "e2e-db-hibernated", "e2e-hibernated", "Pending", "the cluster is hibernated");
      await cluster.expectRow(frame, "e2e-db-orphan", "e2e-gone", "Orphan", "The Cluster e2e-gone is not there");
      await cluster.captureScreenshot(frame, "databases-dark");

      await cluster.expectDetails(
        frame,
        "e2e-db-inventory",
        "Reconciliation",
        "Applied to PostgreSQL",
        "1, applied",
        "Database",
        "inventory",
        "retain: deleting this object leaves the database in PostgreSQL",
        "Right now",
        "Managed objects",
        "pgcrypto",
        "stock",
        "owner app",
      );

      // The live block: the size of the database, read from the exporter of the primary.
      await tableRowName(frame, "e2e-db-inventory").click();

      const live = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-database-live"]');

      await live.waitFor({ state: "visible", timeout: 90_000 });
      expect(await live.innerText()).toContain("every 30 s from the primary, e2e-main-");
      expect(await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-database-size"]').innerText()).toMatch(
        /^\d+(\.\d+)? (KiB|MiB|GiB)$/,
      );
      await frame.locator(".Drawer.KubeObjectDetails .Table").last().scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "database-drawer-dark");
      await cluster.closeDetails(frame);

      // The failed object says which part failed; the conflict links its rival.
      await cluster.expectDetails(
        frame,
        "e2e-db-bad-extension",
        'Extension "e2e_no_such_extension" failed',
        "delete: deleting this object drops the database from PostgreSQL",
        "Managed objects",
        "is not available",
        "reports",
      );
      await tableRowName(frame, "e2e-db-inventory-again").click();

      const rivals = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-declarative-rivals"]');

      await rivals.waitFor({ state: "visible", timeout: 60_000 });
      await rivals.locator("a", { hasText: "e2e-db-inventory" }).first().click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Managed objects" })
        .waitFor({ state: "visible", timeout: 60_000 });
      await cluster.closeDetails(frame);

      // The cluster counts what is declared inside it and leads to the filtered list.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-main").click();

      const counts = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-databases"]');

      await counts.waitFor({ state: "visible", timeout: 60_000 });
      expect(await counts.innerText()).toBe("2 applied, 3 failed");
      await counts.click();
      await cluster.expectRow(frame, "e2e-db-inventory", "Applied");
      await cluster.expectNoRow(frame, "e2e-db-hibernated");
      await frame.locator(".SearchInput input").first().fill("");
    },
    TIMEOUT,
  );

  it(
    "lists the declared roles with what they may do, how they authenticate and the traps of role management (SPEC-0014)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-databases-databaseroles", "Database Roles");
      await cluster.selectNamespace(frame);

      await cluster.expectRow(
        frame,
        "e2e-role-reporting",
        "e2e-main",
        "reporting",
        "Login",
        "pg_monitor",
        "in 8 years",
        "Applied",
      );
      await cluster.expectRow(
        frame,
        "e2e-role-contractor",
        "Login, Create database",
        "Applied",
        "the password expired",
      );
      await cluster.expectRow(
        frame,
        "e2e-role-batch",
        "None (a group role)",
        "Failed",
        '"e2e_no_such_group" does not exist',
      );
      await cluster.expectRow(frame, "e2e-role-inline-rival", "e2e-single", "Failed", "the cluster spec wins");
      await cluster.expectRow(frame, "e2e-main-app", "app", "Login, Replication", "Never", "Applied");
      await cluster.captureScreenshot(frame, "database-roles-dark");

      await cluster.expectDetails(
        frame,
        "e2e-role-reporting",
        "Reconciliation",
        "Applied to PostgreSQL",
        "Role",
        "Read-only reporting",
        "pg_monitor",
        "retain: deleting this object leaves the role in PostgreSQL",
        "Authentication",
        "e2e-role-reporting-password",
        "Client certificate",
        "e2e-role-reporting-client-cert",
      );

      // The certificate the operator issued, with its expiry; both Secrets are links, never opened.
      await tableRowName(frame, "e2e-role-reporting").click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Authentication" });

      await drawer.waitFor({ state: "visible", timeout: 60_000 });
      expect((await drawer.innerText()).replace(/\s+/g, " ")).toMatch(/Client certificate Expires in \d+d/);
      expect(await drawer.locator("a", { hasText: "e2e-role-reporting-client-cert" }).count()).toBeGreaterThan(0);
      expect(await drawer.locator("a", { hasText: "e2e-role-reporting-password" }).count()).toBeGreaterThan(0);
      await drawer.locator(".DrawerItem", { hasText: "Certificate expires" }).scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "database-role-drawer-dark");
      await cluster.closeDetails(frame);

      // The conflict with the cluster spec, told in words on the object that loses.
      await tableRowName(frame, "e2e-role-inline-rival").click();

      const rival = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-role-inline-rival"]');

      await rival.waitFor({ state: "visible", timeout: 60_000 });
      expect(await rival.innerText()).toContain("The cluster declares the role e2e_inline in managed.roles");
      await cluster.closeDetails(frame);

      // The cluster shows its inline roles, the one the operator cannot reconcile with its reason.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-single").click();

      const inline = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-inline-roles"]');

      await inline.waitFor({ state: "visible", timeout: 60_000 });

      const inlineText = (await inline.innerText()).replace(/\s+/g, " ");

      expect(inlineText).toContain("e2e_inline_stuck cannot be reconciled");
      expect(inlineText).toContain('role "e2e_no_such_group" does not exist');
      expect(inlineText).toMatch(/e2e_inline reconciled/);
      expect(
        await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-database-roles"]').innerText(),
      ).toBe("1 failed");
      await inline.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "cluster-declarative-dark");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "reads a logical replication as one path, with the slot on the publisher and the failover caveat (SPEC-0015)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-databases-publications", "Publications");
      await cluster.selectNamespace(frame);
      await cluster.expectRow(
        frame,
        "e2e-pub-numbers",
        "e2e-main",
        "app",
        "e2e_numbers_pub",
        "1 table",
        "e2e-sub-numbers",
        "Applied",
      );
      await cluster.expectRow(frame, "e2e-pub-all", "e2e_all_pub", "All tables", "None here", "Applied");
      await cluster.expectRow(frame, "e2e-pub-missing-table", "Failed", 'relation "e2e_no_such_table" does not exist');
      await cluster.captureScreenshot(frame, "publications-dark");

      await cluster.expectDetails(
        frame,
        "e2e-pub-numbers",
        "Reconciliation",
        "Applied to PostgreSQL",
        "Publication",
        "e2e_numbers_pub",
        "public.e2e_numbers",
        "columns i, m",
        "Subscriptions",
        "row changes",
        "e2e-sub-numbers",
        "Publisher failover",
        "Right now",
      );

      // The slots of the database, read from the primary: the one of the subscription is being consumed.
      await tableRowName(frame, "e2e-pub-numbers").click();

      const publicationLive = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-publication-live"]');

      await publicationLive.waitFor({ state: "visible", timeout: 90_000 });

      const slots = frame.locator(".Drawer.KubeObjectDetails .TableRow", { hasText: "e2e_numbers_sub" });

      await slots.first().waitFor({ state: "visible", timeout: 60_000 });
      expect(await slots.first().locator("a", { hasText: "e2e-sub-numbers" }).count()).toBe(1);
      await publicationLive.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "publication-drawer-dark");
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
      await cluster.selectNamespace(frame);
      await cluster.expectRow(
        frame,
        "e2e-sub-numbers",
        "e2e-single",
        "app",
        "e2e_numbers_sub",
        "e2e-main",
        "e2e_numbers_pub",
        "Applied",
      );
      await cluster.expectRow(
        frame,
        "e2e-sub-no-publisher",
        "e2e-nowhere",
        "Failed",
        "externalCluster 'e2e-nowhere' not declared",
      );
      await cluster.captureScreenshot(frame, "subscriptions-dark");

      await tableRowName(frame, "e2e-sub-numbers").click();

      const path = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-replication-path"]');

      await path.waitFor({ state: "visible", timeout: 60_000 });

      const pathText = (await path.innerText()).replace(/\s+/g, " ");

      expect(pathText).toMatch(/PUBLISHER e2e-main database app publication e2e-pub-numbers/i);
      expect(pathText).toMatch(/SUBSCRIBER e2e-single database app subscription e2e_numbers_sub/i);
      expect(await path.locator("a", { hasText: "e2e-pub-numbers" }).count()).toBe(1);

      // e2e-main has three instances and does not synchronize its logical slots.
      expect(
        await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-subscription-failover"]').innerText(),
      ).toContain("e2e-main does not synchronize its logical slots to the standbys");

      // The slot on the publisher, read through the pod proxy of its primary.
      const live = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-subscription-live"]');

      await live.waitFor({ state: "visible", timeout: 90_000 });
      expect(await live.innerText()).toContain("from the primary, e2e-main-");
      expect(
        await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-subscription-slot-active"]').innerText(),
      ).toBe("True");
      await path.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "subscription-drawer-dark");
      await cluster.closeDetails(frame);

      // The one the operator fails says why on its own terms too.
      await cluster.expectDetails(
        frame,
        "e2e-sub-no-publisher",
        "The cluster e2e-single declares no external cluster named e2e-nowhere",
      );

      // The cluster counts its publications.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-main").click();

      const counts = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-publications"]');

      await counts.waitFor({ state: "visible", timeout: 60_000 });
      expect(await counts.innerText()).toBe("2 applied, 1 failed");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "shows who holds the primary lease of a cluster and that a hibernated cluster released it (SPEC-0019)",
    async () => {
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await tableRowName(frame, "e2e-main").click();

      const badge = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-primary-lease"]');

      await badge.waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await waitUntil(
          () => badge.innerText(),
          (text) => text.trim() === "Held",
        ),
      ).toBe("Held");
      expect(
        await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-primary-lease-status"]').innerText(),
      ).toBe(`Held and renewed by the primary, ${primary}`);

      const holder = frame.locator(".Drawer.KubeObjectDetails .DrawerItem", { hasText: "Lease holder" });

      expect(await holder.locator("a", { hasText: primary }).count()).toBe(1);
      expect(await frame.locator(".Drawer.KubeObjectDetails").innerText()).toContain(
        "holds a promotion back for up to 15 s",
      );
      await badge.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "cluster-drawer-lease-dark");
      await cluster.closeDetails(frame);

      await tableRowName(frame, "e2e-hibernated").click();
      expect(
        await waitUntil(
          () =>
            frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-primary-lease-status"]').innerText(),
          (text) => text.startsWith("Released"),
        ),
      ).toBe("Released: the cluster is hibernated, nobody is primary");
      await cluster.closeDetails(frame);
    },
    TIMEOUT,
  );

  it(
    "turns the JSON logs of the instances into rows on one time axis and filters them (SPEC-0018)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-logs", "Logs");

      const door = frame.locator('[data-testid="cnpg-logs-door-cnpg-e2e-e2e-main"]');

      if ((await door.count()) > 0) await door.click();

      const viewport = frame.locator('[data-testid="cnpg-logs-viewport"]');

      await viewport.waitFor({ state: "visible", timeout: 60_000 });

      const rows = frame.locator('[data-testid="cnpg-log-row"]');

      await rows.first().waitFor({ state: "visible", timeout: 90_000 });

      // Rows, not JSON: who said it and how serious it is, from more than one instance.
      const pods = await waitUntil(
        async () => new Set(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-pod")))),
        (seen) => seen.size >= 2,
        90_000,
      );

      expect(pods.size).toBeGreaterThanOrEqual(2);

      const sources = new Set(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-source"))));

      expect(sources.has("PostgreSQL")).toBe(true);
      expect(sources.has("Instance manager")).toBe(true);
      expect(await rows.first().innerText()).not.toContain('{"level"');
      expect(await frame.locator('[data-testid="cnpg-logs-status"]').innerText()).toContain("following every 3 s");
      await cluster.captureScreenshot(frame, "logs-dark");

      // A row opens on its raw JSON.
      await rows.last().click();
      await frame.locator('[data-testid="cnpg-log-row"] pre').first().waitFor({ state: "visible", timeout: 30_000 });
      await rows.last().click();

      // The instance chips narrow the axis to one instance.
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");

      await frame.locator(`[data-testid="cnpg-logs-instance-${primary}"]`).click();
      expect(
        await waitUntil(
          async () => new Set(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-pod")))),
          (seen) => seen.size === 1,
        ),
      ).toEqual(new Set([primary]));

      // The broken store of e2e-single makes its WAL archiving fail: on Errors only error rows stay, and they say so.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-single").click();

      const instanceDoor = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-instance-logs-e2e-single-1"]');

      await instanceDoor.waitFor({ state: "visible", timeout: 60_000 });
      await instanceDoor.click();
      await viewport.waitFor({ state: "visible", timeout: 60_000 });
      await rows.first().waitFor({ state: "visible", timeout: 90_000 });
      await frame.locator("#cnpg-logs-level").click();
      await frame
        .locator(".Select__option", { hasText: /^Errors/ })
        .first()
        .click();

      const levels = await waitUntil(
        async () => new Set(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-level")))),
        (seen) => seen.size === 1 && seen.has("error"),
        90_000,
      );

      expect(levels).toEqual(new Set(["error"]));
      expect(
        await rows.evaluateAll((items) => items.some((item) => item.getAttribute("data-source") === "WAL archiving")),
      ).toBe(true);
      await cluster.captureScreenshot(frame, "logs-errors-dark");
    },
    TIMEOUT,
  );

  it(
    "puts the events, the backups, the primary and what is scheduled of a cluster on one time axis (SPEC-0017)",
    async () => {
      // The door of the Cluster drawer lands on the same cluster.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await tableRowName(frame, "e2e-main").click();

      const door = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-timeline-link"]');

      await door.waitFor({ state: "visible", timeout: 60_000 });
      await door.click();

      const axis = frame.locator('[data-testid="cnpg-timeline-axis"]');

      await axis.waitFor({ state: "visible", timeout: 60_000 });

      const entries = frame.locator('[data-testid="cnpg-timeline-entry"]');
      const texts = async () => (await entries.allInnerTexts()).map((text) => text.replace(/\s+/g, " "));

      // The durable facts: the backup with its outcome, the primary, the lease; what is to come above the now marker.
      const seen = await waitUntil(texts, (all) => all.some((text) => text.includes("Backup e2e-backup-ok completed")));

      expect(seen.some((text) => text.includes("Backup e2e-backup-ok completed"))).toBe(true);
      expect(seen.some((text) => /e2e-main-\d became primary/.test(text))).toBe(true);
      expect(seen.some((text) => /acquired the primary lease/.test(text))).toBe(true);
      // The failed backup belongs to another cluster: it has no place here.
      expect(seen.some((text) => text.includes("e2e-backup-failed"))).toBe(false);

      const future = frame.locator('[data-testid="cnpg-timeline-entry"][data-future="true"]');

      expect(await future.count()).toBeGreaterThan(0);
      // The immediate schedule has run once, so it always knows its next time; a schedule that never ran may not yet.
      expect((await future.allInnerTexts()).join(" ")).toContain("Next backup of e2e-immediate");
      await frame.locator('[data-testid="cnpg-timeline-now"]').waitFor({ state: "visible", timeout: 30_000 });

      // The event cluster-up.sh writes at every bring-up; the API server forgets events after an hour.
      if (cluster.kubectlExists("events", "e2e-main-fixture")) {
        expect(
          (await waitUntil(texts, (all) => all.some((text) => text.includes("E2EFixture")))).some((text) =>
            text.includes("E2EFixture: Cluster e2e-main (x3)"),
          ),
        ).toBe(true);
      }
      await cluster.captureScreenshot(frame, "timeline-dark");

      // The filter on a category hides the rest; "needs attention" keeps warnings and errors only.
      await frame.locator('[data-testid="cnpg-timeline-category-backup"]').click();
      expect(
        new Set(await entries.evaluateAll((items) => items.map((item) => item.getAttribute("data-category")))),
      ).toEqual(new Set(["Backup"]));
      await frame.locator('[data-testid="cnpg-timeline-category-backup"]').click();
      await frame.locator('[data-testid="cnpg-timeline-attention"]').click();

      const levels = new Set(
        await entries.evaluateAll((items) => items.map((item) => item.getAttribute("data-level"))),
      );

      expect([...levels].every((level) => level === "warning" || level === "error")).toBe(true);

      // e2e-single archives to a broken store: its failed backup and its archiving condition are errors on its axis.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await tableRowName(frame, "e2e-single").click();
      await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-timeline-link"]').click();
      await axis.waitFor({ state: "visible", timeout: 60_000 });

      const errors = async () =>
        entries.evaluateAll((items) =>
          items
            .filter((item) => item.getAttribute("data-level") === "error")
            .map((item) => (item.textContent ?? "").replace(/\s+/g, " ")),
        );
      const failed = await waitUntil(errors, (all) => all.some((text) => text.includes("e2e-backup-failed")));

      expect(failed.some((text) => text.includes("Backup e2e-backup-failed failed"))).toBe(true);
      expect(failed.some((text) => text.includes("ContinuousArchiving became False"))).toBe(true);
      await cluster.captureScreenshot(frame, "timeline-errors-dark");
    },
    TIMEOUT,
  );

  it(
    "shows the operator: version, leader, what it watches, its reconciles, the plugin and the kinds (SPEC-0016)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-operator", "Operator");

      const card = frame.locator('[data-testid="cnpg-operator-card"]');

      await card.waitFor({ state: "visible", timeout: 90_000 });

      const leaderPod = cluster
        .kubectlE2E(
          "get",
          "lease",
          "db9c8771.cnpg.io",
          "--namespace",
          "cnpg-system",
          "-o",
          "jsonpath={.spec.holderIdentity}",
        )
        .stdout.split("_")[0];
      const cardText = (await card.innerText()).replace(/\s+/g, " ");

      expect(cardText).toContain("Running");
      expect(cardText).toContain("1 of 1 replicas ready");
      expect(await frame.locator('[data-testid="cnpg-operator-version"]').innerText()).toBe("1.30.0");
      expect(await frame.locator('[data-testid="cnpg-operator-watch"]').innerText()).toBe("All namespaces");
      expect(
        await waitUntil(
          () => frame.locator('[data-testid="cnpg-operator-leader"]').innerText(),
          (text) => text.includes(leaderPod),
        ),
      ).toContain(leaderPod);

      // The reconciles per controller, from the operator's own metrics through the pod proxy.
      const live = frame.locator('[data-testid="cnpg-operator-live"]');

      await live.waitFor({ state: "visible", timeout: 90_000 });
      expect(await live.innerText()).toContain(`every 30 s from ${leaderPod}`);
      await frame
        .locator('[data-testid="cnpg-operator-controller-cluster"]')
        .waitFor({ state: "visible", timeout: 30_000 });

      // The plugin the operator found, with a cluster that loaded it, and the kinds with their views.
      const plugins = (await frame.locator('[data-testid="cnpg-operator-plugins"]').innerText()).replace(/\s+/g, " ");

      expect(plugins).toContain("barman-cloud.cloudnative-pg.io");
      expect(plugins).toContain("cnpg-e2e/e2e-main (0.15.0)");

      const kinds = frame.locator('[data-testid="cnpg-operator-kinds"] .TableRow:not(.TableHead)');

      expect(
        await waitUntil(
          () => kinds.count(),
          (count) => count >= 12,
        ),
      ).toBeGreaterThanOrEqual(12);

      const kindsText = (await frame.locator('[data-testid="cnpg-operator-kinds"]').innerText()).replace(/\s+/g, " ");

      for (const kind of ["Cluster", "DatabaseRole", "FailoverQuorum", "ObjectStore", "Subscription"]) {
        expect(kindsText).toContain(kind);
      }
      await checks.expectNoNestedLinks(frame, "Operator");
      await checks.expectNoAuthoredColors(frame, "Operator");
      await cluster.captureScreenshot(frame, "operator-dark");
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
        ["cnpg-backups-objectstores", "Object Stores"],
        ["cnpg-images-imagecatalogs", "Image Catalogs"],
        ["cnpg-clusters-failoverquorums", "Failover Quorums"],
        ["cnpg-pooling-poolers", "Poolers"],
        ["cnpg-databases-databases", "Databases"],
        ["cnpg-databases-databaseroles", "Database Roles"],
        ["cnpg-databases-publications", "Publications"],
        ["cnpg-databases-subscriptions", "Subscriptions"],
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

  // The write cases (M6) run last and against a cluster of their own, in a
  // namespace of its own: nothing they do changes what the cases above assert.
  it(
    "requests a backup from the row menu, and the cluster has it (SPEC-0020)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");

      // A hibernated cluster: the operator would fail the backup, so the entry says so instead of offering it.
      await cluster.selectNamespace(frame);
      await cluster.openRowMenu(frame, "e2e-hibernated");

      const refused = frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first();

      await refused.waitFor({ state: "visible", timeout: 60_000 });
      expect(await refused.getAttribute("class")).toContain("disabled");
      expect(await refused.getAttribute("title")).toBe(
        "Back up now: The operator fails a backup requested on a hibernated cluster",
      );
      await cluster.closeRowMenu(frame);

      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first().click();

      const dialog = frame.locator('[data-testid="cnpg-backup-now-dialog"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      // W4: the object, the Kubernetes cluster with its context, and the one API call.
      expect(await dialog.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(
        `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${cluster.E2E_ACTIONS_CLUSTER}`,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-context"]').innerText()).toContain(
        cluster.E2E_KUBE_CONTEXT,
      );
      expect(await dialog.locator('[data-testid="cnpg-backup-now-method"]').innerText()).toBe(
        "Plugin barman-cloud.cloudnative-pg.io",
      );

      const name = await dialog.locator('[data-testid="cnpg-backup-now-name"]').inputValue();

      expect(name).toMatch(/^e2e-actions-\d{14}$/);

      const writes = dialog.locator('[data-testid="cnpg-action-writes"] li');

      expect(await writes.count()).toBe(1);
      expect(await writes.first().innerText()).toBe(
        `create Backup ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: cluster e2e-actions, method plugin (barman-cloud.cloudnative-pg.io), label cnpg.io/cluster=e2e-actions`,
      );
      await cluster.captureScreenshot(frame, "backup-now-dialog-dark");

      // W8: nothing exists until the user confirms.
      expect(cluster.kubectlActions("get", "backups.postgresql.cnpg.io", name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Backup ${name}`);

      // W12: read back from the cluster.
      const backup = "backups.postgresql.cnpg.io";

      expect(cluster.kubectlActionsField(backup, name, "{.spec.cluster.name}")).toBe("e2e-actions");
      expect(cluster.kubectlActionsField(backup, name, "{.spec.method}")).toBe("plugin");
      expect(cluster.kubectlActionsField(backup, name, "{.spec.pluginConfiguration.name}")).toBe(
        "barman-cloud.cloudnative-pg.io",
      );
      expect(cluster.kubectlActionsField(backup, name, "{.metadata.labels}")).toBe('{"cnpg.io/cluster":"e2e-actions"}');
      expect(cluster.kubectlActionsField(backup, name, "{.spec.target}")).toBe("");
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(backup, name, "{.status.phase}"),
          (phase) => phase === "completed" || phase === "failed",
          5 * 60_000,
        ),
      ).toBe("completed");

      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
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
