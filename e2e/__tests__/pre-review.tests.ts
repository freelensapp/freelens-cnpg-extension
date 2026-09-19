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
