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
    // SPEC-0028: the trends need two samples of the exporter; the pass waits for the first point.
    await frame
      .locator(
        '[data-testid="cnpg-trend-transactions"][data-points="0"], [data-testid="cnpg-trend-transactions"][data-points="1"]',
      )
      .waitFor({ state: "hidden", timeout: 150_000 })
      .catch(() => undefined);
    await frame.locator('[data-testid="cnpg-trends"]').scrollIntoViewIfNeeded();
    await frame.waitForTimeout(500);
    await shot(`${theme}-live-view-trends`);

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
    await walkCreateForms(theme);
  }

  /**
   * The creation forms (M7), filled with valid values on the write namespace
   * and closed without creating: the pass looks at the form and its YAML
   * pane, it never writes.
   */
  async function walkCreateForms(theme: string): Promise<void> {
    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
    try {
      // SPEC-0025: the Create Cluster form, its YAML pane, and its collapsed sections opened.
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill("review-cluster");
      await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("10Gi");

      const storePicker = frame.locator("#cnpg-create-cluster-object-store");

      await storePicker.waitFor({ state: "visible", timeout: 60_000 });
      await storePicker.fill("actions-store");
      await storePicker.press("Enter");
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster`);
      // F12: the pane is the body, so the editor must fill its box; the host editor sizes itself from the
      // line count of the value it mounted with unless the dialog gives it a height, and the body grows.
      await record("Create Cluster: the YAML pane fills its box (F12)", async () => {
        const box = await dialog.locator('[data-test-id="monaco-editor"]').boundingBox();

        if (!box || box.height < 400) throw new Error(`the editor is ${box?.height ?? 0} px tall in a box of 440 px`);
      });

      await dialog.locator('[data-testid="cnpg-create-cluster-replication-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-sync-enabled"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-resources-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-requests-cpu"]').fill("500m");
      await dialog.locator('[data-testid="cnpg-create-cluster-requests-memory"]').fill("1Gi");
      await dialog.locator('[data-testid="cnpg-create-cluster-limits-cpu"]').fill("500m");
      await dialog.locator('[data-testid="cnpg-create-cluster-limits-memory"]').fill("1Gi");
      await dialog.locator('[data-testid="cnpg-create-cluster-updates-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-parameters-add"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-parameters-0-key"]').fill("shared_buffers");
      await dialog.locator('[data-testid="cnpg-create-cluster-parameters-0-value"]').fill("256MB");
      await dialog.locator('[data-testid="cnpg-create-cluster-updates-section"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster-sections`);

      // The recovery bootstrap, with the backups of the write namespace to pick from.
      await dialog.locator('[data-testid="cnpg-create-cluster-bootstrap-recovery"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-bootstrap-radios"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster-recovery`);

      // SPEC-0029: a tablespace row, the volume snapshot block, and the recovery from the snapshots of the write namespace.
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-add"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-name"]').fill("analytics");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-size"]').fill("5Gi");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-section"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster-tablespaces`);
      await dialog.locator('[data-testid="cnpg-create-cluster-backup-options-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-snapshots-enabled"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-backup-options-section"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster-snapshots`);
      await dialog.locator('[data-testid="cnpg-create-cluster-recovery-source-volumeSnapshots"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-bootstrap-radios"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-cluster-snapshot-recovery`);
      await cluster.cancelDialog(frame);

      // SPEC-0029: the drawer of the snapshot cluster, with its tablespace and its snapshot settings.
      await table(frame, cluster.E2E_SNAPSHOT_CLUSTER).click();
      await frame.locator(".Drawer.KubeObjectDetails").waitFor({ state: "visible", timeout: 60_000 });
      // The host's Table forwards no data attribute: the row of the Storage section is the anchor, matched
      // on its exact name (the annotations row above it quotes the word inside the last applied JSON).
      await frame
        .locator(".Drawer.KubeObjectDetails")
        .locator(".DrawerItem", { has: frame.locator("text=/^Tablespaces$/") })
        .first()
        .scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-drawer-cluster-tablespaces`);
      await cluster.closeDetails(frame);

      // SPEC-0026: the two forms the drawer of a cluster opens with the cluster set, then the object store form.
      await table(frame, cluster.E2E_ACTIONS_CLUSTER).click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const scheduleDoor = drawer.locator('[data-testid="cnpg-cluster-create-schedule"]');

      await scheduleDoor.waitFor({ state: "visible", timeout: 60_000 });
      await scheduleDoor.click();

      const schedule = frame.locator('[data-testid="cnpg-create-schedule"]');

      await schedule.waitFor({ state: "visible", timeout: 60_000 });
      await schedule
        .locator('[data-testid="cnpg-create-schedule-next-runs"]')
        .waitFor({ state: "visible", timeout: 60_000 });
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-schedule`);
      await schedule.locator('[data-testid="cnpg-create-schedule-preset-weekly"]').check();
      await schedule.locator('[data-testid="cnpg-create-schedule-immediate"]').check();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-schedule-weekly`);
      // The host select asks for 220 px at least: in a row of three fields it must take its column, not the next one.
      await record("Create ScheduledBackup: a select of an inline row stays in its column", async () => {
        const weekday = await schedule
          .locator(".Select", { has: frame.locator("#cnpg-create-schedule-weekday") })
          .boundingBox();
        const hour = await schedule.locator('[data-testid="cnpg-create-schedule-hour"]').boundingBox();

        if (!weekday || !hour) throw new Error("the weekday select or the hour field is not on the screen");
        if (weekday.x + weekday.width > hour.x + 1) {
          throw new Error(
            `the weekday select ends at ${Math.round(weekday.x + weekday.width)} px, the hour field starts at ${Math.round(hour.x)} px`,
          );
        }
      });
      await cluster.cancelDialog(frame);

      const poolerDoor = drawer.locator('[data-testid="cnpg-cluster-create-pooler"]');

      await poolerDoor.scrollIntoViewIfNeeded();
      await poolerDoor.click();

      const pooler = frame.locator('[data-testid="cnpg-create-pooler"]');

      await pooler.waitFor({ state: "visible", timeout: 60_000 });
      await pooler.locator('[data-testid="cnpg-create-pooler-parameters-add"]').click();
      await pooler.locator('[data-testid="cnpg-create-pooler-parameters-0-key"]').fill("max_client_conn");
      await pooler.locator('[data-testid="cnpg-create-pooler-parameters-0-value"]').fill("500");
      await pooler.locator('[data-testid="cnpg-create-pooler-auth-section-toggle"]').click();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-pooler`);
      await cluster.cancelDialog(frame);
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const store = frame.locator('[data-testid="cnpg-create-object-store"]');

      await store.waitFor({ state: "visible", timeout: 60_000 });
      await store.locator('[data-testid="cnpg-create-object-store-name"]').fill("review-store");
      await store.locator('[data-testid="cnpg-create-object-store-destination"]').fill("s3://backups/review/");
      await store.locator('[data-testid="cnpg-create-object-store-endpoint"]').fill("https://s3.cnpg-e2e.svc:9000");

      const secretPicker = frame.locator("#cnpg-create-object-store-s3AccessKeyId-secret");

      await secretPicker.waitFor({ state: "visible", timeout: 60_000 });
      await secretPicker.fill("actions-store-creds");
      await secretPicker.press("Enter");
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-object-store`);
      await store.locator('[data-testid="cnpg-create-object-store-wal-data-section-toggle"]').click();
      await store.locator('[data-testid="cnpg-create-object-store-retention-section-toggle"]').click();
      await store.locator('[data-testid="cnpg-create-object-store-retention-section"]').scrollIntoViewIfNeeded();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-object-store-sections`);
      await cluster.cancelDialog(frame);

      // SPEC-0027: the four declarative forms, on the cluster of the write cases.
      await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const database = frame.locator('[data-testid="cnpg-create-database"]');

      await database.waitFor({ state: "visible", timeout: 60_000 });
      await pickCluster(frame, "cnpg-create-database-cluster");
      await database.locator('[data-testid="cnpg-create-database-name"]').fill("review-orders");
      await database.locator('[data-testid="cnpg-create-database-dbname"]').fill("orders");
      await database.locator('[data-testid="cnpg-create-database-objects-section-toggle"]').click();
      await database.locator('[data-testid="cnpg-create-database-extensions-add"]').click();
      await database.locator('[data-testid="cnpg-create-database-extensions-0-name"]').fill("pg_stat_statements");
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-database`);
      await cluster.cancelDialog(frame);

      await cluster.openCnpgPage(frame, "cnpg-databases-databaseroles", "Database Roles");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const role = frame.locator('[data-testid="cnpg-create-role"]');

      await role.waitFor({ state: "visible", timeout: 60_000 });
      await pickCluster(frame, "cnpg-create-role-cluster");
      await role.locator('[data-testid="cnpg-create-role-name"]').fill("review-reporting");
      await role.locator('[data-testid="cnpg-create-role-role-name"]').fill("reporting");
      await role.locator('[data-testid="cnpg-create-role-auth-none"]').check();
      await role.locator('[data-testid="cnpg-create-role-privileges-section-toggle"]').click();
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-role`);
      await cluster.cancelDialog(frame);

      await cluster.openCnpgPage(frame, "cnpg-databases-publications", "Publications");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const publication = frame.locator('[data-testid="cnpg-create-publication"]');

      await publication.waitFor({ state: "visible", timeout: 60_000 });
      await pickCluster(frame, "cnpg-create-publication-cluster");
      await publication.locator('[data-testid="cnpg-create-publication-name"]').fill("review-orders-pub");
      await publication.locator('[data-testid="cnpg-create-publication-pub-name"]').fill("orders_pub");
      await publication.locator('[data-testid="cnpg-create-publication-target-objects"]').check();
      await publication.locator('[data-testid="cnpg-create-publication-objects-0-name"]').fill("orders");
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-publication`);
      await cluster.cancelDialog(frame);

      await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const subscription = frame.locator('[data-testid="cnpg-create-subscription"]');

      await subscription.waitFor({ state: "visible", timeout: 60_000 });
      await pickCluster(frame, "cnpg-create-subscription-cluster");
      await subscription.locator('[data-testid="cnpg-create-subscription-name"]').fill("review-numbers-sub");
      await subscription.locator('[data-testid="cnpg-create-subscription-sub-name"]').fill("numbers_sub");

      const external = frame.locator("#cnpg-create-subscription-external");

      await external.waitFor({ state: "visible", timeout: 60_000 });
      await external.fill("e2e-main");
      await external.press("Enter");
      await frame.waitForTimeout(500);
      await shot(`${theme}-form-create-subscription`);
      await cluster.cancelDialog(frame);
    } finally {
      await cluster.selectNamespace(frame);
    }
  }

  /** Picks the cluster of the write cases in the picker of a declarative form (react-select: type, then Enter). */
  async function pickCluster(frame: Frame, id: string): Promise<void> {
    const picker = frame.locator(`#${id}`);

    await picker.waitFor({ state: "visible", timeout: 60_000 });
    await picker.fill(cluster.E2E_ACTIONS_CLUSTER);
    await picker.press("Enter");
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

      // SPEC-0022: the candidates, with OK disabled until the name is typed, then with the name typed.
      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await frame.locator('.Menu [data-testid="cnpg-cluster-switchover-menu-item"]').first().click();

      const switchover = frame.locator('[data-testid="cnpg-switchover-dialog"]');

      await switchover.waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-switchover`);
      await switchover.locator('[data-testid="cnpg-action-typed-name"]').fill(cluster.E2E_ACTIONS_CLUSTER);
      await shot(`${theme}-action-switchover-typed`);
      await cluster.cancelDialog(frame);

      // SPEC-0023: the plan of a cluster restart, the reload, and the two restarts of one instance from the drawer.
      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await frame.locator('.Menu [data-testid="cnpg-cluster-restart-menu-item"]').first().click();
      await frame.locator('[data-testid="cnpg-restart-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-restart-cluster`);
      await cluster.cancelDialog(frame);

      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await frame.locator('.Menu [data-testid="cnpg-cluster-reload-menu-item"]').first().click();
      await frame.locator('[data-testid="cnpg-reload-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-reload`);
      await cluster.cancelDialog(frame);

      const actionsPrimary = cluster.kubectlActionsField(
        "clusters.postgresql.cnpg.io",
        cluster.E2E_ACTIONS_CLUSTER,
        "{.status.currentPrimary}",
      );
      const actionsStandby =
        actionsPrimary === `${cluster.E2E_ACTIONS_CLUSTER}-1`
          ? `${cluster.E2E_ACTIONS_CLUSTER}-2`
          : `${cluster.E2E_ACTIONS_CLUSTER}-1`;

      await table(frame, cluster.E2E_ACTIONS_CLUSTER).click();
      await frame
        .locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-restart-${actionsStandby}"]`)
        .waitFor({ state: "visible", timeout: 60_000 });
      await frame
        .locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-restart-${actionsStandby}"]`)
        .scrollIntoViewIfNeeded();
      await shot(`${theme}-cluster-drawer-instance-actions`);
      await frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-restart-${actionsStandby}"]`).click();
      await frame.locator('[data-testid="cnpg-restart-standby-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-restart-standby`);
      await cluster.cancelDialog(frame);
      await frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-restart-${actionsPrimary}"]`).click();
      await frame.locator('[data-testid="cnpg-restart-primary-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-restart-primary`);
      await cluster.cancelDialog(frame);

      // SPEC-0024: fencing one instance from its row, then every instance from the menu.
      await frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-fence-${actionsStandby}"]`).click();
      await frame.locator('[data-testid="cnpg-fence-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-fence-instance`);
      await cluster.cancelDialog(frame);
      await cluster.closeDetails(frame);

      await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
      await shot(`${theme}-cluster-row-menu-all-actions`);
      await frame.locator('.Menu [data-testid="cnpg-cluster-fence-all-menu-item"]').first().click();
      await frame.locator('[data-testid="cnpg-fence-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
      await shot(`${theme}-action-fence-all`);
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

    // SPEC-0024, on the read-only fixtures, looked at and never confirmed: the hibernation of the cluster that has
    // the most attached to it, the way back of the hibernated one, the lift of the fenced one.
    await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
    await cluster.openRowMenu(frame, "e2e-main");
    await frame.locator('.Menu [data-testid="cnpg-cluster-hibernate-menu-item"]').first().click();
    await frame.locator('[data-testid="cnpg-hibernate-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-action-hibernate`);
    await cluster.cancelDialog(frame);

    await table(frame, "e2e-hibernated").click();
    await frame
      .locator('.Drawer.KubeObjectDetails [data-testid="cnpg-hibernation-state"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-cluster-drawer-hibernation-row`);
    await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-hibernation-resume"]').click();
    await frame.locator('[data-testid="cnpg-resume-cluster-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-action-resume-cluster`);
    await cluster.cancelDialog(frame);
    await cluster.closeDetails(frame);

    await table(frame, "e2e-fenced").click();
    await frame
      .locator('.Drawer.KubeObjectDetails [data-testid="cnpg-fenced-lift-all"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-cluster-drawer-fenced-row`);
    await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-fenced-lift-all"]').click();
    await frame.locator('[data-testid="cnpg-lift-fence-dialog"]').waitFor({ state: "visible", timeout: 60_000 });
    await shot(`${theme}-action-lift-fences`);
    await cluster.cancelDialog(frame);
    await cluster.closeDetails(frame);

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
    "offers the write actions only where they make sense, and says why where they do not (SPEC-0020 to SPEC-0024)",
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
      const primaries = () =>
        cluster.kubectlE2E(
          "get",
          "clusters.postgresql.cnpg.io",
          "--all-namespaces",
          "-o",
          'jsonpath={range .items[*]}{.metadata.namespace}/{.metadata.name}={.status.targetPrimary}{"\n"}{end}',
        ).stdout;
      const restarts = () =>
        cluster.kubectlE2E(
          "get",
          "clusters.postgresql.cnpg.io",
          "--all-namespaces",
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}={.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}|{.metadata.annotations.cnpg\\.io/reloadedAt}|{.metadata.annotations.cnpg\\.io/fencedInstances}|{.metadata.annotations.cnpg\\.io/hibernation}{"\n"}{end}',
        ).stdout;
      const pods = () =>
        cluster.kubectlE2E(
          "get",
          "pods",
          "--all-namespaces",
          "--selector",
          "cnpg.io/podRole=instance",
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}={.metadata.uid}{"\n"}{end}',
        ).stdout;
      const before = backups();
      const suspendedBefore = suspensions();
      const primariesBefore = primaries();
      const restartsBefore = restarts();
      const podsBefore = pods();

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

      await record(
        "Create Cluster form: OK carries the first reason, the YAML pane is the body, looking creates nothing (SPEC-0025)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          try {
            await frame.locator(".AddRemoveButtons .add-button").click();

            const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

            await dialog.waitFor({ state: "visible", timeout: 60_000 });

            const blocked = await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText();

            if (blocked !== "A name is required") throw new Error(`unexpected reason "${blocked}"`);
            if (!(await frame.locator('[data-testid="confirm"]').isDisabled())) throw new Error("OK is enabled");
            await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill("review-cluster");
            await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("10Gi");

            const yaml =
              (await dialog.locator('[data-testid="cnpg-create-cluster-yaml"]').getAttribute("data-yaml")) ?? "";
            const writes = await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts();

            if (!yaml.includes("  name: review-cluster\n") || !yaml.includes("    size: 10Gi\n")) {
              throw new Error(`the YAML pane does not carry the form: ${JSON.stringify(yaml)}`);
            }
            if (
              writes.length !== 1 ||
              !writes[0].startsWith("create Cluster cnpg-e2e-actions/review-cluster: 3 instances")
            ) {
              throw new Error(`unexpected writes ${JSON.stringify(writes)}`);
            }
            await checks.expectNoAuthoredColors(frame, "Create Cluster form");
            await cluster.cancelDialog(frame);
            if (cluster.kubectlActions("get", "clusters.postgresql.cnpg.io", "review-cluster").status === 0) {
              throw new Error("looking created a cluster");
            }
          } finally {
            await cluster.selectNamespace(frame);
          }
        },
      );

      await record(
        "Create ScheduledBackup form: the expression follows the preset, with its words and its next runs (SPEC-0026)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          try {
            await frame.locator(".AddRemoveButtons .add-button").click();

            const dialog = frame.locator('[data-testid="cnpg-create-schedule"]');

            await dialog.waitFor({ state: "visible", timeout: 60_000 });
            await dialog.locator('[data-testid="cnpg-create-schedule-preset-hourly"]').check();
            await dialog.locator('[data-testid="cnpg-create-schedule-minute"]').fill("15");

            const expression = await dialog
              .locator('[data-testid="cnpg-create-schedule-expression-value"]')
              .innerText();
            const runs = await dialog.locator('[data-testid="cnpg-create-schedule-next-runs"]').innerText();

            if (expression !== "0 15 * * * *") throw new Error(`unexpected expression "${expression}"`);
            if (!/^Next runs: (.+:15:00 UTC, ){2}.+:15:00 UTC$/.test(runs))
              throw new Error(`unexpected runs "${runs}"`);
            await checks.expectNoAuthoredColors(frame, "Create ScheduledBackup form");
            await cluster.cancelDialog(frame);
          } finally {
            await cluster.selectNamespace(frame);
          }
        },
      );

      await record(
        "Create Pooler and Create ObjectStore forms: OK carries the first reason, looking creates nothing (SPEC-0026)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-pooling-poolers", "Poolers");
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          try {
            await frame.locator(".AddRemoveButtons .add-button").click();

            const pooler = frame.locator('[data-testid="cnpg-create-pooler"]');

            await pooler.waitFor({ state: "visible", timeout: 60_000 });

            const poolerReason = await pooler.locator('[data-testid="cnpg-action-blocked"]').innerText();

            if (poolerReason !== "Pick a cluster") throw new Error(`unexpected reason "${poolerReason}"`);
            await checks.expectNoAuthoredColors(frame, "Create Pooler form");
            await cluster.cancelDialog(frame);

            await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
            await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
            await frame.locator(".AddRemoveButtons .add-button").click();

            const store = frame.locator('[data-testid="cnpg-create-object-store"]');

            await store.waitFor({ state: "visible", timeout: 60_000 });

            const storeReason = await store.locator('[data-testid="cnpg-action-blocked"]').innerText();

            if (storeReason !== "A name is required") throw new Error(`unexpected reason "${storeReason}"`);
            await checks.expectNoAuthoredColors(frame, "Create ObjectStore form");
            await cluster.cancelDialog(frame);
            const leftovers = [
              "poolers.postgresql.cnpg.io/review-pooler",
              "objectstores.barmancloud.cnpg.io/review-store",
            ];
            for (const leftover of leftovers) {
              const [resource, name] = leftover.split("/");
              if (cluster.kubectlActions("get", resource, name).status === 0)
                throw new Error(`looking created ${leftover}`);
            }
          } finally {
            await cluster.selectNamespace(frame);
          }
        },
      );

      await record(
        "Create Database, DatabaseRole, Publication and Subscription forms: the SQL is said before the click, looking creates nothing (SPEC-0027)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          try {
            await frame.locator(".AddRemoveButtons .add-button").click();

            const database = frame.locator('[data-testid="cnpg-create-database"]');

            await database.waitFor({ state: "visible", timeout: 60_000 });
            await pickCluster(frame, "cnpg-create-database-cluster");
            await database.locator('[data-testid="cnpg-create-database-name"]').fill("review-orders");
            await database.locator('[data-testid="cnpg-create-database-dbname"]').fill("orders");

            const ownerPicker = frame.locator("#cnpg-create-database-owner");

            await ownerPicker.waitFor({ state: "visible", timeout: 60_000 });
            await ownerPicker.fill("app");
            await ownerPicker.press("Enter");

            const notes = await database.locator('[data-testid="cnpg-action-writes"] ~ p').allInnerTexts();

            if (!notes.some((note) => note.includes("CREATE DATABASE orders OWNER app"))) {
              throw new Error(`the SQL is not said: ${JSON.stringify(notes)}`);
            }
            await checks.expectNoAuthoredColors(frame, "Create Database form");
            await cluster.cancelDialog(frame);

            await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
            await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
            await frame.locator(".AddRemoveButtons .add-button").click();

            const subscription = frame.locator('[data-testid="cnpg-create-subscription"]');

            await subscription.waitFor({ state: "visible", timeout: 60_000 });
            await pickCluster(frame, "cnpg-create-subscription-cluster");

            const reason = await subscription.locator('[data-testid="cnpg-action-blocked"]').innerText();

            if (reason !== "A name is required") throw new Error(`unexpected reason "${reason}"`);
            await checks.expectNoAuthoredColors(frame, "Create Subscription form");
            await cluster.cancelDialog(frame);
            for (const leftover of [
              "databases.postgresql.cnpg.io/review-orders",
              "subscriptions.postgresql.cnpg.io/review-numbers-sub",
            ]) {
              const [resource, name] = leftover.split("/");
              if (cluster.kubectlActions("get", resource, name).status === 0)
                throw new Error(`looking created ${leftover}`);
            }
          } finally {
            await cluster.selectNamespace(frame);
          }
        },
      );

      await record(
        "A switchover is refused, with the reason, where there is nothing to promote (SPEC-0022)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");

          for (const [name, expected] of [
            ["e2e-single", "There is no standby to promote"],
            ["e2e-hibernated", "hibernated"],
          ]) {
            await cluster.openRowMenu(frame, name);

            const item = frame.locator('.Menu [data-testid="cnpg-cluster-switchover-menu-item"]').first();

            await item.waitFor({ state: "visible", timeout: 60_000 });

            const title = (await item.getAttribute("title")) ?? "";
            const classes = (await item.getAttribute("class")) ?? "";

            await cluster.closeRowMenu(frame);
            if (!classes.includes("disabled")) throw new Error(`"Switchover" of ${name} should be refused`);
            if (!title.includes(expected))
              throw new Error(`the reason of ${name} should say "${expected}", got "${title}"`);
          }
        },
      );

      await record(
        "The dialog of a switchover keeps OK disabled until the name of the cluster is typed (W5)",
        async () => {
          await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
          try {
            await cluster.openRowMenu(frame, cluster.E2E_ACTIONS_CLUSTER);
            await frame.locator('.Menu [data-testid="cnpg-cluster-switchover-menu-item"]').first().click();

            const dialog = frame.locator('[data-testid="cnpg-switchover-dialog"]');

            await dialog.waitFor({ state: "visible", timeout: 60_000 });

            const ok = frame.locator('[data-testid="confirm"]');
            const before = await ok.isDisabled();
            const eligible = await dialog.locator('[data-eligible="true"] input[type="radio"]:checked').count();
            const writes = await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts();

            await cluster.cancelDialog(frame);
            if (!before) throw new Error("OK is enabled before the name is typed");
            if (eligible !== 1) throw new Error(`one eligible standby should be proposed, found ${eligible}`);
            if (writes.length !== 1 || !writes[0].includes("(status): targetPrimary ")) {
              throw new Error(`unexpected writes ${JSON.stringify(writes)}`);
            }
          } finally {
            await cluster.selectNamespace(frame);
          }
        },
      );

      await record("Restart and Reload are refused on a hibernated cluster, with the reason (SPEC-0023)", async () => {
        await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
        await cluster.openRowMenu(frame, "e2e-hibernated");

        const titles: string[] = [];

        for (const action of ["restart", "reload"]) {
          const item = frame.locator(`.Menu [data-testid="cnpg-cluster-${action}-menu-item"]`).first();

          await item.waitFor({ state: "visible", timeout: 60_000 });
          titles.push(`${(await item.getAttribute("class")) ?? ""}|${(await item.getAttribute("title")) ?? ""}`);
        }
        await cluster.closeRowMenu(frame);
        for (const title of titles) {
          if (!title.includes("disabled") || !title.includes("hibernated")) {
            throw new Error(`a refusal that names the hibernation was expected, got "${title}"`);
          }
        }
      });

      await record("The restart of a fenced instance is refused, and points at the fence (SPEC-0023)", async () => {
        await table(frame, "e2e-fenced").click();

        const button = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-instance-restart-e2e-fenced-1"]');

        await button.waitFor({ state: "visible", timeout: 60_000 });

        const title = (await button.getAttribute("title")) ?? "";
        const disabled = await button.getAttribute("aria-disabled");

        await cluster.closeDetails(frame);
        if (disabled !== "true") throw new Error("the restart of the fenced instance should be refused");
        if (!title.includes("lift the fence")) throw new Error(`the reason should point at the fence, got "${title}"`);
      });

      await record(
        "The dialog of a cluster restart lists the rollout in order, the primary last (SPEC-0023)",
        async () => {
          await cluster.openRowMenu(frame, "e2e-main");
          await frame.locator('.Menu [data-testid="cnpg-cluster-restart-menu-item"]').first().click();

          const dialog = frame.locator('[data-testid="cnpg-restart-dialog"]');

          await dialog.waitFor({ state: "visible", timeout: 60_000 });

          const steps = await dialog.locator('[data-testid="cnpg-restart-plan"] li').allInnerTexts();
          const kinds = await dialog
            .locator('[data-testid="cnpg-restart-plan"] li')
            .evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")));
          const ok = await frame.locator('[data-testid="confirm"]').isDisabled();

          await cluster.cancelDialog(frame);
          if (steps.length !== 3)
            throw new Error(`three steps were expected for e2e-main, got ${JSON.stringify(steps)}`);
          if (kinds.join(",") !== "standby,standby,primary") throw new Error(`unexpected order ${kinds.join(",")}`);
          if (!ok) throw new Error("OK is enabled before the name is typed");
        },
      );

      await record(
        "A cluster offers the way back where it sleeps or is fenced, and not the way in (SPEC-0024)",
        async () => {
          await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");

          for (const [name, offered, absent] of [
            ["e2e-hibernated", "cnpg-cluster-resume-menu-item", "cnpg-cluster-hibernate-menu-item"],
            ["e2e-fenced", "cnpg-cluster-lift-all-menu-item", "cnpg-cluster-fence-all-menu-item"],
            ["e2e-main", "cnpg-cluster-hibernate-menu-item", "cnpg-cluster-resume-menu-item"],
            ["e2e-main", "cnpg-cluster-fence-all-menu-item", "cnpg-cluster-lift-all-menu-item"],
          ]) {
            await cluster.openRowMenu(frame, name);
            await frame
              .locator(`.Menu [data-testid="${offered}"]`)
              .first()
              .waitFor({ state: "visible", timeout: 60_000 });

            const other = await frame.locator(`.Menu [data-testid="${absent}"]`).count();

            await cluster.closeRowMenu(frame);
            if (other !== 0) throw new Error(`${name} offers ${absent} next to ${offered}`);
          }
        },
      );

      await record("Fencing is refused on a hibernated cluster, with the reason (SPEC-0024)", async () => {
        await cluster.openRowMenu(frame, "e2e-hibernated");

        const item = frame.locator('.Menu [data-testid="cnpg-cluster-fence-all-menu-item"]').first();

        await item.waitFor({ state: "visible", timeout: 60_000 });

        const title = (await item.getAttribute("title")) ?? "";
        const classes = (await item.getAttribute("class")) ?? "";

        await cluster.closeRowMenu(frame);
        if (!classes.includes("disabled") || !title.includes("hibernated")) {
          throw new Error(`a refusal that names the hibernation was expected, got "${classes}" and "${title}"`);
        }
      });

      await record("The dialog of a hibernation lists what is attached to the cluster (SPEC-0024)", async () => {
        const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");

        await cluster.openRowMenu(frame, "e2e-main");
        await frame.locator('.Menu [data-testid="cnpg-cluster-hibernate-menu-item"]').first().click();

        const dialog = frame.locator('[data-testid="cnpg-hibernate-dialog"]');

        await dialog.waitFor({ state: "visible", timeout: 60_000 });

        const pods = await dialog.locator('[data-testid="cnpg-hibernation-pods"] li').allInnerTexts();
        const volumes = await dialog.locator('[data-testid="cnpg-hibernation-volumes"] li').count();
        const schedules = await dialog.locator('[data-testid="cnpg-hibernation-schedules"] li').allInnerTexts();
        const declared = await dialog.locator('[data-testid="cnpg-hibernation-declared"] li').count();
        const ok = await frame.locator('[data-testid="confirm"]').isDisabled();
        // The typed name takes the focus at the bottom of a long dialog: it must still open at its first line.
        const scrolled = await dialog.evaluate((element) => element.scrollTop);

        await cluster.cancelDialog(frame);
        if (pods.length !== 3 || !pods[0].startsWith(`${primary} (primary, first`)) {
          throw new Error(`three pods with the primary ${primary} first were expected, got ${JSON.stringify(pods)}`);
        }
        if (volumes < 3) throw new Error(`the volumes of three instances were expected, got ${volumes}`);
        if (!schedules.some((line) => line.startsWith("e2e-nightly"))) {
          throw new Error(`the schedule e2e-nightly was expected, got ${JSON.stringify(schedules)}`);
        }
        if (declared === 0) throw new Error("the declared objects of e2e-main were expected");
        if (scrolled !== 0)
          throw new Error(`the dialog opened scrolled by ${scrolled} px: its subject is out of sight`);
        if (!ok) throw new Error("OK is enabled before the name is typed");
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

        if (restarts() !== restartsBefore) throw new Error("an annotation of an action changed during the pass");
        if (pods() !== podsBefore) throw new Error("an instance pod was replaced during the pass");

        const primariesAfter = primaries();

        if (primariesAfter !== primariesBefore) {
          throw new Error(`a target primary changed during the pass: "${primariesBefore}" then "${primariesAfter}"`);
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
