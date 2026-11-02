/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the integration sessions share, after the template's `extension-helpers.ts`: they attach over the Chrome
// DevTools Protocol to Freelens started with `pnpm dev` from a freelensapp/freelens checkout, and drive its renderer
// with Playwright. The cluster is the kind cluster of `pnpm e2e:cluster:up` (SPEC-0002), whose kubeconfig is
// `.e2e/kubeconfig`; Freelens must sync that file and no other. Nothing reads or changes the developer's kubeconfig,
// and a kubeconfig that names a server other than a local one is refused. Its name does not match `*.tests.ts`, so
// Vitest does not collect it as a test file.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright";

import type { Browser, ConsoleMessage, Frame, Locator, Page } from "playwright";

/** Name of this extension, as published and as shown by the extensions page. */
export const EXTENSION_NAME = "@freelensapp/cnpg-extension";

/** The root of this checkout, installed in place. */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const cdpUrl = process.env.FREELENS_CDP_URL || "http://127.0.0.1:9223";

// The log of the main process, which CDP does not carry: the output of `pnpm dev` of Freelens.
const mainLogFile = process.env.FREELENS_MAIN_LOG;

/** The lab's kubeconfig (`e2e/scripts/lib.sh`) and context: nothing else is used. */
export const labKubeconfig = process.env.E2E_KUBECONFIG || path.join(repoRoot, ".e2e", "kubeconfig");
export const labContext = `kind-${process.env.E2E_CLUSTER_NAME || "cnpg-e2e"}`;

const sanitizedExtensionId = EXTENSION_NAME.replace("@", "").replace("/", "--");

const viewTimeout = { timeout: 60 * 1000 };
/** Connecting a cluster starts a proxy, and the extension loads in its frame after it. */
const clusterTimeout = { timeout: 5 * 60 * 1000 };

const ansiEscapePattern = /\u001b\[[0-9;]*m/g;

export interface AppSession {
  browser: Browser;
  /** The root frame's page, where the catalog and the extensions render. */
  window: Page;
  /** The errors logged so far. */
  errors(): string[];
  /**
   * Drops the errors logged so far that match `pattern`, and says how many: for the errors a case causes on
   * purpose (an instance it restarts answers 503 meanwhile). The pattern is the case's to keep narrow.
   */
  forgetErrors(pattern: RegExp): number;
  /** Stops collecting errors and closes the connection; returns every error logged. */
  close(): Promise<string[]>;
}

/** Why the lab kubeconfig cannot be used, or undefined. */
export function labKubeconfigProblem(): string | undefined {
  if (!fs.existsSync(labKubeconfig)) return `no lab kubeconfig at ${labKubeconfig}: run 'pnpm e2e:cluster:up'`;
  const text = fs.readFileSync(labKubeconfig, "utf8");
  const servers = [...text.matchAll(/^\s*server:\s*(\S+)\s*$/gm)].map((match) => match[1]);

  if (
    servers.length === 0 ||
    servers.some((server) => !/^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(server))
  ) {
    return `${labKubeconfig} names a server that is not local`;
  }
  return undefined;
}

/**
 * Whether Freelens dev answers on its CDP endpoint and the lab cluster is reachable. Outside CI a session skips with a
 * warning otherwise; in CI the run fails.
 */
export async function appReady({ cluster }: { cluster: boolean }): Promise<boolean> {
  let reason: string | undefined;

  try {
    const response = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(5000) });

    if (!response.ok) reason = `${cdpUrl} answered ${response.status}`;
  } catch (error) {
    reason = `Freelens dev does not answer on ${cdpUrl}: ${error instanceof Error ? error.message : error}`;
  }
  if (!reason && cluster) {
    reason = labKubeconfigProblem();
    if (
      !reason &&
      spawnSync("kubectl", ["--kubeconfig", labKubeconfig, "--context", labContext, "get", "--raw", "/readyz"])
        .status !== 0
    ) {
      reason = `the lab cluster ${labContext} is not reachable`;
    }
  }
  if (!reason) return true;
  if (process.env.CI) throw new Error(`Cannot run the integration tests: ${reason}`);
  console.warn(`Skipping the integration tests: ${reason}`);
  return false;
}

// The host's kubectl proxy logs at error level every request its client gave up on before the API server answered,
// in a framed record (┏ … ┗). That is what closing a drawer does to the reference loads it had just started: an abort
// on purpose, not a failure.
const canceledProxyPattern = /context canceled/;

// Chromium logs every response that is not a success. A `409` on a cluster (or its status) is the conflict of rule W6
// (SPEC-0020): the patch carries the resource version it was computed from, and the action reads the cluster again and
// retries or reopens its dialog. Reads never answer `409`.
const expectedConflictPattern =
  /^Failed to load resource: the server responded with a status of 409 \(\) @ https:\/\/[^/]+\/api-kube\/apis\/postgresql\.cnpg\.io\/v1\/namespaces\/[^/]+\/clusters\/[^/]+(\/status)?$/;

// A refusal of a dry run is what the server check of every creation form (SPEC-0032) asks for: the API server or the
// operator's webhook says what is wrong before anything exists. Only `dryRun=All` creates are let through.
const expectedDryRunRefusalPattern =
  /^Failed to load resource: the server responded with a status of (400|409|422) \(\) @ https:\/\/[^/]+\/api-kube\/apis\/postgresql\.cnpg\.io\/v1\/(namespaces\/[^/]+\/)?[a-z]+\?dryRun=All$/;

function collectErrors(window: Page) {
  const errorLogs: string[] = [];
  let mainLogOffset = mainLogFile && fs.existsSync(mainLogFile) ? fs.statSync(mainLogFile).size : 0;
  let record: string[] | undefined;

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const line = `${msg.text().replaceAll(ansiEscapePattern, "")} @ ${msg.location().url}`;

    if (!expectedConflictPattern.test(line) && !expectedDryRunRefusalPattern.test(line))
      errorLogs.push(`[renderer] ${line}`);
  };
  const onPageError = (error: Error) => {
    errorLogs.push(`[renderer] ${error.stack ?? error.message}`);
  };
  const mainLine = (line: string) => {
    const text = line.replaceAll(ansiEscapePattern, "");

    if (!/^(?:[\w@/.-]+:[\w:-]+: )?\s*error:/.test(text)) return;
    if (record) {
      record.push(text.trim());
      if (text.includes("┗")) {
        if (!record.some((part) => canceledProxyPattern.test(part))) errorLogs.push(`[main] ${record.join("\n")}`);
        record = undefined;
      }
      return;
    }
    if (text.includes("┏") && !text.includes("┗")) {
      record = [text.trim()];
      return;
    }
    if (!canceledProxyPattern.test(text)) errorLogs.push(`[main] ${text.trim()}`);
  };
  const readMainLog = () => {
    if (!mainLogFile || !fs.existsSync(mainLogFile)) return;
    const size = fs.statSync(mainLogFile).size;

    if (size < mainLogOffset) mainLogOffset = 0;
    if (size === mainLogOffset) return;
    const fd = fs.openSync(mainLogFile, "r");

    try {
      const buffer = Buffer.alloc(size - mainLogOffset);

      fs.readSync(fd, buffer, 0, buffer.length, mainLogOffset);
      mainLogOffset = size;
      for (const line of buffer.toString("utf8").split("\n")) mainLine(line);
    } finally {
      fs.closeSync(fd);
    }
  };

  window.on("console", onConsole);
  window.on("pageerror", onPageError);
  return {
    errors: () => {
      readMainLog();
      return [...errorLogs];
    },
    forget: (pattern: RegExp) => {
      readMainLog();
      const kept = errorLogs.filter((line) => !pattern.test(line));
      const dropped = errorLogs.length - kept.length;
      errorLogs.splice(0, errorLogs.length, ...kept);
      return dropped;
    },
    stop: () => {
      window.off("console", onConsole);
      window.off("pageerror", onPageError);
    },
  };
}

async function rootPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + viewTimeout.timeout;

  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (candidate) => URL.canParse(candidate.url()) && new URL(candidate.url()).hostname === "renderer.freelens.app",
      );

    if (page) {
      await page.waitForFunction(() => globalThis.FreelensExtensionApi?.Renderer !== undefined, null, viewTimeout);
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No Freelens window on ${cdpUrl}`);
}

/** Connects to Freelens dev; closing the session closes only the connection, the app keeps running. */
export async function connectApp(): Promise<AppSession> {
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const window = await rootPage(browser);
    const collector = collectErrors(window);

    return {
      browser,
      window,
      errors: collector.errors,
      forgetErrors: collector.forget,
      close: async () => {
        const errors = collector.errors();

        collector.stop();
        await browser.close();
        return errors;
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Navigates a frame with the extension API: the application menu belongs to the main process. */
export async function navigate(target: Page | Frame, url: string) {
  await target.evaluate((to) => {
    const renderer = globalThis.FreelensExtensionApi.Renderer;

    if (!renderer) throw new Error("The page has no Renderer API");
    renderer.Navigation.navigate(to);
  }, url);
}

/**
 * Dismisses the notifications, so that one in its enter animation does not take a click. Only the close icons inside
 * the host's notification list: the close button of a full-screen page (the Extensions page) is a "Close" too.
 */
export async function dismissNotifications(target: Page | Frame) {
  const selector = '.Notifications [data-testid^="close-notification-for-"]';

  for (let attempt = 0; attempt < 10; attempt++) {
    const buttons = await target.$$(selector);

    if (buttons.length === 0) break;
    for (const button of buttons) await button.click({ force: true }).catch(() => {});
    await target.waitForTimeout(200);
  }
}

async function uninstallExtension(window: Page, row: Locator) {
  await row.locator('[id^="menu-actions-for-installed-extensions-for-"]').click();
  await window.locator(".MenuActions .MenuItem").getByText("Uninstall", { exact: true }).click();
  await window.getByTestId("confirmation-dialog").getByTestId("confirm").click();
  await row.waitFor({ state: "detached", ...viewTimeout });
}

/**
 * Installs this checkout in place from the Extensions page and waits until it is enabled; an enabled installation of
 * the checkout is kept unless `reinstall`, any other installation of the extension is uninstalled first.
 */
export async function installExtension({ window }: AppSession, { reinstall = false } = {}) {
  await navigate(window, "/extensions");
  const table = window.getByTestId("extensions-table");
  const row = table.locator("tbody tr", { hasText: EXTENSION_NAME });
  const enabled = row.locator("td").nth(2).getByText("Enabled", { exact: true });

  await table.or(window.getByText("There are no extensions installed.", { exact: true })).waitFor(viewTimeout);
  if (await row.count()) {
    const inPlace = await row.locator(`[title="Loaded in place from ${repoRoot}"]`).count();

    if (inPlace && !reinstall && (await enabled.count())) return;
    await uninstallExtension(window, row);
  }
  await window.getByPlaceholder("Name, URL, or path to a package or directory").fill(repoRoot);
  // The notification of an uninstall, or of the load of a rebuild, sits over the Install button.
  await dismissNotifications(window);
  await window.getByRole("button", { name: "Install", exact: true }).click();
  await window.getByTestId("confirmation-dialog").getByTestId("confirm").click(viewTimeout);
  await enabled.waitFor(viewTimeout);
  await dismissNotifications(window);
}

/** Disables or enables the extension from the Extensions page, and waits for its status (SPEC-0031). */
export async function setExtensionEnabled({ window }: AppSession, enabled: boolean) {
  await navigate(window, "/extensions");
  const table = window.getByTestId("extensions-table");
  const row = table.locator("tbody tr", { hasText: EXTENSION_NAME });
  const status = enabled ? "Enabled" : "Disabled";

  await row.waitFor(viewTimeout);
  await dismissNotifications(window);
  await row.locator('[id^="menu-actions-for-installed-extensions-for-"]').click();
  // Freelens 2 labels the item of a disabled extension "Enabled" (installed-extensions.tsx): both are taken.
  await window
    .locator(".MenuActions .MenuItem")
    .getByText(enabled ? /^Enabled?$/ : "Disable", { exact: true })
    .click();
  await row.locator("td").nth(2).getByText(status, { exact: true }).waitFor(viewTimeout);
}

/** The catalog id of the lab cluster, looked up by its context name. */
async function labClusterId(window: Page): Promise<string> {
  const id = await window.waitForFunction(
    (name) =>
      globalThis.FreelensExtensionApi.Renderer?.Catalog.catalogEntities
        .getItemsForApiKind("entity.k8slens.dev/v1alpha1", "KubernetesCluster")
        .find((entity) => entity.getName() === name)
        ?.getId(),
    labContext,
    clusterTimeout,
  );

  return id.jsonValue() as Promise<string>;
}

/**
 * Opens the lab cluster and returns its frame, once the extension's sidebar entry is there. The page delivers the
 * console of the cluster frame too, so the session collects its errors.
 */
export async function openLabCluster(session: AppSession): Promise<Frame> {
  const problem = labKubeconfigProblem();

  if (problem) throw new Error(problem);
  const { window } = session;
  const id = await labClusterId(window);

  await navigate(window, `/cluster/${id}`);
  const element = await window.waitForSelector(`#cluster-frame-${id}`, clusterTimeout);
  const frame = await element.contentFrame();

  if (!frame) throw new Error(`No iframe for ${labContext}`);
  await frame.waitForSelector("[data-testid=cluster-sidebar]", clusterTimeout);
  await frame.waitForSelector(`[data-testid="link-for-sidebar-item-${sanitizedExtensionId}-cnpg"]`, clusterTimeout);
  return frame;
}

export type ColorTheme = "Dark" | "Light";

/**
 * Switches the app-wide color theme on the Application tab of the preferences,
 * goes back to `returnTo`, and waits until `frame` paints with the theme: the
 * pre-review of 1.0.0 took its "dark" screenshots on the light theme because
 * nothing checked that the switch had happened.
 */
export async function setColorTheme(
  { window }: AppSession,
  theme: ColorTheme,
  { frame, returnTo }: { frame?: Frame; returnTo?: string } = {},
) {
  const back = returnTo ?? new URL(window.url()).pathname;

  await navigate(window, "/preferences/app");
  // The options menu of the host select re-renders while the page settles: the pick is retried, reopening it.
  let lastError: unknown;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await window.locator("#theme-input").click(viewTimeout);
      await window.locator(".Select__option", { hasText: new RegExp(`^${theme}$`) }).click({ timeout: 10_000 });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await window
        .locator("[data-preference-tab-link-test=app]")
        .click()
        .catch(() => {});
      await window.waitForTimeout(1000);
    }
  }
  await navigate(window, back);
  if (lastError) throw lastError;

  const light = theme === "Light";
  for (const target of [window, ...(frame ? [frame] : [])]) {
    await target.waitForFunction(
      (expected) => globalThis.document.body.classList.contains("theme-light") === expected,
      light,
      viewTimeout,
    );
  }
}
