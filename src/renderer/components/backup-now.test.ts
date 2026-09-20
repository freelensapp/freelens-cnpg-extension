/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  backupMethodOptions,
  backupNameError,
  backupNowBlockReason,
  backupNowBody,
  backupNowDialogFacts,
  backupNowNotes,
  backupNowWarnings,
  canBackUpNow,
  defaultBackupForm,
  defaultBackupName,
  HIBERNATED_BACKUP_REASON,
  NO_BACKUP_METHOD_REASON,
  resolvedTargetSentence,
  unfinishedBackups,
} from "./backup-now";

import type { BackupNowClusterFacts, BackupNowForm } from "./backup-now";

const NOW = new Date("2026-09-20T17:14:34.050Z");
const BARMAN = "barman-cloud.cloudnative-pg.io";

function cluster(overrides: Partial<BackupNowClusterFacts> = {}): BackupNowClusterFacts {
  return {
    name: "pg",
    namespace: "db",
    hibernated: false,
    spec: { plugins: [{ name: BARMAN, isWALArchiver: true }] },
    status: { currentPrimary: "pg-1", readyInstances: 2 },
    ...overrides,
  };
}

function form(overrides: Partial<BackupNowForm> = {}): BackupNowForm {
  return { methodId: `plugin:${BARMAN}`, target: "default", name: "pg-20260920171434", ...overrides };
}

describe("backupMethodOptions", () => {
  it("offers one method per enabled plugin, the WAL archiver first", () => {
    const options = backupMethodOptions(
      cluster({
        spec: {
          plugins: [
            { name: "other.example" },
            { name: "off.example", enabled: false },
            { name: BARMAN, isWALArchiver: true },
          ],
        },
      }),
    );
    expect(options.map((option) => option.id)).toEqual([`plugin:${BARMAN}`, "plugin:other.example"]);
    expect(options[0]).toMatchObject({ method: "plugin", pluginName: BARMAN, deprecated: false });
  });

  it("offers the volume snapshot and, last and marked, the deprecated in-tree method", () => {
    const options = backupMethodOptions(
      cluster({ spec: { plugins: [{ name: BARMAN }], backup: { barmanObjectStore: {}, volumeSnapshot: {} } } }),
    );
    expect(options.map((option) => option.id)).toEqual([`plugin:${BARMAN}`, "volumeSnapshot", "barmanObjectStore"]);
    expect(options[2].deprecated).toBe(true);
    expect(options[2].label).toContain("deprecated");
  });

  it("offers nothing on a cluster that declares nothing", () => {
    expect(backupMethodOptions(cluster({ spec: {} }))).toEqual([]);
    expect(backupMethodOptions(cluster({ spec: undefined }))).toEqual([]);
    expect(backupMethodOptions(cluster({ spec: { plugins: [{ name: BARMAN, enabled: false }] } }))).toEqual([]);
  });
});

describe("canBackUpNow", () => {
  it("is enabled on a cluster with a way to take a backup, even with no ready instance", () => {
    expect(canBackUpNow(cluster())).toEqual({ enabled: true });
    expect(canBackUpNow(cluster({ status: { readyInstances: 0 } }))).toEqual({ enabled: true });
  });

  it("refuses a hibernated cluster first, then one without a method", () => {
    expect(canBackUpNow(cluster({ hibernated: true }))).toEqual({ enabled: false, reason: HIBERNATED_BACKUP_REASON });
    expect(canBackUpNow(cluster({ hibernated: true, spec: {} }))).toEqual({
      enabled: false,
      reason: HIBERNATED_BACKUP_REASON,
    });
    expect(canBackUpNow(cluster({ spec: {} }))).toEqual({ enabled: false, reason: NO_BACKUP_METHOD_REASON });
  });
});

describe("the form defaults", () => {
  it("names the backup after the cluster and the UTC second", () => {
    expect(defaultBackupName("pg", NOW)).toBe("pg-20260920171434");
  });

  it("preselects the first method and the cluster's own target", () => {
    expect(defaultBackupForm(cluster(), NOW)).toEqual({
      methodId: `plugin:${BARMAN}`,
      target: "default",
      name: "pg-20260920171434",
    });
  });

  it("never preselects the deprecated method while another exists, and does when it is alone", () => {
    const both = cluster({ spec: { backup: { barmanObjectStore: {}, volumeSnapshot: {} } } });
    expect(defaultBackupForm(both, NOW).methodId).toBe("volumeSnapshot");
    const alone = cluster({ spec: { backup: { barmanObjectStore: {} } } });
    expect(defaultBackupForm(alone, NOW).methodId).toBe("barmanObjectStore");
  });
});

describe("backupNameError", () => {
  it("accepts a DNS subdomain", () => {
    expect(backupNameError("pg-20260920171434", [], [])).toBeUndefined();
    expect(backupNameError("pg.before-migration", [], [])).toBeUndefined();
  });

  it("refuses an empty, too long or malformed name", () => {
    expect(backupNameError("", [], [])).toBe("A name is required");
    expect(backupNameError("a".repeat(254), [], [])).toContain("253");
    for (const name of ["Pg", "pg_1", "-pg", "pg-", "pg..x", "pg x"]) {
      expect(backupNameError(name, [], [])).toContain("Lowercase letters");
    }
  });

  it("refuses the form of a run of a schedule of this cluster", () => {
    expect(backupNameError("nightly-20260921000000", ["nightly"], [])).toContain("the schedule nightly");
    expect(backupNameError("nightly-2026092100000", ["nightly"], [])).toBeUndefined();
    expect(backupNameError("nightly-manual-20260921000000", ["nightly"], [])).toBeUndefined();
    expect(backupNameError("a.b-20260921000000", ["a.b"], [])).toContain("the schedule a.b");
    expect(backupNameError("axb-20260921000000", ["a.b"], [])).toBeUndefined();
  });

  it("refuses a name that exists", () => {
    expect(backupNameError("pg-1", [], [{ name: "pg-1", phase: "completed" }])).toBe(
      "A backup with this name exists already",
    );
  });
});

describe("the sentences", () => {
  it("resolves the cluster's default target in words", () => {
    expect(resolvedTargetSentence(cluster(), "default")).toBe(
      "Taken from a ready standby when there is one, from the primary pg-1 otherwise (the operator's default: the cluster declares none).",
    );
    expect(resolvedTargetSentence(cluster({ spec: { backup: { target: "primary" } } }), "default")).toBe(
      "Taken from the primary pg-1 (the cluster's .spec.backup.target).",
    );
  });

  it("says what an explicit choice means, without a source", () => {
    expect(resolvedTargetSentence(cluster(), "primary")).toBe("Taken from the primary pg-1.");
    expect(resolvedTargetSentence(cluster({ status: {} }), "prefer-standby")).toBe(
      "Taken from a ready standby when there is one, from the primary otherwise.",
    );
  });

  it("counts the backups that are not finished", () => {
    const existing = [
      { name: "a", phase: "completed" },
      { name: "b", phase: "failed" },
      { name: "c", phase: "running" },
      { name: "d" },
    ];
    expect(unfinishedBackups(existing).map((backup) => backup.name)).toEqual(["c", "d"]);
    expect(backupNowNotes(cluster(), form(), existing)[1]).toBe(
      "2 backups of this cluster are not finished (c, d): the operator runs one at a time, oldest first, so this one waits its turn.",
    );
    expect(backupNowNotes(cluster(), form(), [{ name: "c", phase: "pending" }])[1]).toContain(
      "1 backup of this cluster is",
    );
  });

  it("says that the backup waits when no instance is ready, and always that the spec is final", () => {
    const notes = backupNowNotes(cluster({ status: { readyInstances: 0 } }), form(), []);
    expect(notes).toContain("No instance is ready right now: the backup stays pending until one is.");
    expect(notes[notes.length - 1]).toBe("The spec of a backup cannot be edited once it is created.");
    expect(backupNowNotes(cluster(), form(), [])).toHaveLength(2);
  });

  it("warns only about the deprecated method", () => {
    const both = cluster({ spec: { plugins: [{ name: BARMAN }], backup: { barmanObjectStore: {} } } });
    const options = backupMethodOptions(both);
    expect(backupNowWarnings(form(), options)).toEqual([]);
    expect(backupNowWarnings(form({ methodId: "barmanObjectStore" }), options)).toHaveLength(1);
  });
});

describe("backupNowBody", () => {
  it("creates a plugin backup with the label of the upstream tooling and nothing else", () => {
    expect(backupNowBody(cluster(), form())).toEqual({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Backup",
      metadata: { name: "pg-20260920171434", namespace: "db", labels: { "cnpg.io/cluster": "pg" } },
      spec: { cluster: { name: "pg" }, method: "plugin", pluginConfiguration: { name: BARMAN } },
    });
  });

  it("always names the method and sends the target only when chosen", () => {
    const snapshot = cluster({ spec: { backup: { volumeSnapshot: {} } } });
    const body = backupNowBody(snapshot, form({ methodId: "volumeSnapshot", target: "primary" }));
    expect(body?.spec).toEqual({ cluster: { name: "pg" }, method: "volumeSnapshot", target: "primary" });
  });

  it("never carries the labels that belong to the operator", () => {
    const labels = backupNowBody(cluster(), form())?.metadata.labels ?? {};
    expect(Object.keys(labels)).toEqual(["cnpg.io/cluster"]);
  });

  it("is undefined for a method the cluster does not offer", () => {
    expect(backupNowBody(cluster(), form({ methodId: "volumeSnapshot" }))).toBeUndefined();
    expect(backupNowBody(cluster(), form({ methodId: "" }))).toBeUndefined();
  });
});

describe("the dialog", () => {
  it("lists the one create with what it carries", () => {
    const facts = backupNowDialogFacts(cluster(), form({ target: "prefer-standby" }), []);
    expect(facts.subject).toBe("Cluster db/pg");
    expect(facts.writes).toEqual([
      {
        verb: "create",
        text: `create Backup db/pg-20260920171434: cluster pg, method plugin (${BARMAN}), target prefer-standby, label cnpg.io/cluster=pg`,
      },
    ]);
    expect(facts.typedName).toBeUndefined();
  });

  it("blocks OK on a bad name or a missing method, and on nothing else", () => {
    expect(backupNowBlockReason(cluster(), form(), [], [])).toBeUndefined();
    expect(backupNowBlockReason(cluster(), form({ name: "" }), [], [])).toBe("A name is required");
    expect(backupNowBlockReason(cluster(), form({ methodId: "nope" }), [], [])).toBe("Choose a method");
  });
});
