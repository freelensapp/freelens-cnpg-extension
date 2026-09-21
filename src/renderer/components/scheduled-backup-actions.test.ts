/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canResume,
  canRunNow,
  canSuspend,
  HIBERNATED_RUN_NOW_REASON,
  NO_CLUSTER_RUN_NOW_REASON,
  REQUESTED_FROM_SCHEDULE_ANNOTATION,
  RESUME_PATCH,
  resumeFacts,
  runNowBackup,
  runNowBackupName,
  runNowFacts,
  runNowOwnershipSentence,
  SUSPEND_PATCH,
  scheduleRunPattern,
  suspendEntry,
  suspendFacts,
} from "./scheduled-backup-actions";

import type { ScheduleFacts } from "./scheduled-backup-actions";

const NOW = new Date("2026-09-21T10:15:42.500Z");
const BARMAN = "barman-cloud.cloudnative-pg.io";

function schedule(spec: ScheduleFacts["spec"] = {}, status?: ScheduleFacts["status"]): ScheduleFacts {
  return { name: "pg-weekly", namespace: "db", spec: { cluster: { name: "pg" }, ...spec }, status };
}

describe("suspendEntry", () => {
  it("offers Suspend while suspend is absent or false, Resume while it is true", () => {
    expect(suspendEntry(schedule())).toBe("suspend");
    expect(suspendEntry(schedule({ suspend: false }))).toBe("suspend");
    expect(suspendEntry(schedule({ suspend: true }))).toBe("resume");
  });

  it("refuses, on the click, the write that would change nothing", () => {
    expect(canSuspend(schedule()).enabled).toBe(true);
    expect(canSuspend(schedule({ suspend: false })).enabled).toBe(true);
    expect(canSuspend(schedule({ suspend: true }))).toEqual({
      enabled: false,
      reason: "The schedule is suspended already",
    });
    expect(canResume(schedule({ suspend: true })).enabled).toBe(true);
    expect(canResume(schedule())).toEqual({ enabled: false, reason: "The schedule is not suspended" });
  });
});

describe("suspendFacts", () => {
  it("lists the one patch with the value it replaces", () => {
    expect(suspendFacts(schedule()).writes).toEqual([
      { verb: "patch", text: "patch ScheduledBackup db/pg-weekly: spec.suspend (unset) -> true" },
    ]);
    expect(suspendFacts(schedule({ suspend: false })).writes[0].text).toBe(
      "patch ScheduledBackup db/pg-weekly: spec.suspend false -> true",
    );
  });

  it("names the schedule and says what stops and what does not", () => {
    const facts = suspendFacts(schedule());

    expect(facts.subject).toBe("ScheduledBackup db/pg-weekly");
    expect(facts.notes[0]).toContain("creates no backup of pg");
    expect(facts.notes[1]).toContain("WAL archiving does not depend on the schedule");
    expect(facts.warnings).toEqual([]);
    expect(facts.typedName).toBeUndefined();
  });

  it("sends the explicit values", () => {
    expect(SUSPEND_PATCH).toEqual({ spec: { suspend: true } });
    expect(RESUME_PATCH).toEqual({ spec: { suspend: false } });
  });
});

describe("resumeFacts", () => {
  it("warns that one backup is created at once when the next run is in the past", () => {
    const facts = resumeFacts(schedule({ suspend: true }, { nextScheduleTime: "2026-09-20T03:00:00Z" }), NOW);

    expect(facts.writes).toEqual([
      { verb: "patch", text: "patch ScheduledBackup db/pg-weekly: spec.suspend true -> false" },
    ]);
    expect(facts.warnings).toHaveLength(1);
    expect(facts.warnings[0]).toContain("2026-09-20T03:00:00.000Z");
    expect(facts.warnings[0]).toContain("one backup of pg right away");
    expect(facts.warnings[0]).toContain("does not replay every run");
    expect(facts.notes).toEqual([]);
  });

  it("says when the next run is due when it is in the future", () => {
    const facts = resumeFacts(schedule({ suspend: true }, { nextScheduleTime: "2026-09-27T03:00:00Z" }), NOW);

    expect(facts.warnings).toEqual([]);
    expect(facts.notes).toEqual(["The next run is due at 2026-09-27T03:00:00.000Z: nothing is created before then."]);
  });

  it("says that no next run is reported when there is no status at all", () => {
    const facts = resumeFacts(schedule({ suspend: true }), NOW);

    expect(facts.warnings).toEqual([]);
    expect(facts.notes).toEqual([
      "The schedule reports no next run yet: the operator computes it when it sees the schedule again.",
    ]);
  });
});

describe("canRunNow", () => {
  it("is refused when the cluster is not in the namespace", () => {
    expect(canRunNow(schedule(), undefined)).toEqual({ enabled: false, reason: NO_CLUSTER_RUN_NOW_REASON });
  });

  it("is not refused while the clusters of the namespace are still loading", () => {
    expect(canRunNow(schedule(), undefined, false).enabled).toBe(true);
    expect(canRunNow(schedule(), { name: "pg", hibernated: true }, false).enabled).toBe(false);
  });

  it("is refused on a hibernated cluster", () => {
    expect(canRunNow(schedule(), { name: "pg", hibernated: true })).toEqual({
      enabled: false,
      reason: HIBERNATED_RUN_NOW_REASON,
    });
  });

  it("is offered on a running cluster, suspended schedule included", () => {
    expect(canRunNow(schedule(), { name: "pg", hibernated: false }).enabled).toBe(true);
    expect(canRunNow(schedule({ suspend: true }), { name: "pg", hibernated: false }).enabled).toBe(true);
  });
});

describe("runNowBackup", () => {
  it("names the backup so that it can never be taken for a run of the schedule", () => {
    const name = runNowBackupName("pg-weekly", NOW);

    expect(name).toBe("pg-weekly-manual-20260921101542");
    expect(scheduleRunPattern("pg-weekly").test(name)).toBe(false);
    expect(scheduleRunPattern("pg-weekly").test("pg-weekly-20260921030000")).toBe(true);
    expect(scheduleRunPattern("pg.weekly").test("pgxweekly-20260921030000")).toBe(false);
  });

  it("carries the cluster label and the annotation of the schedule, and nothing of the operator", () => {
    const body = runNowBackup(schedule({ method: "plugin", pluginConfiguration: { name: BARMAN } }), NOW);

    expect(body?.metadata).toEqual({
      name: "pg-weekly-manual-20260921101542",
      namespace: "db",
      labels: { "cnpg.io/cluster": "pg" },
      annotations: { [REQUESTED_FROM_SCHEDULE_ANNOTATION]: "pg-weekly" },
    });
    expect(Object.keys(body?.metadata.labels ?? {})).not.toContain("cnpg.io/scheduled-backup");
    expect(Object.keys(body?.metadata.labels ?? {})).not.toContain("cnpg.io/immediateBackup");
    expect(body?.metadata).not.toHaveProperty("ownerReferences");
  });

  it("copies each of the fields the controller copies, when the schedule declares it", () => {
    const body = runNowBackup(
      schedule({
        method: "plugin",
        target: "primary",
        online: true,
        onlineConfiguration: { immediateCheckpoint: true, waitForArchive: false },
        pluginConfiguration: { name: BARMAN, parameters: { key: "value" } },
      }),
      NOW,
    );

    expect(body?.spec).toEqual({
      cluster: { name: "pg" },
      method: "plugin",
      target: "primary",
      online: true,
      onlineConfiguration: { immediateCheckpoint: true, waitForArchive: false },
      pluginConfiguration: { name: BARMAN, parameters: { key: "value" } },
    });
  });

  it("leaves out every field the schedule does not declare, `online: false` kept", () => {
    expect(runNowBackup(schedule(), NOW)?.spec).toEqual({ cluster: { name: "pg" } });
    expect(runNowBackup(schedule({ online: false }), NOW)?.spec).toEqual({ cluster: { name: "pg" }, online: false });
  });

  it("copies nothing else of the schedule", () => {
    const body = runNowBackup(schedule({ suspend: true, backupOwnerReference: "self", method: "plugin" }), NOW);

    expect(body?.spec).toEqual({ cluster: { name: "pg" }, method: "plugin" });
  });

  it("has no body for a schedule that names no cluster", () => {
    expect(runNowBackup({ name: "pg-weekly", namespace: "db", spec: {} }, NOW)).toBeUndefined();
    expect(runNowFacts({ name: "pg-weekly", namespace: "db", spec: {} }, NOW).writes).toEqual([]);
  });
});

describe("runNowOwnershipSentence", () => {
  it("says what the missing owner means for each value of backupOwnerReference", () => {
    expect(runNowOwnershipSentence("self")).toContain("it stays when the schedule is deleted");
    expect(runNowOwnershipSentence("cluster")).toContain("it stays when the cluster is deleted");
    expect(runNowOwnershipSentence("none")).toContain("Like the backups of the schedule");
    expect(runNowOwnershipSentence(undefined)).toBe(runNowOwnershipSentence("none"));
  });
});

describe("runNowFacts", () => {
  it("lists the one create with the method, the label and the annotation", () => {
    const facts = runNowFacts(
      schedule({ method: "plugin", pluginConfiguration: { name: BARMAN }, backupOwnerReference: "self" }),
      NOW,
    );

    expect(facts.subject).toBe("ScheduledBackup db/pg-weekly");
    expect(facts.writes).toEqual([
      {
        verb: "create",
        text: `create Backup db/pg-weekly-manual-20260921101542: cluster pg, method plugin (${BARMAN}), label cnpg.io/cluster=pg, annotation ${REQUESTED_FROM_SCHEDULE_ANNOTATION}=pg-weekly`,
      },
    ]);
    expect(facts.notes[0]).toContain("not a run of it");
    expect(facts.notes[1]).toBe(runNowOwnershipSentence("self"));
    expect(facts.warnings).toEqual([]);
  });

  it("spells the target when the schedule declares one", () => {
    const facts = runNowFacts(schedule({ method: "volumeSnapshot", target: "primary" }), NOW);

    expect(facts.writes[0].text).toContain("method volumeSnapshot, target primary,");
  });

  it("says first that a suspended schedule stays suspended", () => {
    const facts = runNowFacts(schedule({ suspend: true, method: "plugin" }), NOW);

    expect(facts.notes[0]).toBe("The schedule is suspended and stays suspended: only this one backup is requested.");
    expect(facts.notes).toHaveLength(3);
  });

  it("warns on the deprecated method, declared or left to the default of the API", () => {
    expect(runNowFacts(schedule({ method: "barmanObjectStore" }), NOW).warnings).toHaveLength(1);
    expect(runNowFacts(schedule(), NOW).warnings).toHaveLength(1);
    expect(runNowFacts(schedule(), NOW).writes[0].text).toContain("method left to the default of the API");
  });
});
