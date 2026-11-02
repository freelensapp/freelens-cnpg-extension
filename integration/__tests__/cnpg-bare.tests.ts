/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The installation guide (SPEC-0036) on a cluster without CloudNativePG: the
// bare kind cluster of `pnpm e2e:bare:up`, with Freelens dev on its
// kubeconfig. It runs only there; against the lab of `pnpm e2e:cluster:up`,
// which serves the CloudNativePG kinds, it skips. Read-only.
//
//   E2E_CLUSTER_NAME=cnpg-bare E2E_KUBECONFIG=.e2e-bare/kubeconfig \
//     pnpm test:integration integration/__tests__/cnpg-bare.tests.ts

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cluster from "./cnpg-cluster";
import {
  appReady,
  connectApp,
  EXTENSION_NAME,
  installExtension,
  labContext,
  labKubeconfig,
  navigate,
  openLabCluster,
} from "./cnpg-session";

import type { Frame } from "playwright";

import type { AppSession } from "./cnpg-session";

const TIMEOUT = 5 * 60 * 1000;
const OPERATOR_PAGE_ID = "cnpg-operator";

/** Opens a page of the extension by its id: on a bare cluster every page is the "Not Available" one, with no h5 title. */
async function openPage(frame: Frame, pageId: string, title: string): Promise<void> {
  await navigate(frame, `/extension/${EXTENSION_NAME.replace("@", "").replace("/", "--")}/${pageId}`);
  await frame.locator("h3", { hasText: title }).waitFor({ state: "visible", timeout: 60_000 });
}

/** True when the cluster serves no CloudNativePG kind: the only cluster this file runs against. */
function bare(): boolean {
  const { status, stderr } = spawnSync(
    "kubectl",
    ["--kubeconfig", labKubeconfig, "--context", labContext, "get", "crd", "clusters.postgresql.cnpg.io"],
    { encoding: "utf8" },
  );
  if (status !== 0 && !/NotFound/.test(stderr)) return false;
  if (status === 0) console.warn(`Skipping the bare cluster tests: ${labContext} serves the CloudNativePG kinds`);
  return status !== 0;
}

const ready = (await appReady({ cluster: true })) && bare();

describe.skipIf(!ready)("CloudNativePG extension on a cluster without CloudNativePG", () => {
  let session: AppSession;
  let frame: Frame;

  beforeAll(async () => {
    session = await connectApp();
    await installExtension(session);
    frame = await openLabCluster(session);
  }, TIMEOUT);

  afterAll(async () => {
    await session?.close();
  });

  it(
    "guides the installation on the Operator page: three steps, missing, with the commands of the pinned releases (SPEC-0036)",
    async () => {
      await openPage(frame, OPERATOR_PAGE_ID, "PostgreSQL Clusters Not Available");
      const guide = frame.locator('[data-testid="cnpg-install-guide"]');

      await guide.waitFor({ state: "visible", timeout: 60_000 });
      await frame.locator('[data-testid="cnpg-install-guide"][data-complete="false"]').waitFor({ timeout: 60_000 });
      const steps = guide.locator('[data-testid^="cnpg-install-step-"]');

      expect(
        await steps.evaluateAll((items) =>
          items.map((item) => [item.getAttribute("data-testid"), item.getAttribute("data-state")]),
        ),
      ).toEqual([
        ["cnpg-install-step-operator", "missing"],
        ["cnpg-install-step-cert-manager", "missing"],
        ["cnpg-install-step-barman-cloud", "missing"],
      ]);
      expect(await frame.locator('[data-testid="cnpg-install-command-operator-0"]').innerText()).toBe(
        `kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v${cluster.CNPG_VERSION}/releases/cnpg-${cluster.CNPG_VERSION}.yaml`,
      );
      expect(await frame.locator('[data-testid="cnpg-install-command-barman-cloud-0"]').innerText()).toContain(
        `/plugin-barman-cloud/releases/download/v${cluster.BARMAN_PLUGIN_VERSION}/manifest.yaml`,
      );
      expect(await frame.locator('[data-testid="cnpg-install-step-barman-cloud"]').innerText()).toContain(
        "after the operator and cert-manager",
      );
      expect(await frame.locator('[data-testid="cnpg-install-helm-operator"]').count()).toBe(1);
      await cluster.captureScreenshot(frame, "m9-install-guide-dark");

      // Copy puts the command on the clipboard and says so; nothing is run.
      const copy = frame.locator('[data-testid="cnpg-install-copy-operator-0"]');

      await copy.click();
      await frame.waitForFunction(
        (selector) => globalThis.document.querySelector(selector)?.textContent !== "Copy",
        '[data-testid="cnpg-install-copy-operator-0"]',
        { timeout: 5000 },
      );
      expect(await copy.innerText()).toBe("Copied");
    },
    TIMEOUT,
  );

  it(
    "shows the guide on the page of every kind whose CRD is missing, and Klio as an optional plugin (SPEC-0036)",
    async () => {
      await openPage(frame, "cnpg-backups-objectstores", "Object Stores Not Available");
      expect(await frame.locator("body").innerText()).toContain(
        "Barman Cloud plugin of CloudNativePG, which is optional",
      );
      await frame
        .locator('[data-testid="cnpg-install-step-barman-cloud"][data-state="missing"]')
        .waitFor({ timeout: 60_000 });

      await openPage(frame, "cnpg-backups-klioconfigurations", "Klio Configurations Not Available");
      expect(await frame.locator("body").innerText()).toContain("Klio, an optional CNPG-I backup plugin");
    },
    TIMEOUT,
  );

  it("logs no error", () => {
    expect(session.errors()).toEqual([]);
  });
});
