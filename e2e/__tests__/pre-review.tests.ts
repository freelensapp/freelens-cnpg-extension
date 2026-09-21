/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The pre-review agent pass (SPEC-0008), run by `pnpm pre-review` against the
// demo cluster before a human milestone review. It walks every view of the
// extension on both themes, checks the rules of DESIGN.md a machine can check,
// compares what the views say with what the instances say, and writes
// REPORT.md next to the screenshots: what passed, what failed, and what is
// left to human judgment. It is not part of the CI: what it proves for good
// graduates into `cnpg-e2e.tests.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import * as cluster from "../helpers/cnpg-cluster";
import * as checks from "../helpers/cnpg-design-checks";
import * as cnpg from "../helpers/cnpg-extension";
import * as utils from "../helpers/utils";

import type { ElectronApplication, Frame, Page } from "playwright";

const TIMEOUT = 15 * 60 * 1000;
const ARTIFACTS_DIR = process.env.E2E_ARTIFACTS_DIR || path.join(process.cwd(), "e2e-artifacts", "pre-review");
const API_KUBE_PREFIX = "/api-kube";

interface Outcome {
  check: string;
  passed: boolean;
  detail?: string;
}

const HUMAN_JUDGMENT = [
  "Overview: is the tile density right on a laptop screen, and does the order by urgency match what you would look at first?",
  "Backup history strip: does it tell the protection story of a cluster at a glance (gaps, failures, next run)?",
  "Live View: is the topology still readable with more standbys than the fixtures have, and do the tiles answer the first questions of an incident?",
  "Live View against a busy database for ten minutes: do the figures move without flicker, does the page stay responsive?",
  "Live View with a kubeconfig that lacks `pods/proxy`: is the permission panel clear about what to grant?",
  "Open psql on Windows and Linux desktops: does the tab open and reach the prompt (the suites run on macOS locally and on Linux in CI)?",
  'Object Stores: do the recovery windows answer "how far back can I go" at a glance, and is an orphan server clear?',
  "Failover Quorums: is the sentence about R, W and N right for somebody who knows the operator, and clear for somebody who does not?",
  "Poolers: do the live figures next to the parameters explain each other (pool size against clients waiting)?",
  "Databases: does a failed database tell at once which part failed, without opening the YAML?",
  "Database Roles: are the attributes that override every restriction (Superuser, Bypass RLS) visible enough, and is the inline conflict sentence clear about what to do?",
  "Publications and Subscriptions: does the replication path read as one flow, and is the failover caveat worded for somebody who has never lost a slot?",
  "Logs: can you follow an incident from these rows alone (a failing query, a WAL archiving failure), and are the fields on the second line the right ones?",
  "Timeline: does the order of events, backups and changes of primary tell the story of the cluster, and is the block of what is to come worth its space?",
  "Operator: is this what a platform engineer checks first, and does the reconcile table say something at a glance?",
  "Cluster drawer, primary lease: is the sentence about the timings right for somebody who knows the operator, and clear for somebody who does not?",
  "Every view, both themes: is this the best possible view for the task?",
];

function table(frame: Frame, name: string) {
  return frame.locator(".TableRow", { hasText: name }).first().locator(".TableCell", { hasText: name }).first();
}

async function fetchJson<T>(frame: Frame, target: string): Promise<T> {
  const body = await frame.evaluate(async (url: string) => (await fetch(url)).text(), target);

  return JSON.parse(body) as T;
}

describe("pre-review pass of the CloudNativePG extension", () => {
  let app: ElectronApplication;
  let window: Page;
  let frame: Frame;
  let cleanup: undefined | (() => Promise<void>);

  const errorCollector = cnpg.createErrorCollector();
  const outcomes: Outcome[] = [];
  const screenshots: string[] = [];

  /** Runs a check, records its outcome for the report and lets a failure fail the pass. */
  async function record(check: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
      outcomes.push({ check, passed: true });
    } catch (error) {
      outcomes.push({ check, passed: false, detail: (error as Error).message.split("\n")[0] });
      throw error;
    }
  }

  async function shot(name: string): Promise<void> {
    const file = await cluster.captureScreenshot(frame, name);

    if (file) screenshots.push(path.basename(file));
  }

  async function openLiveViewOfMain(): Promise<void> {
    await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");

    const door = frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]');

    // The page remembers nothing, but the URL may still carry the cluster.
    if ((await door.count()) > 0) await door.click();
    await frame.locator('[data-testid="cnpg-live-sessions-total"]').waitFor({ state: "visible", timeout: 90_000 });
  }

  /** Every page and every drawer, on the theme that is set. */
  async function walk(theme: string): Promise<void> {
    await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
    await frame.locator('[data-testid="cnpg-overview-grid"]').waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-overview`);

    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await cluster.expectRow(frame, "e2e-main", "Healthy");
    await shot(`${theme}-clusters`);
    await table(frame, "e2e-main").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Certificates" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-cluster-drawer`);
    await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-backup-history"]').scrollIntoViewIfNeeded();
    await shot(`${theme}-cluster-drawer-backups`);
    await cluster.closeDetails(frame);

    await openLiveViewOfMain();
    // Give the sparklines a few samples before the picture is taken.
    await frame.waitForTimeout(12_000);
    await shot(`${theme}-live-view`);
    await frame.locator('[data-testid="cnpg-live-manager"]').scrollIntoViewIfNeeded();
    await shot(`${theme}-live-view-tiles`);

    await cluster.openCnpgPage(frame, "cnpg-backups-backups", "Backups");
    await cluster.expectRow(frame, "e2e-backup-ok", "Completed");
    await shot(`${theme}-backups`);
    await table(frame, "e2e-backup-ok").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Restore coordinates" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-backup-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
    await cluster.expectRow(frame, "e2e-suspended", "Suspended");
    await shot(`${theme}-scheduled-backups`);
    await table(frame, "e2e-immediate").click();
    await frame
      .locator('.Drawer.KubeObjectDetails [data-testid="cnpg-backup-history"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-scheduled-backup-drawer`);
    await cluster.closeDetails(frame);

    // M3: the kinds around a cluster.
    await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
    await cluster.expectRow(frame, "e2e-store", "In use");
    await shot(`${theme}-object-stores`);
    await table(frame, "e2e-store").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Recovery windows" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await frame.locator(".Drawer.KubeObjectDetails").getByText("Recovery windows").scrollIntoViewIfNeeded();
    await shot(`${theme}-object-store-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-pooling-poolers", "Poolers");
    await cluster.expectRow(frame, "e2e-main-pooler", "Active");
    await shot(`${theme}-poolers`);
    await table(frame, "e2e-main-pooler").click();

    const poolerLive = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-pooler-live"]');

    await poolerLive.waitFor({ state: "visible", timeout: 90_000 });
    await poolerLive.scrollIntoViewIfNeeded();
    await shot(`${theme}-pooler-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
    await cluster.expectRow(frame, "e2e-db-inventory", "Applied");
    await shot(`${theme}-databases`);
    await table(frame, "e2e-db-bad-extension").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Managed objects" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-database-live"]').waitFor({
      state: "visible",
      timeout: 90_000,
    });
    await frame.locator(".Drawer.KubeObjectDetails .Table").last().scrollIntoViewIfNeeded();
    await shot(`${theme}-database-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-databases-databaseroles", "Database Roles");
    await cluster.expectRow(frame, "e2e-role-reporting", "Applied");
    await shot(`${theme}-database-roles`);
    await table(frame, "e2e-role-reporting").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Authentication" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await frame
      .locator(".Drawer.KubeObjectDetails .DrawerItem", { hasText: "Certificate expires" })
      .scrollIntoViewIfNeeded();
    await shot(`${theme}-database-role-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-databases-publications", "Publications");
    await cluster.expectRow(frame, "e2e-pub-numbers", "Applied");
    await shot(`${theme}-publications`);
    await table(frame, "e2e-pub-numbers").click();

    const publicationLive = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-publication-live"]');

    await publicationLive.waitFor({ state: "visible", timeout: 90_000 });
    await publicationLive.scrollIntoViewIfNeeded();
    await shot(`${theme}-publication-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
    await cluster.expectRow(frame, "e2e-sub-numbers", "Applied");
    await shot(`${theme}-subscriptions`);
    await table(frame, "e2e-sub-numbers").click();

    const subscriptionLive = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-subscription-live"]');

    await subscriptionLive.waitFor({ state: "visible", timeout: 90_000 });
    await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-replication-path"]').scrollIntoViewIfNeeded();
    await shot(`${theme}-subscription-drawer`);
    await frame
      .locator(".Drawer.KubeObjectDetails .DrawerItem", { hasText: "WAL kept for it" })
      .scrollIntoViewIfNeeded();
    await shot(`${theme}-subscription-drawer-right-now`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await table(frame, "e2e-single").click();

    const inlineRoles = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-inline-roles"]');

    await inlineRoles.waitFor({ state: "visible", timeout: 60_000 });
    await inlineRoles.scrollIntoViewIfNeeded();
    await shot(`${theme}-cluster-drawer-declarative`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await table(frame, "e2e-main").click();

    const lease = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-primary-lease"]');

    await lease.waitFor({ state: "visible", timeout: 60_000 });
    await lease.scrollIntoViewIfNeeded();
    await shot(`${theme}-cluster-drawer-lease`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-clusters-logs", "Logs");

    const logsDoor = frame.locator('[data-testid="cnpg-logs-door-cnpg-e2e-e2e-main"]');

    if ((await logsDoor.count()) > 0) await logsDoor.click();
    await frame.locator('[data-testid="cnpg-log-row"]').first().waitFor({ state: "visible", timeout: 90_000 });
    await shot(`${theme}-logs`);

    await cluster.openCnpgPage(frame, "cnpg-clusters-timeline", "Timeline");

    const timelineDoor = frame.locator('[data-testid="cnpg-timeline-door-cnpg-e2e-e2e-main"]');

    if ((await timelineDoor.count()) > 0) await timelineDoor.click();
    await frame.locator('[data-testid="cnpg-timeline-entry"]').first().waitFor({ state: "visible", timeout: 90_000 });
    await shot(`${theme}-timeline`);

    await cluster.openCnpgPage(frame, "cnpg-operator", "Operator");
    await frame.locator('[data-testid="cnpg-operator-live"]').waitFor({ state: "visible", timeout: 90_000 });
    await shot(`${theme}-operator`);
    await frame.locator('[data-testid="cnpg-operator-kinds"]').scrollIntoViewIfNeeded();
    await shot(`${theme}-operator-plugins-and-kinds`);

    await cluster.openCnpgPage(frame, "cnpg-images-imagecatalogs", "Image Catalogs");
    await cluster.expectRow(frame, "e2e-images", "In use");
    await shot(`${theme}-image-catalogs`);
    await table(frame, "e2e-images").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "Aligned" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await frame.locator(".Drawer.KubeObjectDetails").getByText("Aligned").scrollIntoViewIfNeeded();
    await shot(`${theme}-image-catalog-drawer`);
    await cluster.closeDetails(frame);

    await cluster.openCnpgPage(frame, "cnpg-images-clusterimagecatalogs", "Cluster Image Catalogs");
    await cluster.expectRow(frame, "e2e-cluster-images", "Unused");
    await shot(`${theme}-cluster-image-catalogs`);

    await cluster.openCnpgPage(frame, "cnpg-clusters-failoverquorums", "Failover Quorums");
    await cluster.expectRow(frame, "e2e-main", "Safe");
    await shot(`${theme}-failover-quorums`);
    await table(frame, "e2e-main").click();
    await frame
      .locator(".Drawer.KubeObjectDetails", { hasText: "How to read it" })
      .waitFor({ state: "visible", timeout: 60_000 });
    await frame.locator(".Drawer.KubeObjectDetails").getByText("How to read it").scrollIntoViewIfNeeded();
    await shot(`${theme}-failover-quorum-drawer`);
    await cluster.closeDetails(frame);

    await walkActionDialogs(theme);
  }

  /**
   * The dialog of every write action (M6), opened on the cluster of the write
   * cases and closed without confirming: the pass looks, it never writes.
   */
  async function walkActionDialogs(theme: string): Promise<void> {
    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
    try {
      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await shot(`${theme}-cluster-row-menu-actions`);
      await frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first().click();
      await frame.locator('[data-testid="cnpg-backup-now-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-backup-now`);
      await cluster.cancelDialog(frame);

      // SPEC-0021: the two dialogs of a schedule that is not suspended.
      await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_SCHEDULE);
      await shot(`${theme}-schedule-row-menu-actions`);
      await frame.locator('.Menu [data-testid="cnpg-schedule-suspend-menu-item"]').first().click();
      await frame
        .locator('[data-testid="cnpg-schedule-suspend-dialog"]')
        .waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-schedule-suspend`);
      await cluster.cancelDialog(frame);

      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_SCHEDULE);
      await frame.locator('.Menu [data-testid="cnpg-schedule-run-now-menu-item"]').first().click();
      await frame
        .locator('[data-testid="cnpg-schedule-run-now-dialog"]')
        .waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-schedule-run-now`);
      await cluster.cancelDialog(frame);
    } finally {
      await cluster.selectNamespace(frame);
    }

    // The dialog of a resume, on the schedule the fixtures keep suspended.
    await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
    await cluster.openRowMenu(frame, "e2e-suspended");
    await frame.locator('.Menu [data-testid="cnpg-schedule-resume-menu-item"]').first().click();
    await frame.locator('[data-testid="cnpg-schedule-resume-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-action-schedule-resume`);
    await cluster.cancelDialog(frame);
  }

  beforeAll(async () => {
    if (!cluster.fixturesReady()) {
      throw new Error(
        `The CloudNativePG fixtures are missing from ${cluster.E2E_CLUSTER_NAME}. Run \`pnpm demo:up\` first.`,
      );
    }

    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    errorCollector.start();
    ({ app, window, cleanup } = await utils.start());
    errorCollector.watch(window);

    const kubeconfig = await cluster.publishKubeconfig();

    await utils.clickWelcomeButton(window);
    await cnpg.installExtension(app, window);
    await cnpg.dismissNotifications(window);
    await cnpg.navigateToCatalog(app);
    frame = await cluster.openClusterFromCatalog(window, kubeconfig);

    // The namespace filter lives in the header of the list pages and every view
    // follows it: the fixtures' namespace is selected once, before the walk.
    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await cluster.selectNamespace(frame);
  }, TIMEOUT);

  afterAll(async () => {
    const failed = outcomes.filter((outcome) => !outcome.passed);
    const operatorImage = cluster.kubectlE2E(
      "get",
      "deployment",
      "cnpg-controller-manager",
      "--namespace",
      "cnpg-system",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ).stdout;
    const report = [
      "# Pre-review pass",
      "",
      `- Date: ${new Date().toISOString()}`,
      `- Cluster: ${cluster.E2E_CLUSTER_NAME}, operator image ${operatorImage || "unknown"}`,
      `- Verdict: ${failed.length === 0 ? "every automated check passed" : `${failed.length} check(s) failed`}`,
      "",
      "## Checks",
      "",
      "| Check | Outcome |",
      "| --- | --- |",
      ...outcomes.map(
        (outcome) => `| ${outcome.check} | ${outcome.passed ? "passed" : `FAILED: ${outcome.detail ?? ""}`} |`,
      ),
      "",
      "## Screenshots",
      "",
      ...screenshots.map((file) => `- ${file}`),
      "",
      "## For human judgment",
      "",
      ...HUMAN_JUDGMENT.map((line) => `- ${line}`),
      "",
    ].join("\n");

    fs.writeFileSync(path.join(ARTIFACTS_DIR, "REPORT.md"), report);
    await cleanup?.();
    errorCollector.stop(window);
  }, TIMEOUT);

  it(
    "walks every view on the dark theme and checks the rules of DESIGN.md",
    async () => {
      await record("Every page and drawer renders on the dark theme", () => walk("dark"));

      for (const [menuId, title] of [
        ["cnpg-clusters-clusters", "PostgreSQL Clusters"],
        ["cnpg-backups-backups", "Backups"],
        ["cnpg-backups-scheduledbackups", "Scheduled Backups"],
        ["cnpg-backups-objectstores", "Object Stores"],
        ["cnpg-pooling-poolers", "Poolers"],
        ["cnpg-images-imagecatalogs", "Image Catalogs"],
        ["cnpg-clusters-failoverquorums", "Failover Quorums"],
        ["cnpg-databases-databases", "Databases"],
        ["cnpg-databases-databaseroles", "Database Roles"],
        ["cnpg-databases-publications", "Publications"],
        ["cnpg-databases-subscriptions", "Subscriptions"],
      ] as const) {
        await cluster.openCnpgPage(frame, menuId, title);
        await frame.locator(".TableRow:not(.TableHead)").first().waitFor({ state: "visible", timeout: 60_000 });
        await record(`${title}: column grammar of DESIGN.md section 1`, () => checks.expectColumnGrammar(frame, title));
        await record(`${title}: no empty cell, a missing value reads "N/A"`, () =>
          checks.expectNoEmptyCells(frame, title),
        );
        await record(`${title}: no link nested in a link`, () => checks.expectNoNestedLinks(frame, title));
        await record(`${title}: no authored color in inline styles`, () => checks.expectNoAuthoredColors(frame, title));
      }

      await cluster.openCnpgPage(frame, "cnpg-overview", "Overview");
      await frame.locator('[data-testid="cnpg-overview-grid"]').waitFor({ state: "visible", timeout: 60_000 });
      await record("Overview: no link nested in a link", () => checks.expectNoNestedLinks(frame, "Overview"));
      await record("Overview: no authored color in inline styles", () =>
        checks.expectNoAuthoredColors(frame, "Overview"),
      );

      await openLiveViewOfMain();
      await record("Live View: no link nested in a link", () => checks.expectNoNestedLinks(frame, "Live View"));
      await record("Live View: no authored color in inline styles", () =>
        checks.expectNoAuthoredColors(frame, "Live View"),
      );
      await record("Live View: declares its intervals and offers pause and refresh as buttons", async () => {
        const facts = await frame.locator('[data-testid="cnpg-live-facts"]').innerText();

        if (!/status every \d+ s, metrics every \d+ s/.test(facts)) {
          throw new Error(`the header should declare both intervals, got "${facts}"`);
        }

        for (const label of ["Pause the live reads", "Read now"]) {
          const button = frame.locator(`[data-testid="cnpg-live-facts"] button[aria-label="${label}"]`);

          if ((await button.count()) !== 1) throw new Error(`no button labelled "${label}"`);
          await button.focus();
        }
      });
    },
    TIMEOUT,
  );

  it(
    "offers the write actions only where they make sense, and says why where they do not (SPEC-0020, SPEC-0021)",
    async () => {
      const backups = () =>
        cluster.kubectlE2E("get", "backups.postgresql.cnpg.io", "--all-namespaces", "-o", "name").stdout;
      const suspensions = () =>
        cluster.kubectlE2E(
          "get",
          "scheduledbackups.postgresql.cnpg.io",
          "--all-namespaces",
          "-o",
          'jsonpath={range .items[*]}{.metadata.namespace}/{.metadata.name}={.spec.suspend}{"\n"}{end}',
        ).stdout;
      const before = backups();
      const suspendedBefore = suspensions();

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");

      await record("A refused action carries its reason in the row menu (W2)", async () => {
        await cluster.openRowMenu(frame, "e2e-hibernated");

        const item = frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first();

        await item.waitFor({ state: "visible", timeout: 60_000 });

        const title = (await item.getAttribute("title")) ?? "";
        const classes = (await item.getAttribute("class")) ?? "";

        await cluster.closeRowMenu(frame);
        if (!classes.includes("disabled")) throw new Error('"Back up now" of e2e-hibernated should be refused');
        if (!title.includes("hibernated")) throw new Error(`the reason should name the hibernation, got "${title}"`);
      });

      await record("A refused action is dimmed and explained in the toolbar of the drawer (W2)", async () => {
        await table(frame, "e2e-hibernated").click();

        const item = frame.locator('.Drawer [data-testid="cnpg-cluster-backup-now-menu-item"]').first();

        await item.waitFor({ state: "visible", timeout: 60_000 });

        const title = (await item.getAttribute("title")) ?? "";
        const opacity = await item
          .locator(".Icon")
          .first()
          .evaluate((icon) => getComputedStyle(icon).opacity);

        await cluster.closeDetails(frame);
        if (!title.includes("hibernated")) throw new Error(`no reason on the toolbar item, got "${title}"`);
        if (Number(opacity) >= 1) throw new Error(`the refused icon should be dimmed, opacity is ${opacity}`);
      });

      await record("A dialog names the object, the Kubernetes context and every API call (W4)", async () => {
        await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
        try {
          await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
          await frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first().click();

          const dialog = frame.locator('[data-testid="cnpg-backup-now-dialog"]');

          await dialog.waitFor({ state: "visible", timeout: 60_000 });

          const subject = await dialog.locator('[data-testid="cnpg-action-subject"]').innerText();
          const context = await dialog.locator('[data-testid="cnpg-action-context"]').innerText();
          const writes = await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts();

          await cluster.cancelDialog(frame);
          if (subject !== `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${cluster.E2E_ACTIONS_CLUSTER}`) {
            throw new Error(`unexpected subject "${subject}"`);
          }
          if (!context.includes(cluster.E2E_KUBE_CONTEXT)) throw new Error(`no context in "${context}"`);
          if (writes.length !== 1 || !writes[0].startsWith("create Backup ")) {
            throw new Error(`unexpected writes ${JSON.stringify(writes)}`);
          }
        } finally {
          await cluster.selectNamespace(frame);
        }
      });

      await record("A schedule offers exactly one of Suspend and Resume, by what it declares (SPEC-0021)", async () => {
        await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");

        for (const [name, offered, absent] of [
          ["e2e-suspended", "resume", "suspend"],
          ["e2e-nightly", "suspend", "resume"],
        ]) {
          await cluster.openRowMenu(frame, name);
          await frame
            .locator(`.Menu [data-testid="cnpg-schedule-${offered}-menu-item"]`)
            .first()
            .waitFor({ state: "visible", timeout: 60_000 });

          const other = await frame.locator(`.Menu [data-testid="cnpg-schedule-${absent}-menu-item"]`).count();
          const runNow = await frame.locator('.Menu [data-testid="cnpg-schedule-run-now-menu-item"]').count();

          await cluster.closeRowMenu(frame);
          if (other !== 0) throw new Error(`${name} offers "${absent}" next to "${offered}"`);
          if (runNow !== 1) throw new Error(`${name} should offer "Run now" once, found ${runNow}`);
        }
      });

      await record("The dialog of a resume says what the operator will do about the next run (SPEC-0021)", async () => {
        await cluster.openRowMenu(frame, "e2e-suspended");
        await frame.locator('.Menu [data-testid="cnpg-schedule-resume-menu-item"]').first().click();

        const dialog = frame.locator('[data-testid="cnpg-schedule-resume-dialog"]');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });

        const subject = await dialog.locator('[data-testid="cnpg-action-subject"]').innerText();
        const writes = await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts();
        const text = await dialog.innerText();

        await cluster.cancelDialog(frame);
        if (subject !== `ScheduledBackup ${cluster.E2E_NAMESPACE}/e2e-suspended`) {
          throw new Error(`unexpected subject "${subject}"`);
        }
        if (writes.length !== 1 || !writes[0].endsWith("spec.suspend true -> false")) {
          throw new Error(`unexpected writes ${JSON.stringify(writes)}`);
        }
        if (!/next run/i.test(text)) throw new Error("the dialog does not speak of the next run");
      });

      await record("Looking at the dialogs wrote nothing (W8)", () => {
        const after = backups();
        const suspendedAfter = suspensions();

        if (after !== before) throw new Error(`the backups changed during the pass: "${before}" then "${after}"`);
        if (suspendedAfter !== suspendedBefore) {
          throw new Error(`the schedules changed during the pass: "${suspendedBefore}" then "${suspendedAfter}"`);
        }
      });
    },
    TIMEOUT,
  );

  it(
    "agrees with what the instances and the API server say",
    async () => {
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
      const statusPath = `${API_KUBE_PREFIX}/api/v1/namespaces/${cluster.E2E_NAMESPACE}/pods/https:${primary}:8000/proxy/pg/status`;

      await openLiveViewOfMain();

      const card = frame.locator('[data-testid="cnpg-live-topology"] [data-role="primary"]');

      await record("Live View: the primary it draws is the one Cluster.status names", async () => {
        const testId = await card.getAttribute("data-testid");

        if (testId !== `cnpg-live-instance-${primary}`)
          throw new Error(`expected ${primary}, the view draws ${testId}`);
      });

      await record("Live View: the LSN of the primary lies between two answers of the instance manager", async () => {
        // The page polls every five seconds: the answer taken before has to be
        // older than what is on screen, so a full interval passes in between.
        const before = await fetchJson<{ currentLsn: string }>(frame, statusPath);

        await frame.waitForTimeout(6000);

        const shown = /LSN\s+([0-9A-F]+\/[0-9A-F]+)/.exec(await card.innerText())?.[1] ?? "";
        const after = await fetchJson<{ currentLsn: string }>(frame, statusPath);

        checks.expectLsnBetween(shown, before.currentLsn, after.currentLsn);
      });

      await record("Cluster drawer: the last successful backup is the latest completed Backup object", async () => {
        const raw = cluster.kubectlE2E(
          "get",
          "backups.postgresql.cnpg.io",
          "--namespace",
          cluster.E2E_NAMESPACE,
          "-o",
          "json",
        ).stdout;
        const items = (JSON.parse(raw).items ?? []) as Array<{
          spec?: { cluster?: { name?: string } };
          status?: { phase?: string; stoppedAt?: string };
        }>;
        const latest = Math.max(
          ...items
            .filter((item) => item.spec?.cluster?.name === "e2e-main" && item.status?.phase === "completed")
            .map((item) => Date.parse(item.status?.stoppedAt ?? "")),
        );

        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await table(frame, "e2e-main").click();

        const drawer = frame.locator(".Drawer.KubeObjectDetails", { hasText: "Last successful backup" });

        await drawer.waitFor({ state: "visible", timeout: 60_000 });

        const row = drawer.locator(".DrawerItem", { hasText: "Last successful backup" }).first();
        const shown = Date.parse((await row.locator(".value").innerText()).trim());

        await cluster.closeDetails(frame);
        if (Math.abs(shown - latest) >= 1000) {
          throw new Error(
            `the drawer shows ${new Date(shown).toISOString()}, the Backup objects say ${new Date(latest).toISOString()}`,
          );
        }
      });

      for (const [menuId, title, door, ready] of [
        ["cnpg-clusters-logs", "Logs", "cnpg-logs-door-cnpg-e2e-e2e-main", "cnpg-log-row"],
        ["cnpg-clusters-timeline", "Timeline", "cnpg-timeline-door-cnpg-e2e-e2e-main", "cnpg-timeline-entry"],
        ["cnpg-operator", "Operator", "", "cnpg-operator-card"],
      ] as const) {
        await cluster.openCnpgPage(frame, menuId, title);
        if (door && (await frame.locator(`[data-testid="${door}"]`).count()) > 0) {
          await frame.locator(`[data-testid="${door}"]`).click();
        }
        await frame.locator(`[data-testid="${ready}"]`).first().waitFor({ state: "visible", timeout: 90_000 });
        await record(`${title}: no link nested in a link`, () => checks.expectNoNestedLinks(frame, title));
        await record(`${title}: no authored color in inline styles`, () => checks.expectNoAuthoredColors(frame, title));
      }

      await record("Cluster drawer and Operator: the leaders shown are the holders of the leases", async () => {
        const primaryHolder = cluster.kubectlField("leases.coordination.k8s.io", "e2e-main", "{.spec.holderIdentity}");
        const operatorHolder = cluster
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

        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await table(frame, "e2e-main").click();

        const status = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-primary-lease-status"]');

        await status.waitFor({ state: "visible", timeout: 60_000 });

        const shownPrimary = (await status.innerText()).trim();

        await cluster.closeDetails(frame);
        if (!shownPrimary.endsWith(primaryHolder)) {
          throw new Error(`the drawer says "${shownPrimary}", the lease is held by ${primaryHolder}`);
        }

        await cluster.openCnpgPage(frame, "cnpg-operator", "Operator");

        const leader = frame.locator('[data-testid="cnpg-operator-leader"]');

        await leader.waitFor({ state: "visible", timeout: 90_000 });

        const shownLeader = (await leader.innerText()).trim();

        if (!shownLeader.startsWith(operatorHolder)) {
          throw new Error(`the page says "${shownLeader}", the lease is held by ${operatorHolder}`);
        }
      });

      await record("Timeline: a completed backup sits at the time its Backup object stopped", async () => {
        const stoppedAt = Date.parse(
          cluster.kubectlField("backups.postgresql.cnpg.io", "e2e-backup-ok", "{.status.stoppedAt}"),
        );

        await cluster.openCnpgPage(frame, "cnpg-clusters-timeline", "Timeline");

        const door = frame.locator('[data-testid="cnpg-timeline-door-cnpg-e2e-e2e-main"]');

        if ((await door.count()) > 0) await door.click();

        const entry = frame
          .locator('[data-testid="cnpg-timeline-entry"]', { hasText: "Backup e2e-backup-ok completed" })
          .first();

        await entry.waitFor({ state: "visible", timeout: 90_000 });

        const shown = Date.parse((await entry.locator("span").first().getAttribute("title")) ?? "");

        if (Math.abs(shown - stoppedAt) >= 1000) {
          throw new Error(
            `the timeline says ${new Date(shown).toISOString()}, the Backup object says ${new Date(stoppedAt).toISOString()}`,
          );
        }
      });

      await record("Logs: the rows of an instance are the lines its pod wrote", async () => {
        const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-single", "{.status.currentPrimary}");
        const raw = await frame.evaluate(
          async (url: string) => (await fetch(url)).text(),
          `${API_KUBE_PREFIX}/api/v1/namespaces/${cluster.E2E_NAMESPACE}/pods/${primary}/log?container=postgres&tailLines=200`,
        );
        const written = raw
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => {
            try {
              const parsed = JSON.parse(line) as { msg?: string; record?: { message?: string } };

              return parsed.record?.message ?? parsed.msg ?? "";
            } catch {
              return "";
            }
          })
          .filter(Boolean);

        await cluster.openCnpgPage(frame, "cnpg-clusters-logs", "Logs");
        await frame.locator("#cnpg-logs-cluster").click();
        await frame.locator(".Select__option", { hasText: "e2e-single" }).first().click();
        await frame.locator('[data-testid="cnpg-log-row"]').first().waitFor({ state: "visible", timeout: 90_000 });

        const shown = (await frame.locator('[data-testid="cnpg-log-row"]').allInnerTexts()).join("\n");
        // The newest lines of the pod may not be on the page yet and the oldest may have left the buffer: the middle is there.
        const sample = written.slice(Math.floor(written.length / 3), Math.floor((written.length * 2) / 3)).slice(0, 5);
        const missing = sample.filter((message) => !shown.includes(message.split("\n")[0].slice(0, 60)));

        if (sample.length === 0) throw new Error("the pod wrote no JSON line to compare with");
        if (missing.length > 0) throw new Error(`lines the pod wrote are not on the page: ${missing.join(" | ")}`);
      });

      await record("Databases: every condition agrees with what the operator wrote in the status", async () => {
        const raw = cluster.kubectlE2E(
          "get",
          "databases.postgresql.cnpg.io",
          "--namespace",
          cluster.E2E_NAMESPACE,
          "-o",
          "json",
        ).stdout;
        const items = (JSON.parse(raw).items ?? []) as Array<{
          metadata: { name: string };
          spec?: { ensure?: string };
          status?: { applied?: boolean };
        }>;

        const STATES = ["Applied", "Absent", "Updating", "Failed", "Waiting", "Pending", "Orphan", "Deleting"];

        await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
        for (const item of items) {
          const expected =
            item.status?.applied === true
              ? [item.spec?.ensure === "absent" ? "Absent" : "Applied", "Updating"]
              : item.status?.applied === false
                ? ["Failed"]
                : ["Pending", "Waiting", "Orphan"];
          // The condition is one of the cells of the row, read as text: a cell that says exactly one of the states.
          const row = frame.locator(".TableRow", { hasText: item.metadata.name }).first();

          await row.waitFor({ state: "visible", timeout: 60_000 });

          const cells = (await row.locator(".TableCell").allInnerTexts()).map((text) => text.trim());
          const shown =
            cells.find((text) => STATES.includes(text)) ?? `none of the states (cells: ${cells.join(" | ")})`;

          if (!expected.includes(shown)) {
            throw new Error(
              `${item.metadata.name}: the list says ${shown}, the status says one of ${expected.join(", ")}`,
            );
          }
        }
      });

      await record("Subscription drawer: the slot it shows is the one the publisher's exporter reports", async () => {
        const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
        const metrics = await frame.evaluate(
          async (url: string) => (await fetch(url)).text(),
          `${API_KUBE_PREFIX}/api/v1/namespaces/${cluster.E2E_NAMESPACE}/pods/${primary}:9187/proxy/metrics`,
        );
        const line = metrics
          .split("\n")
          .find(
            (entry) =>
              entry.startsWith("cnpg_pg_replication_slots_active{") && entry.includes('slot_name="e2e_numbers_sub"'),
          );

        if (!line) throw new Error("the exporter of the publisher reports no slot named e2e_numbers_sub");

        const active = line.trim().endsWith(" 1");

        await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
        await table(frame, "e2e-sub-numbers").click();

        const badge = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-subscription-slot-active"]');

        await badge.waitFor({ state: "visible", timeout: 90_000 });

        const shown = (await badge.innerText()).trim();

        await cluster.closeDetails(frame);
        if (shown !== (active ? "True" : "False")) {
          throw new Error(`the drawer says ${shown}, the exporter says ${active ? "active" : "not active"}`);
        }
      });
    },
    TIMEOUT,
  );

  it(
    "walks every view on the light theme",
    async () => {
      await cnpg.setColorTheme(app, window, "Light");
      try {
        await record("Every page and drawer renders on the light theme", () => walk("light"));
      } finally {
        await cnpg.setColorTheme(app, window, "Dark");
      }
    },
    TIMEOUT,
  );

  it(
    "saw no console error and no failed request during the walk",
    async () => {
      await record("No console error and no failed request", () => {
        expect(errorCollector.errors()).toEqual([]);
      });
    },
    TIMEOUT,
  );
});
