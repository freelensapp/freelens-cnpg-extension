/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The features of M9 (SPEC-0031 to SPEC-0039) on Freelens dev over CDP,
// against the kind cluster of `pnpm e2e:cluster:up` (SPEC-0002). Read-only:
// the write of a feature, when it has one, goes to `cnpg-writes.tests.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as cluster from "./cnpg-cluster";
import { appReady, connectApp, dismissNotifications, installExtension, openLabCluster } from "./cnpg-session";
import { tableRowName, waitUntil } from "./cnpg-steps";

import type { Frame } from "playwright";

import type { AppSession } from "./cnpg-session";

const TIMEOUT = 10 * 60 * 1000;

/** The text of a locator as one line. */
async function textOf(locator: ReturnType<Frame["locator"]>): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, " ").trim();
}

describe.skipIf(!(await appReady({ cluster: true })))("CloudNativePG extension: the features of M9", () => {
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
      await cluster.closeDetails(frame).catch(() => {});
      await cluster.clearNotifications(frame).catch(() => {});
      await dismissNotifications(session.window);
    }
  });

  afterAll(async () => {
    await session?.close();
  });

  it(
    "shows the multixact age, the extension updates, the checkpoints of each instance and three lags per standby (SPEC-0033)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
      await cluster.selectNamespace(frame);
      await frame.locator('[data-testid="cnpg-live-door-cnpg-e2e-e2e-main"]').click();

      const databases = frame.locator('[data-testid="cnpg-live-databases"]');

      await databases.locator('[data-testid="cnpg-live-mxid-app"]').waitFor({ state: "visible", timeout: 90_000 });
      expect(await textOf(databases.locator('[data-testid="cnpg-live-mxid-app"]'))).toMatch(/^\d[\d,]*$/);
      expect(await databases.locator('[data-testid="cnpg-live-mxid-app"]').getAttribute("title")).toContain(
        "autovacuum_multixact_freeze_max_age",
      );
      expect(await textOf(databases.locator('[data-testid="cnpg-live-extension-updates"]'))).toMatch(
        /^Extension updates available: (none|\d+, in .+)$/,
      );

      // Every instance of e2e-main answers its metrics: one block each, restartpoints on the standbys.
      const instances = ["e2e-main-1", "e2e-main-2", "e2e-main-3"];
      const primary = cluster.kubectlField("clusters.postgresql.cnpg.io", "e2e-main", "{.status.currentPrimary}");
      const checkpoints = frame.locator('[data-testid="cnpg-live-checkpoints"]');

      for (const instance of instances) {
        const block = checkpoints.locator(`[data-testid="cnpg-live-checkpoints-${instance}"]`);

        await block.waitFor({ state: "visible", timeout: 90_000 });
        const text = await textOf(block);

        // The labels of the figures are upper case on screen (CSS).
        expect(text).toMatch(/Checkpoints \d[\d,]* timed, \d[\d,]* requested/i);
        expect(text).toMatch(/Buffers written \d/i);
        if (instance === primary) expect(text.toLowerCase()).not.toContain("restartpoints");
        else expect(text).toMatch(/Restartpoints \d[\d,]* timed, \d[\d,]* requested, \d[\d,]* done/i);
      }

      // Write, flush and replay of each standby, in time and in bytes.
      for (const standby of instances.filter((instance) => instance !== primary)) {
        const stages = frame.locator(`[data-testid="cnpg-live-lag-stages-${standby}"]`);

        await stages.waitFor({ state: "visible", timeout: 90_000 });
        for (const stage of ["write", "flush", "replay"]) {
          expect(await textOf(stages.locator(`[data-stage="${stage}"]`))).toMatch(
            new RegExp(`^${stage} (\\d+ ms|N/A|\\d.*) · \\d`),
          );
        }
      }
      await cluster.captureScreenshot(frame, "m9-live-main-dark");
    },
    TIMEOUT,
  );

  it(
    "shows the volumes of a cluster as one table, with its tablespace volume (SPEC-0034)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await tableRowName(frame, cluster.E2E_SNAPSHOT_CLUSTER).click();

      const volumes = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-volumes"]');

      await volumes.waitFor({ state: "visible", timeout: 60_000 });
      const data = volumes.locator(`[data-testid="cnpg-cluster-volume-${cluster.E2E_SNAPSHOT_CLUSTER}-1"]`);
      const tablespace = volumes.locator(
        `[data-testid="cnpg-cluster-volume-${cluster.E2E_SNAPSHOT_CLUSTER}-1-tbs-${cluster.E2E_SNAPSHOT_TABLESPACE}"]`,
      );

      expect(
        await waitUntil(
          () => textOf(data),
          (text) => text.includes("healthy"),
        ),
      ).toMatch(
        new RegExp(
          `${cluster.E2E_SNAPSHOT_CLUSTER}-1 ${cluster.E2E_SNAPSHOT_CLUSTER}-1 data healthy 1Gi ${cluster.E2E_STORAGE_CLASS}`,
        ),
      );
      expect(await textOf(tablespace)).toMatch(
        new RegExp(`tablespace ${cluster.E2E_SNAPSHOT_TABLESPACE} healthy 512Mi ${cluster.E2E_STORAGE_CLASS}`),
      );
      // The claim is a link to the host's own view of it.
      expect(await data.locator("a").count()).toBeGreaterThan(0);
      await volumes.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "m9-volumes-dark");
      await cluster.closeDetails(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "says what a replica cluster replicates, and the Live View draws its designated primary (SPEC-0034)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_REPLICA_NAMESPACE);
      await tableRowName(frame, cluster.E2E_REPLICA_CLUSTER).click();

      const section = frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-cluster-replica"]');

      await section.waitFor({ state: "visible", timeout: 60_000 });
      const text = await textOf(section);
      const designated = cluster.kubectlE2E(
        "--namespace",
        cluster.E2E_REPLICA_NAMESPACE,
        "get",
        "clusters.postgresql.cnpg.io",
        cluster.E2E_REPLICA_CLUSTER,
        "--output",
        "jsonpath={.status.currentPrimary}",
      ).stdout;

      expect(text).toContain("Replicates e2e-main-origin, object store replica-store (barman-cloud.cloudnative-pg.io)");
      expect(text).toContain(`Designated primary ${designated}`);
      expect(text).toContain("Set spec.replica.enabled to false");
      await section.scrollIntoViewIfNeeded();
      await cluster.captureScreenshot(frame, "m9-replica-drawer-dark");
      await cluster.closeDetails(frame);

      await cluster.openCnpgPage(frame, "cnpg-clusters-live", "Live View");
      await frame
        .locator(`[data-testid="cnpg-live-door-${cluster.E2E_REPLICA_NAMESPACE}-${cluster.E2E_REPLICA_CLUSTER}"]`)
        .click();
      const card = frame.locator(`[data-testid="cnpg-live-instance-${designated}"]`);

      await card.waitFor({ state: "visible", timeout: 90_000 });
      expect(
        await waitUntil(
          () => card.getAttribute("data-role"),
          (role) => role === "primary",
        ),
      ).toBe("primary");
      expect(await textOf(card)).toContain("designated primary");
      expect(await textOf(card)).not.toContain("WAL receiver down");
      await cluster.captureScreenshot(frame, "m9-replica-live-dark");
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "counts the clusters by health above the list, and each count filters it (SPEC-0034)",
    async () => {
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);

      const counts = frame.locator('[data-testid="cnpg-clusters-counts"]');
      const rows = frame.locator(".TableRow");

      await counts.waitFor({ state: "visible", timeout: 60_000 });
      await cluster.expectRow(frame, "e2e-main", "Healthy");
      // The four fixtures of cnpg-e2e: e2e-main healthy, e2e-hibernated asleep, e2e-single and e2e-fenced degraded.
      expect(
        await waitUntil(
          () => textOf(counts),
          (text) => text.startsWith("4 clusters"),
        ),
      ).toBe("4 clusters 1 healthy 1 hibernated 2 need attention 4/6 instances ready");

      await counts.locator('[data-testid="cnpg-clusters-count-attention"]').click();
      expect(
        await waitUntil(
          async () => (await rows.allInnerTexts()).map((row) => row.split(/\s+/)[0]).sort(),
          (names) => names.length === 2,
        ),
      ).toEqual(["e2e-fenced", "e2e-single"]);
      await cluster.captureScreenshot(frame, "m9-counts-attention-dark");

      await counts.locator('[data-testid="cnpg-clusters-count-hibernated"]').click();
      expect(
        await waitUntil(
          async () => (await rows.allInnerTexts()).map((row) => row.split(/\s+/)[0]),
          (names) => names.length === 1,
        ),
      ).toEqual(["e2e-hibernated"]);

      // The same filter again, or the total, shows every cluster.
      await counts.locator('[data-testid="cnpg-clusters-count-hibernated"]').click();
      expect(
        await waitUntil(
          () => rows.count(),
          (count) => count === 4,
        ),
      ).toBe(4);
    },
    TIMEOUT,
  );

  it("logs no error", () => {
    expect(session.errors()).toEqual([]);
  });
});
