/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The terminal and the logs of the CloudNativePG extension (SPEC-0007,
// SPEC-0018) on Freelens dev over CDP, against the kind cluster of
// `pnpm e2e:cluster:up` (SPEC-0002): psql in the host's terminal on the
// primary and on a standby, the Logs page following the instances, its pause,
// and its door to the host's log viewer. Read-only: psql runs a SELECT.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cluster from "./cnpg-cluster";
import { appReady, connectApp, installExtension, openLabCluster } from "./cnpg-session";
import { closeDockTabs, scrollIntoView, tableRowName, terminalText, typeInTerminal, waitUntil } from "./cnpg-steps";

import type { Frame } from "playwright";

import type { AppSession } from "./cnpg-session";

const TIMEOUT = 10 * 60 * 1000;

describe.skipIf(!(await appReady({ cluster: true })))("CloudNativePG extension: the terminal and the logs", () => {
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

  afterAll(async () => {
    await session?.close();
  });

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
      await scrollIntoView(button);
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
    "pauses and resumes following, and opens the raw logs of the primary in the log viewer of Freelens (SPEC-0018)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-logs", "Logs");

      const door = frame.locator('[data-testid="cnpg-logs-door-cnpg-e2e-e2e-main"]');

      if ((await door.count()) > 0) await door.click();

      const rows = frame.locator('[data-testid="cnpg-log-row"]');
      const status = frame.locator('[data-testid="cnpg-logs-status"]');
      const follow = frame.locator('[data-testid="cnpg-logs-follow"]');

      await rows.first().waitFor({ state: "visible", timeout: 90_000 });
      expect(await status.innerText()).toContain("following every 3 s");

      // Paused: no read, so the lines stay as they are while the instances keep writing.
      await follow.click();
      expect(await follow.getAttribute("title")).toBe("Follow the logs");
      expect(await status.innerText()).toContain("not following");

      const paused = await rows.count();

      await frame.waitForTimeout(8_000);
      expect(await rows.count()).toBe(paused);

      await follow.click();
      expect(await follow.getAttribute("title")).toBe("Stop following");
      expect(
        await waitUntil(
          () => status.innerText(),
          (text) => text.includes("following every 3 s"),
        ),
      ).toContain("following every 3 s");

      // The raw lines of the primary, in the host's own log viewer (logTabStore).
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");

      await frame.locator('[data-testid="cnpg-logs-host-viewer"]').click();
      await frame
        .locator(".Dock .Tab", { hasText: `Pod ${primary}` })
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await waitUntil(
          async () => (await frame.locator(".Dock .LogRow").allInnerTexts()).join("\n"),
          (text) => text.includes('"level"'),
          90_000,
        ),
      ).toContain('"level"');
      await cluster.captureScreenshot(frame, "logs-host-viewer-dark");
      await closeDockTabs(frame, `Pod ${primary}`);
      expect(await frame.locator(".Dock .Tab", { hasText: `Pod ${primary}` }).count()).toBe(0);

      const fold = frame.locator('.Dock .Icon:has([data-icon-name="keyboard_arrow_down"])').first();

      if ((await fold.count()) > 0) await fold.click();
    },
    TIMEOUT,
  );

  it("logs no error", () => {
    expect(session.errors()).toEqual([]);
  });
});
