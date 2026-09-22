/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { FIVE_FIELDS_REASON } from "./cron";
import {
  defaultMethodId,
  defaultScheduledBackupForm,
  NO_METHOD_REASON,
  scheduledBackupBlockReason,
  scheduledBackupBody,
  scheduledBackupErrors,
  scheduledBackupFacts,
  scheduledBackupSummaryWarnings,
  scheduledBackupWarnings,
  scheduleMethodOptions,
} from "./scheduled-backup-create";

import type { ScheduledBackupForm, ScheduledBackupInputs } from "./scheduled-backup-create";

const NOW = new Date("2026-09-22T10:15:30Z");

const READY: ScheduledBackupInputs = {
  clusters: [
    {
      name: "pg",
      namespace: "db",
      hibernated: false,
      phase: "Cluster in healthy state",
      spec: {
        plugins: [{ name: "barman-cloud.cloudnative-pg.io", isWALArchiver: true }],
        backup: { volumeSnapshot: {} },
      },
    },
    {
      name: "sleepy",
      namespace: "db",
      hibernated: true,
      spec: { plugins: [{ name: "barman-cloud.cloudnative-pg.io" }] },
    },
    { name: "bare", namespace: "db", hibernated: false, phase: "Cluster in healthy state", spec: {} },
    { name: "legacy", namespace: "db", hibernated: false, spec: { backup: { barmanObjectStore: {} } } },
  ],
  schedules: ["pg-weekly"],
  volumeSnapshotCrd: true,
  reads: { clusters: "ready", schedules: "ready", crds: "ready" },
};

function filled(overrides: Partial<ScheduledBackupForm> = {}): ScheduledBackupForm {
  const form = defaultScheduledBackupForm("db", "pg");
  return { ...form, methodId: "plugin:barman-cloud.cloudnative-pg.io", ...overrides };
}

describe("the methods of the picked cluster", () => {
  it("offers the plugin and the snapshot, never the deprecated method, and picks the first usable", () => {
    expect(scheduleMethodOptions(READY, filled()).map((option) => option.id)).toEqual([
      "plugin:barman-cloud.cloudnative-pg.io",
      "volumeSnapshot",
    ]);
    expect(scheduleMethodOptions(READY, filled({ cluster: "legacy" }))).toEqual([]);
    expect(defaultMethodId(READY, filled())).toBe("plugin:barman-cloud.cloudnative-pg.io");
    const noCrd = { ...READY, volumeSnapshotCrd: false };
    expect(scheduleMethodOptions(noCrd, filled())[1].reason).toMatch(/VolumeSnapshot CRD/);
    expect(defaultMethodId(noCrd, filled({ cluster: "pg" }))).toBe("plugin:barman-cloud.cloudnative-pg.io");
  });
});

describe("the errors and the warnings", () => {
  it("wants a cluster, a name, a schedule the operator reads and a method it offers", () => {
    expect(scheduledBackupBlockReason(READY, defaultScheduledBackupForm("db"))).toBe("Pick a cluster");
    expect(scheduledBackupBlockReason(READY, filled({ name: "" }))).toBe("A name is required");
    expect(
      scheduledBackupBlockReason(READY, filled({ cron: { ...filled().cron, preset: "custom", custom: "0 0 3 * *" } })),
    ).toBe(FIVE_FIELDS_REASON);
    expect(scheduledBackupBlockReason(READY, filled({ cron: { ...filled().cron, minute: "61" } }))).toBe(
      "The minute is a number from 0 to 59",
    );
    expect(scheduledBackupErrors(READY, filled({ methodId: "" })).methodId).toBe("Pick a method");
    expect(scheduledBackupErrors(READY, filled({ methodId: "barmanObjectStore" })).methodId).toBe(
      "Pick a method the cluster offers",
    );
    expect(scheduledBackupErrors(READY, filled({ cluster: "bare", methodId: "" })).methodId).toBe(NO_METHOD_REASON);
    expect(
      scheduledBackupErrors({ ...READY, volumeSnapshotCrd: false }, filled({ methodId: "volumeSnapshot" })).methodId,
    ).toMatch(/cannot be scheduled/);
    expect(scheduledBackupBlockReason(READY, filled())).toBeUndefined();
    expect(scheduledBackupBlockReason(READY, filled(), "denied")).toBe("denied");
  });

  it("warns on a collision and on a cluster the read did not see", () => {
    expect(scheduledBackupWarnings(READY, filled({ name: "pg-weekly" })).name).toMatch(/already exists/);
    expect(scheduledBackupWarnings(READY, filled({ cluster: "ghost" })).cluster).toMatch(/No cluster named ghost/);
    expect(
      scheduledBackupWarnings(
        { ...READY, reads: { ...READY.reads, clusters: "loading" } },
        filled({ cluster: "ghost" }),
      ),
    ).toEqual({});
  });

  it("says what it costs in the summary", () => {
    expect(scheduledBackupSummaryWarnings(READY, filled({ cluster: "sleepy", immediate: true }), NOW)[0]).toMatch(
      /hibernated: the first backup right away fails/,
    );
    expect(scheduledBackupSummaryWarnings(READY, filled({ cluster: "sleepy" }), NOW)).toEqual([
      "The cluster is hibernated: every run fails until the cluster is resumed.",
      "The cluster declares no WAL archiver: point in time recovery is not possible from these backups.",
    ]);
    expect(
      scheduledBackupSummaryWarnings(
        READY,
        filled({ cron: { ...filled().cron, preset: "custom", custom: "0 */5 * * * *" } }),
        NOW,
      ),
    ).toEqual(["Runs every 5 minutes: backups of one cluster run one at a time, and the others queue."]);
    expect(scheduledBackupSummaryWarnings(READY, filled(), NOW)).toEqual([]);
  });
});

describe("the body and the facts", () => {
  it("always sends the method, the plugin name, immediate and the owner", () => {
    expect(scheduledBackupBody(READY, filled())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ScheduledBackup",
      metadata: { name: "pg-daily", namespace: "db" },
      spec: {
        cluster: { name: "pg" },
        schedule: "0 0 3 * * *",
        method: "plugin",
        pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
        immediate: false,
        backupOwnerReference: "none",
      },
    });
  });

  it("carries the snapshot options only for a snapshot, and the rest when set", () => {
    const body = scheduledBackupBody(
      READY,
      filled({
        methodId: "volumeSnapshot",
        target: "primary",
        online: true,
        immediateCheckpoint: true,
        immediate: true,
        suspend: true,
        owner: "self",
      }),
    ) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      cluster: { name: "pg" },
      schedule: "0 0 3 * * *",
      method: "volumeSnapshot",
      target: "primary",
      online: true,
      onlineConfiguration: { immediateCheckpoint: true, waitForArchive: true },
      immediate: true,
      suspend: true,
      backupOwnerReference: "self",
    });
    const plugin = scheduledBackupBody(READY, filled({ online: false, immediateCheckpoint: true })) as {
      spec: Record<string, unknown>;
    };
    expect(plugin.spec.online).toBeUndefined();
    expect(plugin.spec.onlineConfiguration).toBeUndefined();
  });

  it("tells the runs, the naming, the owner and the plugin", () => {
    const facts = scheduledBackupFacts(READY, filled({ immediate: true, owner: "self" }), NOW);
    expect(facts.subject).toBe("ScheduledBackup db/pg-daily");
    expect(facts.writes[0].text).toBe(
      'create ScheduledBackup db/pg-daily: cluster pg, schedule "0 0 3 * * *", method plugin (barman-cloud.cloudnative-pg.io), owner self',
    );
    expect(facts.notes[0]).toBe(
      "Runs at 03:00 (in the operator's time zone, normally UTC); next at 2026-09-23 03:00:00 UTC, 2026-09-24 03:00:00 UTC, 2026-09-25 03:00:00 UTC.",
    );
    expect(facts.notes).toContain(
      "Each run creates a Backup named pg-daily-<time of the run>, labelled as a child of the schedule.",
    );
    expect(facts.notes).toContain("A first backup is requested as soon as the schedule exists.");
    expect(facts.notes).toContain("The schedule owns its backups: deleting the schedule deletes them.");
    expect(facts.notes).toContain(
      "The plugin barman-cloud.cloudnative-pg.io takes the backup on the cluster's default target.",
    );
  });
});
