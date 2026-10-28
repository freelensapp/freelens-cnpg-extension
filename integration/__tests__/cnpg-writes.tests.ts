/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The write cases of the CloudNativePG extension (M6 and M7, SPEC-0020 to
// SPEC-0027 and SPEC-0029) on Freelens dev over CDP, against the kind cluster
// of `pnpm e2e:cluster:up` (SPEC-0002): each action and each creation form,
// confirmed in the dialog that names the cluster, then read back from the API
// server with kubectl on the lab's kubeconfig. They run in the namespace
// `cnpg-e2e-actions`, apart from the read-only fixtures.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as cluster from "./cnpg-cluster";
import { appReady, connectApp, dismissNotifications, installExtension, openLabCluster } from "./cnpg-session";

import type { Frame, Locator } from "playwright";

import type { AppSession } from "./cnpg-session";

const TIMEOUT = 10 * 60 * 1000;

/** One SQL statement on an instance of the write namespace, in a database of the user's choosing. Empty when it failed. */
function psqlActionsIn(pod: string, database: string, sql: string): string {
  // The namespace goes before `--`: after it every word belongs to psql (lesson of SPEC-0022).
  const { status, stdout } = cluster.kubectlE2E(
    "--namespace",
    cluster.E2E_ACTIONS_NAMESPACE,
    "exec",
    pod,
    "--container",
    "postgres",
    "--",
    "psql",
    "-U",
    "postgres",
    "-d",
    database,
    "-tAc",
    sql,
  );

  return status === 0 ? stdout.trim() : "";
}

/** Picks a value in a react-select of a form (type, then Enter). `id` is the id of the select's input. */
async function pickInSelect(frame: Frame, id: string, value: string): Promise<void> {
  const picker = frame.locator(`#${id}`);

  await picker.waitFor({ state: "visible", timeout: 60_000 });
  await picker.fill(value);
  await picker.press("Enter");
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

/**
 * Scrolls to an element that a re-render may replace under the call: the drawers redraw their lists when a
 * watch event lands, and `scrollIntoViewIfNeeded` gives up on a node that detached instead of resolving the
 * locator again. Each attempt resolves it afresh.
 */
async function scrollIntoView(locator: Locator, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded();
      return;
    } catch (error) {
      if (attempt >= attempts || !/not attached|detached|not stable/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describe.skipIf(!(await appReady({ cluster: true })))("CloudNativePG extension: the writes on the lab cluster", () => {
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

  // A notification left by a case covers the controls of the next one.
  afterEach(async () => {
    if (frame) {
      await cluster.clearNotifications(frame).catch(() => {});
      await dismissNotifications(session.window);
    }
  });

  afterAll(async () => {
    await session?.close();
  });

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
    "suspends and resumes a schedule, and requests a backup with its settings (SPEC-0021)",
    async () => {
      const schedules = "scheduledbackups.postgresql.cnpg.io";
      const backups = "backups.postgresql.cnpg.io";
      const schedule = cluster.E2E_ACTIONS_SCHEDULE;
      const subject = `ScheduledBackup ${cluster.E2E_ACTIONS_NAMESPACE}/${schedule}`;

      // Whatever an interrupted run left behind, the case starts from a schedule that is not suspended.
      cluster.kubectlActions("patch", schedules, schedule, "--type", "merge", "--patch", '{"spec":{"suspend":false}}');

      await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);

      // Suspend: exactly one of the two entries, one patch, one click.
      await cluster.openRowMenu(frame, schedule);
      await frame.locator('.Menu [data-testid="cnpg-schedule-suspend-menu-item"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
      expect(await frame.locator('.Menu [data-testid="cnpg-schedule-resume-menu-item"]').count()).toBe(0);
      await frame.locator('.Menu [data-testid="cnpg-schedule-suspend-menu-item"]').first().click();

      const suspend = frame.locator('[data-testid="cnpg-schedule-suspend-dialog"]');

      await suspend.waitFor({ state: "visible", timeout: 60_000 });
      expect(await suspend.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(subject);
      expect(await suspend.locator('[data-testid="cnpg-action-context"]').innerText()).toContain(
        cluster.E2E_KUBE_CONTEXT,
      );
      expect(await suspend.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch ScheduledBackup ${cluster.E2E_ACTIONS_NAMESPACE}/${schedule}: spec.suspend false -> true`,
      ]);
      await cluster.captureScreenshot(frame, "schedule-suspend-dialog-dark");
      // W8: nothing is written until the user confirms.
      expect(cluster.kubectlActionsField(schedules, schedule, "{.spec.suspend}")).toBe("false");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", "Suspend requested");
      expect(cluster.kubectlActionsField(schedules, schedule, "{.spec.suspend}")).toBe("true");
      await cluster.clearNotifications(frame);

      // The entry has become Resume, and a suspended schedule can still be run by hand.
      const lastScheduleTime = cluster.kubectlActionsField(schedules, schedule, "{.status.lastScheduleTime}");

      await cluster.openRowMenu(frame, schedule);
      await frame.locator('.Menu [data-testid="cnpg-schedule-resume-menu-item"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
      expect(await frame.locator('.Menu [data-testid="cnpg-schedule-suspend-menu-item"]').count()).toBe(0);
      await frame.locator('.Menu [data-testid="cnpg-schedule-run-now-menu-item"]').first().click();

      const runNow = frame.locator('[data-testid="cnpg-schedule-run-now-dialog"]');

      await runNow.waitFor({ state: "visible", timeout: 60_000 });
      expect(await runNow.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(subject);

      const writes = await runNow.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts();

      expect(writes).toHaveLength(1);

      const name = /^create Backup [^/]+\/(\S+):/.exec(writes[0])?.[1] ?? "";

      expect(name).toMatch(new RegExp(`^${schedule}-manual-\\d{14}$`));
      expect(writes[0]).toBe(
        `create Backup ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: cluster e2e-actions, method plugin (barman-cloud.cloudnative-pg.io), label cnpg.io/cluster=e2e-actions, annotation cnpg-extension.freelens.app/scheduled-backup=${schedule}`,
      );
      expect(await runNow.innerText()).toContain("The schedule is suspended and stays suspended");
      await cluster.captureScreenshot(frame, "schedule-run-now-dialog-dark");
      expect(cluster.kubectlActions("get", backups, name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Backup ${name}`);

      // W12: read back from the cluster. The labels of the operator are not there, the owner neither.
      expect(cluster.kubectlActionsField(backups, name, "{.metadata.labels}")).toBe(
        '{"cnpg.io/cluster":"e2e-actions"}',
      );
      expect(
        cluster.kubectlActionsField(
          backups,
          name,
          "{.metadata.annotations.cnpg-extension\\.freelens\\.app/scheduled-backup}",
        ),
      ).toBe(schedule);
      expect(cluster.kubectlActionsField(backups, name, "{.metadata.ownerReferences}")).toBe("");
      expect(cluster.kubectlActionsField(backups, name, "{.spec.method}")).toBe("plugin");
      expect(cluster.kubectlActionsField(backups, name, "{.spec.pluginConfiguration.name}")).toBe(
        "barman-cloud.cloudnative-pg.io",
      );
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(backups, name, "{.status.phase}"),
          (phase) => phase === "completed" || phase === "failed",
          5 * 60_000,
        ),
      ).toBe("completed");
      // It was not a run of the schedule: the schedule still says what it said, and is still suspended.
      expect(cluster.kubectlActionsField(schedules, schedule, "{.status.lastScheduleTime}")).toBe(lastScheduleTime);
      expect(cluster.kubectlActionsField(schedules, schedule, "{.spec.suspend}")).toBe("true");
      await cluster.clearNotifications(frame);

      // The drawer of the schedule shows it on the axis of the schedule, as requested by hand.
      await frame
        .locator(".TableRow", { hasText: schedule })
        .locator(".TableCell", { hasText: schedule })
        .first()
        .click();
      await frame
        .locator(".Drawer.KubeObjectDetails", { hasText: "Backup template" })
        .waitFor({ state: "visible", timeout: 60_000 });

      const mark = frame
        .locator('.Drawer.KubeObjectDetails [data-testid="cnpg-backup-history"] [data-manual="true"]')
        .first();

      await mark.waitFor({ state: "visible", timeout: 60_000 });
      expect(await mark.getAttribute("title")).toContain("requested by hand");
      expect(
        await frame.locator('.Drawer.KubeObjectDetails [data-testid="cnpg-backup-history-by-hand"]').innerText(),
      ).toMatch(/^Requested by hand: \d+$/);
      await scrollIntoView(mark);
      await cluster.captureScreenshot(frame, "schedule-drawer-by-hand-dark");
      await cluster.closeDetails(frame);

      // Resume: the explicit false, and the next run is still in the future, so nothing is created.
      await cluster.openRowMenu(frame, schedule);
      await frame.locator('.Menu [data-testid="cnpg-schedule-resume-menu-item"]').first().click();

      const resume = frame.locator('[data-testid="cnpg-schedule-resume-dialog"]');

      await resume.waitFor({ state: "visible", timeout: 60_000 });
      expect(await resume.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch ScheduledBackup ${cluster.E2E_ACTIONS_NAMESPACE}/${schedule}: spec.suspend true -> false`,
      ]);
      await cluster.captureScreenshot(frame, "schedule-resume-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", "Resume requested");
      expect(cluster.kubectlActionsField(schedules, schedule, "{.spec.suspend}")).toBe("false");

      await cluster.openRowMenu(frame, schedule);
      await frame.locator('.Menu [data-testid="cnpg-schedule-suspend-menu-item"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
      await cluster.closeRowMenu(frame);

      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "moves the primary to the standby the user chose, and the cluster follows (SPEC-0022)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const name = cluster.E2E_ACTIONS_CLUSTER;
      const healthy = "Cluster in healthy state";
      const settled = async () =>
        waitUntil(
          async () =>
            [
              cluster.kubectlActionsField(clusters, name, "{.status.phase}"),
              cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}"),
              cluster.kubectlActionsField(clusters, name, "{.status.targetPrimary}"),
              cluster.kubectlActionsField(clusters, name, "{.status.readyInstances}"),
            ].join("|"),
          (facts) => {
            const [phase, current, target, ready] = facts.split("|");

            return phase === healthy && current === target && ready === "2";
          },
          5 * 60_000,
        );

      // The case does not care which instance is the primary today: the standby is the other one.
      const before = (await settled()).split("|")[1];
      const standby = before === `${name}-1` ? `${name}-2` : `${name}-1`;

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");

      // One instance: there is nothing to promote, and the entry says so.
      await cluster.selectNamespace(frame);
      await cluster.openRowMenu(frame, "e2e-single");

      const refused = frame.locator('.Menu [data-testid="cnpg-cluster-switchover-menu-item"]').first();

      await refused.waitFor({ state: "visible", timeout: 60_000 });
      expect(await refused.getAttribute("class")).toContain("disabled");
      expect(await refused.getAttribute("title")).toBe("Switchover: There is no standby to promote");
      await cluster.closeRowMenu(frame);

      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await cluster.openRowMenu(frame, name);
      await frame.locator('.Menu [data-testid="cnpg-cluster-switchover-menu-item"]').first().click();

      const dialog = frame.locator('[data-testid="cnpg-switchover-dialog"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(await dialog.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(
        `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-context"]').innerText()).toContain(
        cluster.E2E_KUBE_CONTEXT,
      );

      // The candidates: the one standby, eligible, proposed, with a state and a lag read from the primary.
      const rows = dialog.locator('[data-testid^="cnpg-switchover-candidate-"]');

      expect(await rows.count()).toBe(1);

      const row = dialog.locator(`[data-testid="cnpg-switchover-candidate-${standby}"]`);

      expect(await row.getAttribute("data-eligible")).toBe("true");
      expect(await row.locator('input[type="radio"]').isChecked()).toBe(true);
      expect(await row.innerText()).toContain("streaming");
      expect(await dialog.locator(`[data-testid="cnpg-switchover-lag-${standby}"]`).innerText()).toMatch(
        /^(none|\d+(\.\d+)? (B|KiB|MiB))$/,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name} (status): targetPrimary ${before} -> ${standby}, targetPrimaryTimestamp now, phase "${healthy}" -> "Switchover in progress", phaseReason "Switching over to ${standby}"`,
      ]);

      // W5: OK stays disabled until the name of the cluster is typed.
      const ok = frame.locator('[data-testid="confirm"]');

      expect(await ok.isDisabled()).toBe(true);
      await cluster.captureScreenshot(frame, "switchover-dialog-dark");
      await dialog.locator('[data-testid="cnpg-action-typed-name"]').fill("e2e-action");
      expect(await ok.isDisabled()).toBe(true);
      await dialog.locator('[data-testid="cnpg-action-typed-name"]').fill(name);
      await waitUntil(
        async () => ok.isDisabled(),
        (disabled) => !disabled,
        30_000,
      );
      await cluster.captureScreenshot(frame, "switchover-dialog-typed-dark");
      // W8: nothing is written until the user confirms.
      expect(cluster.kubectlActionsField(clusters, name, "{.status.targetPrimary}")).toBe(before);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Switchover of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} to`);

      // W12: read back from the cluster: the request, then the operator's own completion.
      expect(cluster.kubectlActionsField(clusters, name, "{.status.targetPrimary}")).toBe(standby);
      expect((await settled()).split("|")[1]).toBe(standby);
      await cluster.clearNotifications(frame);

      // "Promote" on the row of the new standby (the old primary): the same dialog, with that row chosen. Closed without writing.
      await frame.locator(".TableRow", { hasText: name }).locator(".TableCell", { hasText: name }).first().click();

      const promote = frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-promote-${before}"]`);

      await promote.waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await frame.locator(`.Drawer.KubeObjectDetails [data-testid="cnpg-instance-promote-${standby}"]`).count(),
      ).toBe(0);
      await waitUntil(
        async () => promote.getAttribute("aria-disabled"),
        (disabled) => disabled === "false",
        3 * 60_000,
      );
      await promote.click();
      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(
        await dialog.locator(`[data-testid="cnpg-switchover-candidate-${before}"] input[type="radio"]`).isChecked(),
      ).toBe(true);
      await cluster.cancelDialog(frame);
      expect(cluster.kubectlActionsField(clusters, name, "{.status.targetPrimary}")).toBe(standby);

      await cluster.closeDetails(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "reloads a cluster and restarts one instance, each in its own way (SPEC-0023)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const name = cluster.E2E_ACTIONS_CLUSTER;
      const settled = async () =>
        waitUntil(
          async () =>
            [
              cluster.kubectlActionsField(clusters, name, "{.status.phase}"),
              cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}"),
              cluster.kubectlActionsField(clusters, name, "{.status.targetPrimary}"),
              cluster.kubectlActionsField(clusters, name, "{.status.readyInstances}"),
            ].join("|"),
          (facts) => {
            const [phase, current, target, ready] = facts.split("|");

            return phase === "Cluster in healthy state" && current === target && ready === "2";
          },
          5 * 60_000,
        );
      const primary = (await settled()).split("|")[1];
      const standby = primary === `${name}-1` ? `${name}-2` : `${name}-1`;
      const started = new Date();

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);

      // Reload: one annotation, one click, and the honest note.
      await cluster.openRowMenu(frame, name);
      await frame.locator('.Menu [data-testid="cnpg-cluster-reload-menu-item"]').first().click();

      const reload = frame.locator('[data-testid="cnpg-reload-dialog"]');

      await reload.waitFor({ state: "visible", timeout: 60_000 });
      expect(await reload.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation cnpg.io/reloadedAt = now (RFC 3339, six fractional digits)`,
      ]);
      expect(await reload.innerText()).toContain("Nothing reports the completion of a reload");
      await cluster.captureScreenshot(frame, "reload-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Reload of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`);

      const reloadedAt = cluster.kubectlActionsField(clusters, name, "{.metadata.annotations.cnpg\\.io/reloadedAt}");

      expect(reloadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(new Date(reloadedAt).getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
      await cluster.clearNotifications(frame);

      // The standby, from its row: its pod is deleted and comes back with another UID.
      await frame.locator(".TableRow", { hasText: name }).locator(".TableCell", { hasText: name }).first().click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const standbyUid = cluster.kubectlActionsField("pods", standby, "{.metadata.uid}");
      const restartStandby = drawer.locator(`[data-testid="cnpg-instance-restart-${standby}"]`);

      await restartStandby.waitFor({ state: "visible", timeout: 60_000 });
      await waitUntil(
        async () => restartStandby.getAttribute("aria-disabled"),
        (disabled) => disabled === "false",
        60_000,
      );
      await restartStandby.click();

      const standbyDialog = frame.locator('[data-testid="cnpg-restart-standby-dialog"]');

      await standbyDialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(await standbyDialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `delete Pod ${cluster.E2E_ACTIONS_NAMESPACE}/${standby}`,
      ]);
      // One click: a standby interrupts nothing that writes (W5).
      expect(await standbyDialog.locator('[data-testid="cnpg-action-typed-name"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "restart-standby-dialog-dark");
      expect(cluster.kubectlActionsField("pods", standby, "{.metadata.uid}")).toBe(standbyUid);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Restart of the standby ${standby}`);
      await waitUntil(
        async () => cluster.kubectlActionsField("pods", standby, "{.metadata.uid}"),
        (uid) => uid !== "" && uid !== standbyUid,
        5 * 60_000,
      );
      expect((await settled()).split("|")[1]).toBe(primary);
      await cluster.clearNotifications(frame);

      // The primary, in place: the same pod, a PostgreSQL that started later.
      const primaryUid = cluster.kubectlActionsField("pods", primary, "{.metadata.uid}");
      const postmasterBefore = cluster.psqlActions(primary, "select pg_postmaster_start_time()");
      const containerRestarts = "{.status.containerStatuses[?(@.name=='postgres')].restartCount}";
      const restartsBefore = cluster.kubectlActionsField("pods", primary, containerRestarts);
      const restartPrimary = drawer.locator(`[data-testid="cnpg-instance-restart-${primary}"]`);

      expect(postmasterBefore).not.toBe("");
      await waitUntil(
        async () => restartPrimary.getAttribute("aria-disabled"),
        (disabled) => disabled === "false",
        3 * 60_000,
      );
      await restartPrimary.click();

      const primaryDialog = frame.locator('[data-testid="cnpg-restart-primary-dialog"]');

      await primaryDialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(await primaryDialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name} (status): phase "Cluster in healthy state" -> "Primary instance is being restarted in-place", phaseReason "Requested by the user"`,
      ]);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await primaryDialog.locator('[data-testid="cnpg-action-typed-name"]').fill(name);
      await waitUntil(
        async () => frame.locator('[data-testid="confirm"]').isDisabled(),
        (disabled) => !disabled,
        30_000,
      );
      await cluster.captureScreenshot(frame, "restart-primary-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Restart in place of the primary ${primary}`);
      await waitUntil(
        async () => cluster.psqlActions(primary, "select pg_postmaster_start_time()"),
        (value) => value !== "" && value !== postmasterBefore,
        5 * 60_000,
      );
      await settled();
      // In place: the same pod, the same container, a PostgreSQL that started later. The reason the instance
      // manager writes ("Primary instance restarted in-place") is gone at the operator's next reconciliation.
      expect(cluster.kubectlActionsField("pods", primary, "{.metadata.uid}")).toBe(primaryUid);
      expect(cluster.kubectlActionsField("pods", primary, containerRestarts)).toBe(restartsBefore);
      expect(cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}")).toBe(primary);

      await cluster.clearNotifications(frame);
      await cluster.closeDetails(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "restarts a whole cluster in the order its dialog listed (SPEC-0023)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const name = cluster.E2E_ACTIONS_CLUSTER;
      const annotation = "{.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}";
      const primary = cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}");
      const standby = primary === `${name}-1` ? `${name}-2` : `${name}-1`;

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await cluster.openRowMenu(frame, name);
      await frame.locator('.Menu [data-testid="cnpg-cluster-restart-menu-item"]').first().click();

      const dialog = frame.locator('[data-testid="cnpg-restart-dialog"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      // The plan: the standby first, then the primary by the cluster's own method (the default: without a switchover).
      expect(await dialog.locator('[data-testid="cnpg-restart-plan"] li').allInnerTexts()).toEqual([
        `${standby} (standby): its pod is deleted and recreated on its volumes`,
        `${primary} (primary): its pod is deleted and recreated without a switchover (primaryUpdateMethod: restart). Writes are down until it is back`,
      ]);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation kubectl.kubernetes.io/restartedAt = now (RFC 3339, to the second)`,
      ]);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await dialog.locator('[data-testid="cnpg-action-typed-name"]').fill(name);
      await waitUntil(
        async () => frame.locator('[data-testid="confirm"]').isDisabled(),
        (disabled) => !disabled,
        30_000,
      );
      await cluster.captureScreenshot(frame, "restart-cluster-dialog-dark");

      const before = cluster.kubectlActionsField(clusters, name, annotation);

      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Restart of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`);

      const requested = cluster.kubectlActionsField(clusters, name, annotation);

      expect(requested).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(requested).not.toBe(before);
      // The operator's own completion: both pods carry the value, and the cluster is healthy again.
      await waitUntil(
        async () =>
          [
            cluster.kubectlActionsField("pods", `${name}-1`, annotation),
            cluster.kubectlActionsField("pods", `${name}-2`, annotation),
            cluster.kubectlActionsField(clusters, name, "{.status.phase}"),
            cluster.kubectlActionsField(clusters, name, "{.status.readyInstances}"),
          ].join("|"),
        (facts) => facts === `${requested}|${requested}|Cluster in healthy state|2`,
        8 * 60_000,
      );

      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "fences a standby and lifts the fence from where the drawer shows it (SPEC-0024)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const name = cluster.E2E_ACTIONS_CLUSTER;
      const annotation = "{.metadata.annotations.cnpg\\.io/fencedInstances}";
      const ready = "{.status.conditions[?(@.type=='Ready')].status}";
      const primary = cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}");
      const standby = primary === `${name}-1` ? `${name}-2` : `${name}-1`;

      // On the fixtures: the way back is offered where the state is, opened and closed without writing.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await frame
        .locator(".TableRow", { hasText: "e2e-fenced" })
        .locator(".TableCell", { hasText: "e2e-fenced" })
        .first()
        .click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const liftFixture = drawer.locator('[data-testid="cnpg-instance-lift-fence-e2e-fenced-1"]');

      await liftFixture.waitFor({ state: "visible", timeout: 60_000 });
      expect(await liftFixture.getAttribute("aria-disabled")).toBe("false");
      expect(await drawer.locator('[data-testid="cnpg-fenced-instances"]').innerText()).toBe("e2e-fenced-1");
      await liftFixture.click();

      const lift = frame.locator('[data-testid="cnpg-lift-fence-dialog"]');

      await lift.waitFor({ state: "visible", timeout: 60_000 });
      expect(await lift.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_NAMESPACE}/e2e-fenced: annotation cnpg.io/fencedInstances ["e2e-fenced-1"] -> (unset)`,
      ]);
      await cluster.cancelDialog(frame);
      expect(cluster.kubectlField(clusters, "e2e-fenced", annotation)).toBe('["e2e-fenced-1"]');
      await cluster.closeDetails(frame);

      // The write case: the standby of e2e-actions, from its row, with the name typed.
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".TableRow", { hasText: name }).locator(".TableCell", { hasText: name }).first().click();

      const fenceStandby = drawer.locator(`[data-testid="cnpg-instance-fence-${standby}"]`);

      await fenceStandby.waitFor({ state: "visible", timeout: 60_000 });
      await fenceStandby.click();

      const fence = frame.locator('[data-testid="cnpg-fence-dialog"]');

      await fence.waitFor({ state: "visible", timeout: 60_000 });
      expect(await fence.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation cnpg.io/fencedInstances (unset) -> ["${standby}"]`,
      ]);
      // A standby: no warning about the primary.
      expect(await fence.locator('[data-testid="cnpg-action-warning"]').count()).toBe(0);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await fence.locator('[data-testid="cnpg-action-typed-name"]').fill(name);
      await waitUntil(
        async () => frame.locator('[data-testid="confirm"]').isDisabled(),
        (disabled) => !disabled,
        30_000,
      );
      await cluster.captureScreenshot(frame, "fence-dialog-dark");
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe("");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Fencing of ${standby}`);

      // W12: exactly that name, and PostgreSQL really stops: the pod stays and turns not ready.
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe(`["${standby}"]`);
      await waitUntil(
        async () => cluster.kubectlActionsField("pods", standby, ready),
        (status) => status === "False",
        3 * 60_000,
      );
      await cluster.clearNotifications(frame);

      // The drawer says who is fenced, and the row of that fact lifts it.
      const fencedRow = drawer.locator('[data-testid="cnpg-fenced-instances"]');

      await fencedRow.waitFor({ state: "visible", timeout: 60_000 });
      expect(await fencedRow.innerText()).toBe(standby);
      await cluster.captureScreenshot(frame, "cluster-drawer-fenced-dark");
      await drawer.locator('[data-testid="cnpg-fenced-lift-all"]').click();
      await lift.waitFor({ state: "visible", timeout: 60_000 });
      expect(await lift.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation cnpg.io/fencedInstances ["${standby}"] -> (unset)`,
      ]);
      // Bringing things back is one click (W5).
      expect(await lift.locator('[data-testid="cnpg-action-typed-name"]').count()).toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", "Lift of every fence");
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe("");
      await waitUntil(
        async () =>
          `${cluster.kubectlActionsField("pods", standby, ready)}|${cluster.kubectlActionsField(clusters, name, "{.status.readyInstances}")}`,
        (facts) => facts === "True|2",
        5 * 60_000,
      );

      await cluster.clearNotifications(frame);
      await cluster.closeDetails(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "puts a cluster to sleep with its consequences listed, and wakes it from the drawer (SPEC-0024)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const name = cluster.E2E_ACTIONS_CLUSTER;
      const annotation = "{.metadata.annotations.cnpg\\.io/hibernation}";
      const condition = "{.status.conditions[?(@.type=='cnpg.io/hibernation')].reason}";
      const pods = () =>
        cluster
          .kubectlActions("get", "pods", "--selector", `cnpg.io/cluster=${name},cnpg.io/podRole=instance`, "-o", "name")
          .stdout.trim();
      const volumes = () =>
        cluster
          .kubectlActions("get", "persistentvolumeclaims", "--selector", `cnpg.io/cluster=${name}`, "-o", "name")
          .stdout.trim();

      // On the fixtures: a hibernated cluster offers Resume, in its menu and next to the state. Closed without writing.
      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame);
      await cluster.openRowMenu(frame, "e2e-hibernated");
      await frame.locator('.Menu [data-testid="cnpg-cluster-resume-menu-item"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
      expect(await frame.locator('.Menu [data-testid="cnpg-cluster-hibernate-menu-item"]').count()).toBe(0);
      await frame.locator('.Menu [data-testid="cnpg-cluster-resume-menu-item"]').first().click();

      const resume = frame.locator('[data-testid="cnpg-resume-cluster-dialog"]');

      await resume.waitFor({ state: "visible", timeout: 60_000 });
      expect(await resume.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_NAMESPACE}/e2e-hibernated: annotation cnpg.io/hibernation on -> off`,
      ]);
      await cluster.cancelDialog(frame);
      expect(cluster.kubectlField(clusters, "e2e-hibernated", annotation)).toBe("on");

      // The write case.
      const volumesBefore = volumes();

      expect(volumesBefore).not.toBe("");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await cluster.openRowMenu(frame, name);
      await frame.locator('.Menu [data-testid="cnpg-cluster-hibernate-menu-item"]').first().click();

      const hibernate = frame.locator('[data-testid="cnpg-hibernate-dialog"]');

      await hibernate.waitFor({ state: "visible", timeout: 60_000 });
      // A cluster that was resumed before carries the explicit `off`: the write spells the value it replaces.
      const before = cluster.kubectlActionsField(clusters, name, annotation);

      expect(await hibernate.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation cnpg.io/hibernation ${before || "(unset)"} -> on`,
      ]);

      // The consequences, from what is attached to this cluster: its two pods, the primary first, its volumes, its schedule.
      const primary = cluster.kubectlActionsField(clusters, name, "{.status.currentPrimary}");
      const podLines = await hibernate.locator('[data-testid="cnpg-hibernation-pods"] li').allInnerTexts();

      expect(podLines).toHaveLength(2);
      expect(podLines[0]).toBe(`${primary} (primary, first: no switchover happens)`);
      expect(await hibernate.locator('[data-testid="cnpg-hibernation-volumes"] li').count()).toBe(
        volumesBefore.split("\n").length,
      );
      expect(await hibernate.locator('[data-testid="cnpg-hibernation-schedules"] li').allInnerTexts()).toEqual([
        `${cluster.E2E_ACTIONS_SCHEDULE}: suspend it from its own menu`,
      ]);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await hibernate.locator('[data-testid="cnpg-action-typed-name"]').fill(name);
      await waitUntil(
        async () => frame.locator('[data-testid="confirm"]').isDisabled(),
        (disabled) => !disabled,
        30_000,
      );
      await cluster.captureScreenshot(frame, "hibernate-dialog-dark");
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe(before);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Hibernation of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`,
      );

      // W12: the annotation, then the operator's own completion: no pod, the condition, every volume still there.
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe("on");
      await waitUntil(
        async () => `${pods()}|${cluster.kubectlActionsField(clusters, name, condition)}`,
        (facts) => facts === "|Hibernated",
        5 * 60_000,
      );
      expect(volumes()).toBe(volumesBefore);
      await cluster.clearNotifications(frame);

      // The drawer shows the state from the condition, and the row of the state wakes the cluster.
      await frame.locator(".TableRow", { hasText: name }).locator(".TableCell", { hasText: name }).first().click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const state = drawer.locator('[data-testid="cnpg-hibernation-state"]');

      await state.waitFor({ state: "visible", timeout: 60_000 });
      await waitUntil(
        async () => state.innerText(),
        (words) => words === "Hibernated: no pod runs, every volume is kept",
        60_000,
      );
      await cluster.captureScreenshot(frame, "cluster-drawer-hibernated-dark");
      await drawer.locator('[data-testid="cnpg-hibernation-resume"]').click();
      await resume.waitFor({ state: "visible", timeout: 60_000 });
      expect(await resume.locator('[data-testid="cnpg-action-writes"] li').allInnerTexts()).toEqual([
        `patch Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: annotation cnpg.io/hibernation on -> off`,
      ]);
      expect(await resume.locator('[data-testid="cnpg-action-typed-name"]').count()).toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Resume of ${cluster.E2E_ACTIONS_NAMESPACE}/${name} requested`);
      expect(cluster.kubectlActionsField(clusters, name, annotation)).toBe("off");
      await waitUntil(
        async () =>
          [
            cluster.kubectlActionsField(clusters, name, "{.status.phase}"),
            cluster.kubectlActionsField(clusters, name, "{.status.readyInstances}"),
            cluster.kubectlActionsField(clusters, name, condition),
          ].join("|"),
        (facts) => facts === "Cluster in healthy state|2|",
        8 * 60_000,
      );
      expect(volumes()).toBe(volumesBefore);

      await cluster.clearNotifications(frame);
      await cluster.closeDetails(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates a cluster from the form, with the YAML it showed, and the operator brings it up (SPEC-0025)",
    async () => {
      const name = "e2e-created";
      const clusters = "clusters.postgresql.cnpg.io";

      // A leftover of an interrupted run must not make the create collide.
      if (cluster.kubectlActions("get", clusters, name).status === 0) {
        cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);

      // F1: the host's floating add button of the list.
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      // F4: the one namespace the filter names is the default of the form.
      expect(await dialog.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(
        `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/<name>`,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-context"]').innerText()).toContain(
        cluster.E2E_KUBE_CONTEXT,
      );
      // F2: OK is disabled with the first reason in reading order, never mute.
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe("A name is required");

      await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-cluster-instances"]').fill("1");
      await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("1Gi");

      // F7: the object store of the write namespace, picked from what the read on open found.
      const storePicker = frame.locator("#cnpg-create-cluster-object-store");

      await storePicker.waitFor({ state: "visible", timeout: 60_000 });
      await storePicker.fill("actions-store");
      await storePicker.press("Enter");

      expect(await dialog.locator('[data-testid="cnpg-action-subject"]').innerText()).toBe(
        `Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      // F12: the YAML pane is the body, byte for byte.
      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Cluster",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  instances: 1",
        "  storage:",
        "    size: 1Gi",
        "  bootstrap:",
        "    initdb:",
        "      database: app",
        "      owner: app",
        "  plugins:",
        "    - name: barman-cloud.cloudnative-pg.io",
        "      isWALArchiver: true",
        "      parameters:",
        "        barmanObjectName: actions-store",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-cluster-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);

      const writes = dialog.locator('[data-testid="cnpg-action-writes"] li');

      expect(await writes.count()).toBe(1);
      expect(await writes.first().innerText()).toMatch(
        new RegExp(
          `^create Cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: 1 instance, image .+, storage 1Gi, a new database app owned by app, WAL archiving to actions-store$`,
        ),
      );
      // The summary says what it costs: one instance, and no resource requests.
      const warnings = await dialog.locator('[data-testid="cnpg-action-warning"]').allInnerTexts();

      expect(warnings.some((warning) => warning.includes("One instance"))).toBe(true);
      expect(warnings.some((warning) => warning.includes("No resource requests"))).toBe(true);
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(false);
      await cluster.captureScreenshot(frame, "create-cluster-dialog-dark");

      // W8: nothing exists until the user confirms.
      expect(cluster.kubectlActions("get", clusters, name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the PostgreSQL cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      // F14: read back from the cluster, then what the operator stamped (the image the form never sent).
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.instances}")).toBe("1");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.storage.size}")).toBe("1Gi");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.bootstrap.initdb.database}")).toBe("app");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.plugins[0].name}")).toBe(
        "barman-cloud.cloudnative-pg.io",
      );
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.plugins[0].isWALArchiver}")).toBe("true");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.plugins[0].parameters.barmanObjectName}")).toBe(
        "actions-store",
      );
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.imageName}")).not.toBe("");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.backup}")).toBe("");

      // The row appears when the store sees it, and the operator creates the first instance.
      await cluster.expectRow(frame, name);
      expect(
        await waitUntil(
          async () => cluster.kubectlActions("get", "pods", `${name}-1`, "-o", "name").status,
          (status) => status === 0,
          4 * 60_000,
        ),
      ).toBe(0);

      cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      expect(cluster.kubectlActions("get", clusters, name).status).not.toBe(0);
      await cluster.clearNotifications(frame);

      // F5 and F6, on a second form: a collision warns and never blocks, a rule of the operator refuses at the field.
      await frame.locator(".AddRemoveButtons .add-button").click();
      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill(cluster.E2E_ACTIONS_CLUSTER);
      await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("1Gi");
      expect(await dialog.locator('[data-testid="cnpg-create-cluster-name-field-warning"]').innerText()).toContain(
        "already exists",
      );
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);

      await dialog.locator('[data-testid="cnpg-create-cluster-instances"]').fill("2");
      await dialog.locator('[data-testid="cnpg-create-cluster-replication-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-sync-enabled"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-sync-number"]').fill("2");
      expect(await dialog.locator('[data-testid="cnpg-create-cluster-sync-number-field-error"]').innerText()).toBe(
        "The number of synchronous replicas must be below the instances (2)",
      );
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe(
        "The number of synchronous replicas must be below the instances (2)",
      );
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await cluster.cancelDialog(frame);
      expect(cluster.kubectlActions("get", clusters, cluster.E2E_ACTIONS_CLUSTER, "-o", "name").stdout.trim()).toBe(
        `cluster.postgresql.cnpg.io/${cluster.E2E_ACTIONS_CLUSTER}`,
      );

      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates a cluster with a tablespace from the form, and the operator reconciles it (SPEC-0029)",
    async () => {
      const name = "e2e-tablespaced";
      const clusters = "clusters.postgresql.cnpg.io";

      if (cluster.kubectlActions("get", clusters, name).status === 0) {
        cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-cluster-instances"]').fill("1");
      await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("1Gi");

      // The rules at the field: a reserved name, then a duplicate ignoring case, and OK says so.
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-add"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-name"]').fill("pg_reports");
      expect(
        await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-name-field-error"]').innerText(),
      ).toContain("reserved for PostgreSQL");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-name"]').fill("reports");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-size"]').fill("512Mi");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-add"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-1-name"]').fill("Reports");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-1-size"]').fill("512Mi");
      expect(
        await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-1-name-field-error"]').innerText(),
      ).toBe("Reports is declared twice (tablespace names are compared ignoring case)");
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe("A tablespace is wrong");
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-1-remove"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-temporary"]').check();

      // F12: the pane carries the tablespace, and nothing the user did not decide.
      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Cluster",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  instances: 1",
        "  storage:",
        "    size: 1Gi",
        "  tablespaces:",
        "    - name: reports",
        "      storage:",
        "        size: 512Mi",
        "      temporary: true",
        "  bootstrap:",
        "    initdb:",
        "      database: app",
        "      owner: app",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-cluster-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toContain(
        "1 tablespace",
      );
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-cluster-tablespaces-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the PostgreSQL cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      // F14: read back, then what the operator made of it: the tablespace reconciled on the primary.
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.tablespaces[0].name}")).toBe("reports");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.tablespaces[0].storage.size}")).toBe("512Mi");
      expect(cluster.kubectlActionsField(clusters, name, "{.spec.tablespaces[0].temporary}")).toBe("true");
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(clusters, name, "{.status.tablespacesStatus[0].state}"),
          (state) => state === "reconciled" || state === "error",
          6 * 60_000,
        ),
      ).toBe("reconciled");
      expect(cluster.kubectlActions("get", "pvc", `${name}-1-tbs-reports`, "-o", "name").status).toBe(0);

      // The drawer shows the tablespace with the state the operator reports.
      await cluster.expectRow(frame, name);
      await cluster.expectDetails(frame, name, "Tablespaces", "reports (temporary)", "512Mi", "reconciled");

      cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      expect(cluster.kubectlActions("get", clusters, name).status).not.toBe(0);
      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "takes a volume snapshot backup from the row menu, and the backup lists its snapshots (SPEC-0029)",
    async () => {
      const backup = "backups.postgresql.cnpg.io";
      const clusters = "clusters.postgresql.cnpg.io";

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);

      // The drawer of the fixture cluster: its tablespace, reconciled, and the snapshot settings it declares.
      await cluster.expectDetails(
        frame,
        cluster.E2E_SNAPSHOT_CLUSTER,
        "Tablespaces",
        cluster.E2E_SNAPSHOT_TABLESPACE,
        `512Mi (${cluster.E2E_STORAGE_CLASS})`,
        "reconciled",
        "Volume snapshot backups",
        `${cluster.E2E_SNAPSHOT_CLASS}, cold`,
      );

      await cluster.openRowMenu(frame, cluster.E2E_SNAPSHOT_CLUSTER);
      await frame.locator('.Menu [data-testid="cnpg-cluster-backup-now-menu-item"]').first().click();

      const dialog = frame.locator('[data-testid="cnpg-backup-now-dialog"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      // Two methods on this cluster: the plugin of its WAL archiver, and the volume snapshot.
      await pickInSelect(frame, "cnpg-backup-now-method", "Volume snapshot");

      const name = await dialog.locator('[data-testid="cnpg-backup-now-name"]').inputValue();

      expect(name).toMatch(new RegExp(`^${cluster.E2E_SNAPSHOT_CLUSTER}-\\d{14}$`));
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toContain(
        "method volumeSnapshot",
      );
      await cluster.captureScreenshot(frame, "backup-now-volume-snapshot-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Backup ${name}`);

      expect(cluster.kubectlActionsField(backup, name, "{.spec.method}")).toBe("volumeSnapshot");
      // A cold snapshot fences the only instance for its duration: the backup completes, the cluster comes back.
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(backup, name, "{.status.phase}"),
          (phase) => phase === "completed" || phase === "failed",
          5 * 60_000,
        ),
      ).toBe("completed");
      // One snapshot per volume; the operator lists them in no promised order.
      expect(
        cluster.kubectlActionsField(backup, name, "{.status.snapshotBackupStatus.elements[*].type}").split(" ").sort(),
      ).toEqual(["PG_DATA", "PG_TABLESPACE"]);
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(clusters, cluster.E2E_SNAPSHOT_CLUSTER, "{.status.phase}"),
          (phase) => phase === "Cluster in healthy state",
          5 * 60_000,
        ),
      ).toBe("Cluster in healthy state");

      // The drawer of the backup lists the snapshot of the data volume and the one of the tablespace.
      await cluster.openCnpgPage(frame, "cnpg-backups-backups", "Backups");
      await cluster.expectRow(frame, name, cluster.E2E_SNAPSHOT_CLUSTER, "volumeSnapshot", "Completed");
      await cluster.expectDetails(
        frame,
        name,
        "Volume snapshot",
        `${name}-tbs-${cluster.E2E_SNAPSHOT_TABLESPACE}`,
        "PG_TABLESPACE",
        cluster.E2E_SNAPSHOT_TABLESPACE,
      );

      // The backup and its snapshots go, so the recovery case picks the fixture's own.
      cluster.kubectlActions("delete", backup, name, "--wait=true", "--timeout=120s");
      cluster.kubectlActions("delete", "volumesnapshots.snapshot.storage.k8s.io", "-l", `cnpg.io/backupName=${name}`);
      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates a cluster from the volume snapshots of a backup, and the data is there (SPEC-0029)",
    async () => {
      const name = "e2e-recovered";
      const clusters = "clusters.postgresql.cnpg.io";
      const dataSnapshot = cluster.E2E_SNAPSHOT_BACKUP;
      const tablespaceSnapshot = `${cluster.E2E_SNAPSHOT_BACKUP}-tbs-${cluster.E2E_SNAPSHOT_TABLESPACE}`;

      if (cluster.kubectlActions("get", clusters, name).status === 0) {
        cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-cluster"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-cluster-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-cluster-instances"]').fill("1");
      await dialog.locator('[data-testid="cnpg-create-cluster-storage-size"]').fill("1Gi");
      // The storage class of the CSI driver: the only one the snapshots can be restored on.
      await pickInSelect(frame, "cnpg-create-cluster-storage-class", cluster.E2E_STORAGE_CLASS);
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-section-toggle"]').click();
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-add"]').click();
      await dialog
        .locator('[data-testid="cnpg-create-cluster-tablespaces-0-name"]')
        .fill(cluster.E2E_SNAPSHOT_TABLESPACE);
      await dialog.locator('[data-testid="cnpg-create-cluster-tablespaces-0-size"]').fill("512Mi");
      await pickInSelect(frame, "cnpg-create-cluster-tablespaces-0-class", cluster.E2E_STORAGE_CLASS);

      // The recovery from snapshots: the data one first in the picker, the tablespace one under its name.
      await dialog.locator('[data-testid="cnpg-create-cluster-bootstrap-recovery"]').check();
      await dialog.locator('[data-testid="cnpg-create-cluster-recovery-source-volumeSnapshots"]').check();
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe(
        "Pick the data snapshot to recover from",
      );
      await pickInSelect(frame, "cnpg-create-cluster-recovery-data-snapshot", dataSnapshot);
      await pickInSelect(
        frame,
        `cnpg-create-cluster-recovery-tablespace-snapshot-${cluster.E2E_SNAPSHOT_TABLESPACE}`,
        tablespaceSnapshot,
      );
      // A point in time needs the WAL archive the snapshots do not carry: refused at the field.
      await dialog.locator('[data-testid="cnpg-create-cluster-recovery-target"]').fill("2026-09-24T10:00:00Z");
      expect(
        await dialog.locator('[data-testid="cnpg-create-cluster-recovery-target-field-error"]').innerText(),
      ).toContain("give the WAL archive of the source");
      await dialog.locator('[data-testid="cnpg-create-cluster-recovery-target"]').fill("");

      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Cluster",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  instances: 1",
        "  storage:",
        "    size: 1Gi",
        `    storageClass: ${cluster.E2E_STORAGE_CLASS}`,
        "  tablespaces:",
        `    - name: ${cluster.E2E_SNAPSHOT_TABLESPACE}`,
        "      storage:",
        "        size: 512Mi",
        `        storageClass: ${cluster.E2E_STORAGE_CLASS}`,
        "  bootstrap:",
        "    recovery:",
        "      volumeSnapshots:",
        "        storage:",
        `          name: ${dataSnapshot}`,
        "          kind: VolumeSnapshot",
        "          apiGroup: snapshot.storage.k8s.io",
        "        tablespaceStorage:",
        `          ${cluster.E2E_SNAPSHOT_TABLESPACE}:`,
        `            name: ${tablespaceSnapshot}`,
        "            kind: VolumeSnapshot",
        "            apiGroup: snapshot.storage.k8s.io",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-cluster-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toContain(
        `recovery from the volume snapshot ${dataSnapshot} (cold, backup ${dataSnapshot} of ${cluster.E2E_SNAPSHOT_CLUSTER})`,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-cluster-snapshot-recovery-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the PostgreSQL cluster ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      // F14: read back, then the cluster comes up from the snapshots with the marker table in its tablespace.
      expect(
        cluster.kubectlActionsField(clusters, name, "{.spec.bootstrap.recovery.volumeSnapshots.storage.name}"),
      ).toBe(dataSnapshot);
      expect(
        cluster.kubectlActionsField(
          clusters,
          name,
          `{.spec.bootstrap.recovery.volumeSnapshots.tablespaceStorage.${cluster.E2E_SNAPSHOT_TABLESPACE}.name}`,
        ),
      ).toBe(tablespaceSnapshot);
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(clusters, name, "{.status.phase}"),
          (phase) => phase === "Cluster in healthy state",
          8 * 60_000,
        ),
      ).toBe("Cluster in healthy state");
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(clusters, name, "{.status.tablespacesStatus[0].state}"),
          (state) => state === "reconciled" || state === "error",
          3 * 60_000,
        ),
      ).toBe("reconciled");
      expect(psqlActionsIn(`${name}-1`, "app", `SELECT count(*) FROM ${cluster.E2E_SNAPSHOT_MARKER_TABLE}`)).toBe("1");
      expect(
        psqlActionsIn(
          `${name}-1`,
          "app",
          `SELECT tablespace FROM pg_tables WHERE tablename = '${cluster.E2E_SNAPSHOT_MARKER_TABLE}'`,
        ),
      ).toBe(cluster.E2E_SNAPSHOT_TABLESPACE);

      cluster.kubectlActions("delete", clusters, name, "--wait=true", "--timeout=180s");
      expect(cluster.kubectlActions("get", clusters, name).status).not.toBe(0);
      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates a scheduled backup from the door of the drawer, with a first backup right away, and its backup goes with it (SPEC-0026)",
    async () => {
      const name = "e2e-created-schedule";
      const schedules = "scheduledbackups.postgresql.cnpg.io";

      if (cluster.kubectlActions("get", schedules, name).status === 0) {
        cluster.kubectlActions("delete", schedules, name, "--wait=true", "--timeout=120s");
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await tableRowName(frame, cluster.E2E_ACTIONS_CLUSTER).click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const door = drawer.locator('[data-testid="cnpg-cluster-create-schedule"]');

      await door.waitFor({ state: "visible", timeout: 60_000 });
      await door.click();

      const dialog = frame.locator('[data-testid="cnpg-create-schedule"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      // F1 and F4: the cluster and its namespace travel with the door and are shown as facts.
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-namespace-fact"]').innerText()).toBe(
        cluster.E2E_ACTIONS_NAMESPACE,
      );
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-cluster-fact"]').innerText()).toBe(
        cluster.E2E_ACTIONS_CLUSTER,
      );
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-name"]').inputValue()).toBe(
        `${cluster.E2E_ACTIONS_CLUSTER}-daily`,
      );
      // The cron editor: the default preset, its expression, its words and its next runs.
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-expression-value"]').innerText()).toBe(
        "0 0 3 * * *",
      );
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-expression-words"]').innerText()).toContain(
        "At 03:00",
      );
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-next-runs"]').innerText()).toMatch(
        /^Next runs: \d{4}-\d{2}-\d{2} 03:00:00 UTC, \d{4}-\d{2}-\d{2} 03:00:00 UTC, \d{4}-\d{2}-\d{2} 03:00:00 UTC$/,
      );

      await dialog.locator('[data-testid="cnpg-create-schedule-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-schedule-immediate"]').check();
      await dialog.locator('[data-testid="cnpg-create-schedule-owner-self"]').check();

      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: ScheduledBackup",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.E2E_ACTIONS_CLUSTER}`,
        "  schedule: 0 0 3 * * *",
        "  method: plugin",
        "  pluginConfiguration:",
        "    name: barman-cloud.cloudnative-pg.io",
        "  immediate: true",
        "  backupOwnerReference: self",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-schedule-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toBe(
        `create ScheduledBackup ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: cluster ${cluster.E2E_ACTIONS_CLUSTER}, schedule "0 0 3 * * *", method plugin (barman-cloud.cloudnative-pg.io), owner self`,
      );
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-schedule-dialog-dark");

      expect(cluster.kubectlActions("get", schedules, name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the scheduled backup ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      expect(cluster.kubectlActionsField(schedules, name, "{.spec.schedule}")).toBe("0 0 3 * * *");
      expect(cluster.kubectlActionsField(schedules, name, "{.spec.method}")).toBe("plugin");
      expect(cluster.kubectlActionsField(schedules, name, "{.spec.pluginConfiguration.name}")).toBe(
        "barman-cloud.cloudnative-pg.io",
      );
      expect(cluster.kubectlActionsField(schedules, name, "{.spec.immediate}")).toBe("true");
      expect(cluster.kubectlActionsField(schedules, name, "{.spec.backupOwnerReference}")).toBe("self");

      // The operator's first reaction: the child backup named after the schedule and the time, then the next run.
      const childBackups = () =>
        cluster
          .kubectlActions(
            "get",
            "backups.postgresql.cnpg.io",
            "--selector",
            `cnpg.io/scheduled-backup=${name}`,
            "-o",
            "name",
          )
          .stdout.trim();

      expect(
        await waitUntil(
          async () => childBackups(),
          (names) => names !== "",
          2 * 60_000,
        ),
      ).toMatch(new RegExp(`^backup.postgresql.cnpg.io/${name}-\\d{14}$`));
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(schedules, name, "{.status.nextScheduleTime}"),
          (time) => time !== "",
          60_000,
        ),
      ).not.toBe("");

      // Deleting the schedule takes its backup with it: the owner the form sent.
      cluster.kubectlActions("delete", schedules, name, "--wait=true", "--timeout=120s");
      expect(cluster.kubectlActions("get", schedules, name).status).not.toBe(0);
      expect(
        await waitUntil(
          async () => childBackups(),
          (names) => names === "",
          90_000,
        ),
      ).toBe("");
      await cluster.clearNotifications(frame);
      await cluster.closeDetails(frame);

      // F6 on the page's own form: a five field expression is refused with the reason of the operator's parser.
      await cluster.openCnpgPage(frame, "cnpg-backups-scheduledbackups", "Scheduled Backups");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();
      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-schedule-preset-custom"]').check();
      await dialog.locator('[data-testid="cnpg-create-schedule-custom"]').fill("0 0 3 * *");
      expect(await dialog.locator('[data-testid="cnpg-create-schedule-expression-error"]').innerText()).toMatch(
        /reads five fields seconds first/,
      );
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await cluster.cancelDialog(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates a pooler from the door of the drawer, and the operator brings its Deployment up (SPEC-0026)",
    async () => {
      const name = `${cluster.E2E_ACTIONS_CLUSTER}-pooler-rw`;
      const poolers = "poolers.postgresql.cnpg.io";

      if (cluster.kubectlActions("get", poolers, name).status === 0) {
        cluster.kubectlActions("delete", poolers, name, "--wait=true", "--timeout=120s");
      }

      await cluster.openCnpgPage(frame, "cnpg-clusters-clusters", "PostgreSQL Clusters");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await tableRowName(frame, cluster.E2E_ACTIONS_CLUSTER).click();

      const drawer = frame.locator(".Drawer.KubeObjectDetails");
      const door = drawer.locator('[data-testid="cnpg-cluster-create-pooler"]');

      await door.waitFor({ state: "visible", timeout: 60_000 });
      await door.click();

      const dialog = frame.locator('[data-testid="cnpg-create-pooler"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(await dialog.locator('[data-testid="cnpg-create-pooler-cluster-fact"]').innerText()).toBe(
        cluster.E2E_ACTIONS_CLUSTER,
      );
      // The name follows the cluster and the type until it is typed.
      expect(await dialog.locator('[data-testid="cnpg-create-pooler-name"]').inputValue()).toBe(name);
      await dialog.locator('[data-testid="cnpg-create-pooler-type-ro"]').check();
      expect(await dialog.locator('[data-testid="cnpg-create-pooler-name"]').inputValue()).toBe(
        `${cluster.E2E_ACTIONS_CLUSTER}-pooler-ro`,
      );
      await dialog.locator('[data-testid="cnpg-create-pooler-type-rw"]').check();

      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Pooler",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.E2E_ACTIONS_CLUSTER}`,
        "  type: rw",
        "  instances: 1",
        "  pgbouncer:",
        "    poolMode: session",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-pooler-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toBe(
        `create Pooler ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: cluster ${cluster.E2E_ACTIONS_CLUSTER}, type rw, 1 instance, session mode`,
      );
      await cluster.captureScreenshot(frame, "create-pooler-dialog-dark");

      expect(cluster.kubectlActions("get", poolers, name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(frame, "ok", `Requested the pooler ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`);

      expect(cluster.kubectlActionsField(poolers, name, "{.spec.cluster.name}")).toBe(cluster.E2E_ACTIONS_CLUSTER);
      expect(cluster.kubectlActionsField(poolers, name, "{.spec.type}")).toBe("rw");
      expect(cluster.kubectlActionsField(poolers, name, "{.spec.instances}")).toBe("1");
      expect(cluster.kubectlActionsField(poolers, name, "{.spec.pgbouncer.poolMode}")).toBe("session");
      expect(
        await waitUntil(
          async () => cluster.kubectlActions("get", "deployment", name, "-o", "name").status,
          (status) => status === 0,
          2 * 60_000,
        ),
      ).toBe(0);
      expect(
        await waitUntil(
          async () => cluster.kubectlActions("get", "service", name, "-o", "name").status,
          (status) => status === 0,
          60_000,
        ),
      ).toBe(0);

      cluster.kubectlActions("delete", poolers, name, "--wait=true", "--timeout=120s");
      expect(cluster.kubectlActions("get", poolers, name).status).not.toBe(0);
      await cluster.clearNotifications(frame);
      await cluster.closeDetails(frame);

      // F6 on the page's own form: the name of a service of the cluster is refused.
      await cluster.openCnpgPage(frame, "cnpg-pooling-poolers", "Poolers");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();
      await dialog.waitFor({ state: "visible", timeout: 60_000 });

      const clusterPicker = frame.locator("#cnpg-create-pooler-cluster");

      await clusterPicker.waitFor({ state: "visible", timeout: 60_000 });
      await clusterPicker.fill(cluster.E2E_ACTIONS_CLUSTER);
      await clusterPicker.press("Enter");
      await dialog.locator('[data-testid="cnpg-create-pooler-name"]').fill(`${cluster.E2E_ACTIONS_CLUSTER}-rw`);
      expect(await dialog.locator('[data-testid="cnpg-create-pooler-name-field-error"]').innerText()).toMatch(
        /one of its services/,
      );
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await cluster.cancelDialog(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "creates an object store on the S3 store of the fixtures, with its credentials picked from a secret, and deletes it (SPEC-0026)",
    async () => {
      const name = "e2e-created-store";
      const stores = "objectstores.barmancloud.cnpg.io";

      if (cluster.kubectlActions("get", stores, name).status === 0) {
        cluster.kubectlActions("delete", stores, name, "--wait=true", "--timeout=60s");
      }

      await cluster.openCnpgPage(frame, "cnpg-backups-objectstores", "Object Stores");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-object-store"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe("A name is required");
      await dialog.locator('[data-testid="cnpg-create-object-store-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-object-store-destination"]').fill("s3://backups/e2e-created/");
      await dialog.locator('[data-testid="cnpg-create-object-store-endpoint"]').fill("http://s3.cnpg-e2e.svc:9000");

      // F7: the secret from the read on open, the key from the keys the secret carries.
      for (const field of ["s3AccessKeyId", "s3SecretAccessKey"]) {
        const picker = frame.locator(`#cnpg-create-object-store-${field}-secret`);

        await picker.waitFor({ state: "visible", timeout: 60_000 });
        await picker.fill("actions-store-creds");
        await picker.press("Enter");
      }

      const expectedYaml = [
        "apiVersion: barmancloud.cnpg.io/v1",
        "kind: ObjectStore",
        "metadata:",
        `  name: ${name}`,
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  configuration:",
        "    destinationPath: s3://backups/e2e-created/",
        "    endpointURL: http://s3.cnpg-e2e.svc:9000",
        "    s3Credentials:",
        "      accessKeyId:",
        "        name: actions-store-creds",
        "        key: ACCESS_KEY_ID",
        "      secretAccessKey:",
        "        name: actions-store-creds",
        "        key: ACCESS_SECRET_KEY",
        "    wal:",
        "      compression: gzip",
        "    data:",
        "      compression: gzip",
        "  retentionPolicy: 30d",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-object-store-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(await dialog.locator('[data-testid="cnpg-action-writes"] li').first().innerText()).toBe(
        `create ObjectStore ${cluster.E2E_ACTIONS_NAMESPACE}/${name}: S3 at s3://backups/e2e-created/, kept 30 days`,
      );
      const warnings = await dialog.locator('[data-testid="cnpg-action-warning"]').allInnerTexts();

      expect(warnings.some((warning) => warning.includes("plaintext endpoint"))).toBe(true);
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-object-store-dialog-dark");

      expect(cluster.kubectlActions("get", stores, name).status).not.toBe(0);
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the object store ${cluster.E2E_ACTIONS_NAMESPACE}/${name}`,
      );

      expect(cluster.kubectlActionsField(stores, name, "{.spec.configuration.destinationPath}")).toBe(
        "s3://backups/e2e-created/",
      );
      expect(cluster.kubectlActionsField(stores, name, "{.spec.configuration.endpointURL}")).toBe(
        "http://s3.cnpg-e2e.svc:9000",
      );
      expect(cluster.kubectlActionsField(stores, name, "{.spec.configuration.s3Credentials.accessKeyId.name}")).toBe(
        "actions-store-creds",
      );
      expect(cluster.kubectlActionsField(stores, name, "{.spec.configuration.s3Credentials.secretAccessKey.key}")).toBe(
        "ACCESS_SECRET_KEY",
      );
      expect(cluster.kubectlActionsField(stores, name, "{.spec.retentionPolicy}")).toBe("30d");
      expect(cluster.kubectlActionsField(stores, name, "{.spec.configuration.wal.compression}")).toBe("gzip");
      await cluster.expectRow(frame, name);

      cluster.kubectlActions("delete", stores, name, "--wait=true", "--timeout=60s");
      expect(cluster.kubectlActions("get", stores, name).status).not.toBe(0);
      await cluster.clearNotifications(frame);

      // F6: the path of another provider is refused with the scheme it wants.
      await frame.locator(".AddRemoveButtons .add-button").click();
      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await dialog.locator('[data-testid="cnpg-create-object-store-name"]').fill(name);
      await dialog.locator('[data-testid="cnpg-create-object-store-destination"]').fill("s3://backups/");
      await dialog.locator('[data-testid="cnpg-create-object-store-provider-google"]').check();
      expect(
        await dialog.locator('[data-testid="cnpg-create-object-store-destination-field-error"]').innerText(),
      ).toMatch(/starts with gs:\/\//);
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await cluster.cancelDialog(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "declares a role, a database it owns and a publication of it from the forms, and the primary applies them (SPEC-0027)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const roles = "databaseroles.postgresql.cnpg.io";
      const databases = "databases.postgresql.cnpg.io";
      const publications = "publications.postgresql.cnpg.io";
      const primary = () =>
        cluster.kubectlActionsField(clusters, cluster.E2E_ACTIONS_CLUSTER, "{.status.currentPrimary}");

      // Leftovers of an interrupted run, in the order PostgreSQL accepts (the role last, since the database is its).
      for (const [resource, name] of [
        [publications, "e2e-created-pub"],
        [databases, "e2e-created-db"],
        [roles, "e2e-created-role"],
      ]) {
        if (cluster.kubectlActions("get", resource, name).status === 0) {
          cluster.kubectlActions("delete", resource, name, "--wait=true", "--timeout=120s");
        }
      }
      cluster.kubectlActions("delete", "secret", "e2e-created-role-password", "--ignore-not-found");
      cluster.kubectlActions(
        "create",
        "secret",
        "generic",
        "e2e-created-role-password",
        "--type=kubernetes.io/basic-auth",
        "--from-literal=username=e2e_created",
        "--from-literal=password=e2e-created-secret-1",
      );

      // The role, with its password from the secret, a connection limit and the delete policy.
      await cluster.openCnpgPage(frame, "cnpg-databases-databaseroles", "Database Roles");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const role = frame.locator('[data-testid="cnpg-create-role"]');

      await role.waitFor({ state: "visible", timeout: 60_000 });
      expect(await role.locator('[data-testid="cnpg-action-blocked"]').innerText()).toBe("Pick a cluster");
      await pickInSelect(frame, "cnpg-create-role-cluster", cluster.E2E_ACTIONS_CLUSTER);
      await role.locator('[data-testid="cnpg-create-role-name"]').fill("e2e-created-role");
      await role.locator('[data-testid="cnpg-create-role-role-name"]').fill("e2e_created");
      await pickInSelect(frame, "cnpg-create-role-password-secret", "e2e-created-role-password");
      await role.locator('[data-testid="cnpg-create-role-privileges-section-toggle"]').click();
      await role.locator('[data-testid="cnpg-create-role-connection-limit"]').fill("5");
      await role.locator('[data-testid="cnpg-create-role-reclaim-delete"]').check();

      const roleYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: DatabaseRole",
        "metadata:",
        "  name: e2e-created-role",
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.E2E_ACTIONS_CLUSTER}`,
        "  name: e2e_created",
        "  login: true",
        "  connectionLimit: 5",
        "  passwordSecret:",
        "    name: e2e-created-role-password",
        "  databaseRoleReclaimPolicy: delete",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => role.locator('[data-testid="cnpg-create-role-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === roleYaml,
          30_000,
        ),
      ).toBe(roleYaml);
      // The SQL, said before the click.
      expect(
        (await role.locator('[data-testid="cnpg-action-writes"] ~ p').allInnerTexts()).some((note) =>
          note.includes("CREATE ROLE e2e_created WITH LOGIN CONNECTION LIMIT 5"),
        ),
      ).toBe(true);
      await cluster.captureScreenshot(frame, "create-role-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the role object ${cluster.E2E_ACTIONS_NAMESPACE}/e2e-created-role`,
      );
      expect(cluster.kubectlActionsField(roles, "e2e-created-role", "{.spec.name}")).toBe("e2e_created");
      expect(cluster.kubectlActionsField(roles, "e2e-created-role", "{.spec.passwordSecret.name}")).toBe(
        "e2e-created-role-password",
      );
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(roles, "e2e-created-role", "{.status.applied}"),
          (applied) => applied === "true",
          3 * 60_000,
        ),
      ).toBe("true");
      expect(
        psqlActionsIn(
          primary(),
          "postgres",
          "SELECT rolcanlogin || ' ' || rolconnlimit FROM pg_roles WHERE rolname = 'e2e_created'",
        ),
      ).toBe("true 5");
      await cluster.clearNotifications(frame);

      // The database, owned by the role the form now knows, with one extension.
      await cluster.openCnpgPage(frame, "cnpg-databases-databases", "Databases");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const database = frame.locator('[data-testid="cnpg-create-database"]');

      await database.waitFor({ state: "visible", timeout: 60_000 });
      await pickInSelect(frame, "cnpg-create-database-cluster", cluster.E2E_ACTIONS_CLUSTER);
      await database.locator('[data-testid="cnpg-create-database-name"]').fill("e2e-created-db");
      await database.locator('[data-testid="cnpg-create-database-dbname"]').fill("e2e_created_db");
      await pickInSelect(frame, "cnpg-create-database-owner", "e2e_created");
      await database.locator('[data-testid="cnpg-create-database-objects-section-toggle"]').click();
      await database.locator('[data-testid="cnpg-create-database-extensions-add"]').click();
      await database.locator('[data-testid="cnpg-create-database-extensions-0-name"]').fill("pg_stat_statements");
      await database.locator('[data-testid="cnpg-create-database-reclaim-delete"]').check();

      const databaseYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Database",
        "metadata:",
        "  name: e2e-created-db",
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.E2E_ACTIONS_CLUSTER}`,
        "  name: e2e_created_db",
        "  owner: e2e_created",
        "  databaseReclaimPolicy: delete",
        "  extensions:",
        "    - name: pg_stat_statements",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => database.locator('[data-testid="cnpg-create-database-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === databaseYaml,
          30_000,
        ),
      ).toBe(databaseYaml);
      expect(await database.locator('[data-testid="cnpg-create-database-owner-field-warning"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-database-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the database object ${cluster.E2E_ACTIONS_NAMESPACE}/e2e-created-db`,
      );
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(databases, "e2e-created-db", "{.status.applied}"),
          (applied) => applied === "true",
          3 * 60_000,
        ),
      ).toBe("true");
      expect(
        psqlActionsIn(
          primary(),
          "postgres",
          "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'e2e_created_db'",
        ),
      ).toBe("e2e_created");
      expect(
        psqlActionsIn(
          primary(),
          "e2e_created_db",
          "SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements'",
        ),
      ).toBe("pg_stat_statements");
      await cluster.clearNotifications(frame);

      // The publication of every table of that database.
      await cluster.openCnpgPage(frame, "cnpg-databases-publications", "Publications");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const publication = frame.locator('[data-testid="cnpg-create-publication"]');

      await publication.waitFor({ state: "visible", timeout: 60_000 });
      await pickInSelect(frame, "cnpg-create-publication-cluster", cluster.E2E_ACTIONS_CLUSTER);
      await publication.locator('[data-testid="cnpg-create-publication-name"]').fill("e2e-created-pub");
      await publication.locator('[data-testid="cnpg-create-publication-pub-name"]').fill("e2e_created_pub");
      await pickInSelect(frame, "cnpg-create-publication-dbname", "e2e_created_db");
      await publication.locator('[data-testid="cnpg-create-publication-reclaim-delete"]').check();
      expect(
        await waitUntil(
          async () => publication.locator('[data-testid="cnpg-create-publication-yaml"]').getAttribute("data-yaml"),
          (yaml) =>
            Boolean(
              yaml?.includes("  name: e2e_created_pub\n") &&
                yaml.includes("    allTables: true\n") &&
                yaml.includes("  dbname: e2e_created_db\n"),
            ),
          30_000,
        ),
      ).toContain("allTables: true");
      await cluster.captureScreenshot(frame, "create-publication-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the publication object ${cluster.E2E_ACTIONS_NAMESPACE}/e2e-created-pub`,
      );
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(publications, "e2e-created-pub", "{.status.applied}"),
          (applied) => applied === "true",
          3 * 60_000,
        ),
      ).toBe("true");
      expect(
        psqlActionsIn(
          primary(),
          "e2e_created_db",
          "SELECT puballtables FROM pg_publication WHERE pubname = 'e2e_created_pub'",
        ),
      ).toBe("t");
      await cluster.clearNotifications(frame);

      // The delete policy: the objects go, and PostgreSQL is clean behind them.
      cluster.kubectlActions("delete", publications, "e2e-created-pub", "--wait=true", "--timeout=120s");
      cluster.kubectlActions("delete", databases, "e2e-created-db", "--wait=true", "--timeout=120s");
      cluster.kubectlActions("delete", roles, "e2e-created-role", "--wait=true", "--timeout=120s");
      cluster.kubectlActions("delete", "secret", "e2e-created-role-password", "--ignore-not-found");
      expect(
        await waitUntil(
          async () =>
            [
              psqlActionsIn(primary(), "postgres", "SELECT count(*) FROM pg_database WHERE datname = 'e2e_created_db'"),
              psqlActionsIn(primary(), "postgres", "SELECT count(*) FROM pg_roles WHERE rolname = 'e2e_created'"),
            ].join(" "),
          (counts) => counts === "0 0",
          2 * 60_000,
        ),
      ).toBe("0 0");

      // F6: the reserved names are refused at the field, with OK disabled.
      await cluster.openCnpgPage(frame, "cnpg-databases-databaseroles", "Database Roles");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();
      await role.waitFor({ state: "visible", timeout: 60_000 });
      await role.locator('[data-testid="cnpg-create-role-role-name"]').fill("postgres");
      expect(await role.locator('[data-testid="cnpg-create-role-role-name-field-error"]').innerText()).toBe(
        "The role name postgres is reserved",
      );
      expect(await frame.locator('[data-testid="confirm"]').isDisabled()).toBe(true);
      await cluster.cancelDialog(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it(
    "subscribes to the publisher of the fixtures from the form, and the rows arrive (SPEC-0027)",
    async () => {
      const clusters = "clusters.postgresql.cnpg.io";
      const subscriptions = "subscriptions.postgresql.cnpg.io";
      const primary = () =>
        cluster.kubectlActionsField(clusters, cluster.E2E_ACTIONS_CLUSTER, "{.status.currentPrimary}");

      if (cluster.kubectlActions("get", subscriptions, "e2e-created-sub").status === 0) {
        cluster.kubectlActions("delete", subscriptions, "e2e-created-sub", "--wait=true", "--timeout=120s");
      }
      // The published table must exist on the subscriber, with the same columns, before the initial copy.
      psqlActionsIn(primary(), "app", "DROP TABLE IF EXISTS e2e_numbers");
      psqlActionsIn(
        primary(),
        "app",
        "CREATE TABLE e2e_numbers (i integer PRIMARY KEY, m integer); ALTER TABLE e2e_numbers OWNER TO app",
      );

      await cluster.openCnpgPage(frame, "cnpg-databases-subscriptions", "Subscriptions");
      await cluster.selectNamespace(frame, cluster.E2E_ACTIONS_NAMESPACE);
      await frame.locator(".AddRemoveButtons .add-button").click();

      const dialog = frame.locator('[data-testid="cnpg-create-subscription"]');

      await dialog.waitFor({ state: "visible", timeout: 60_000 });
      await pickInSelect(frame, "cnpg-create-subscription-cluster", cluster.E2E_ACTIONS_CLUSTER);
      await dialog.locator('[data-testid="cnpg-create-subscription-name"]').fill("e2e-created-sub");
      await dialog.locator('[data-testid="cnpg-create-subscription-sub-name"]').fill("e2e_created_sub");
      await pickInSelect(frame, "cnpg-create-subscription-dbname", "app");
      // The entry of the subscriber's externalClusters, and the publication the extension knows behind it.
      await pickInSelect(frame, "cnpg-create-subscription-external", "e2e-main");
      await pickInSelect(frame, "cnpg-create-subscription-publication", "e2e_numbers_pub");
      await dialog.locator('[data-testid="cnpg-create-subscription-reclaim-delete"]').check();

      const expectedYaml = [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Subscription",
        "metadata:",
        "  name: e2e-created-sub",
        `  namespace: ${cluster.E2E_ACTIONS_NAMESPACE}`,
        "spec:",
        "  cluster:",
        `    name: ${cluster.E2E_ACTIONS_CLUSTER}`,
        "  dbname: app",
        "  name: e2e_created_sub",
        "  externalClusterName: e2e-main",
        "  publicationName: e2e_numbers_pub",
        "  subscriptionReclaimPolicy: delete",
        "",
      ].join("\n");

      expect(
        await waitUntil(
          async () => dialog.locator('[data-testid="cnpg-create-subscription-yaml"]').getAttribute("data-yaml"),
          (yaml) => yaml === expectedYaml,
          30_000,
        ),
      ).toBe(expectedYaml);
      expect(
        (await dialog.locator('[data-testid="cnpg-action-writes"] ~ p').allInnerTexts()).some((note) =>
          note.includes("CONNECTION '<e2e-main-rw.cnpg-e2e.svc, database app>' PUBLICATION e2e_numbers_pub"),
        ),
      ).toBe(true);
      expect(await dialog.locator('[data-testid="cnpg-action-blocked"]').count()).toBe(0);
      await cluster.captureScreenshot(frame, "create-subscription-dialog-dark");
      await cluster.confirmDialog(frame);
      await cluster.expectNotification(
        frame,
        "ok",
        `Requested the subscription object ${cluster.E2E_ACTIONS_NAMESPACE}/e2e-created-sub`,
      );
      expect(cluster.kubectlActionsField(subscriptions, "e2e-created-sub", "{.spec.externalClusterName}")).toBe(
        "e2e-main",
      );
      expect(
        await waitUntil(
          async () => cluster.kubectlActionsField(subscriptions, "e2e-created-sub", "{.status.applied}"),
          (applied) => applied === "true",
          3 * 60_000,
        ),
      ).toBe("true");
      // The initial copy: the thousand rows of the publisher arrive.
      expect(
        await waitUntil(
          async () => psqlActionsIn(primary(), "app", "SELECT count(*) FROM e2e_numbers"),
          (count) => count === "1000",
          3 * 60_000,
        ),
      ).toBe("1000");
      await cluster.expectRow(frame, "e2e-created-sub");

      cluster.kubectlActions("delete", subscriptions, "e2e-created-sub", "--wait=true", "--timeout=120s");
      expect(
        await waitUntil(
          async () =>
            psqlActionsIn(primary(), "app", "SELECT count(*) FROM pg_subscription WHERE subname = 'e2e_created_sub'"),
          (count) => count === "0",
          2 * 60_000,
        ),
      ).toBe("0");
      psqlActionsIn(primary(), "app", "DROP TABLE IF EXISTS e2e_numbers");
      await cluster.clearNotifications(frame);
      await cluster.selectNamespace(frame);
    },
    TIMEOUT,
  );

  it("logs no error while the writes run", () => {
    expect(session.errors()).toEqual([]);
  });
});
