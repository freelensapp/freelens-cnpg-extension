/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { buildHistory, LONG_WINDOW_DAYS, SHORT_WINDOW_DAYS, schedulesOfCluster } from "./backup-history";

import type { ScheduledBackupStatus } from "../api/cnpg/scheduled-backup-v1";

const NOW = new Date("2026-09-19T12:00:00Z");
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

function makeBackup(name: string, phase: string, stoppedAgoMs: number): Backup {
  const stopped = ago(stoppedAgoMs);
  return new Backup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace: "db", creationTimestamp: stopped },
    spec: { cluster: { name: "pg" }, method: "plugin" },
    status: phase === "completed" ? { phase, startedAt: stopped, stoppedAt: stopped } : { phase, startedAt: stopped },
  } as never);
}

function makeSchedule(
  name: string,
  status: ScheduledBackupStatus,
  { suspend = false, cluster = "pg", namespace = "db" } = {},
): ScheduledBackup {
  return new ScheduledBackup({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "ScheduledBackup",
    metadata: { name, namespace },
    spec: { cluster: { name: cluster }, schedule: "0 0 3 * * *", suspend },
    status,
  } as never);
}

describe("buildHistory", () => {
  it("uses the short window when it holds two backups at least, the long one otherwise", () => {
    const busy = buildHistory(
      [makeBackup("a", "completed", DAY_MS), makeBackup("b", "completed", 2 * DAY_MS)],
      [],
      NOW,
    );
    expect(busy.windowDays).toBe(SHORT_WINDOW_DAYS);
    expect(busy.windowStart.toISOString()).toBe("2026-09-12T12:00:00.000Z");

    const sparse = buildHistory(
      [makeBackup("a", "completed", DAY_MS), makeBackup("old", "completed", 20 * DAY_MS)],
      [],
      NOW,
    );
    expect(sparse.windowDays).toBe(LONG_WINDOW_DAYS);
    expect(sparse.marks.map((mark) => mark.names)).toEqual([["old"], ["a"]]);

    expect(buildHistory([], [], NOW)).toMatchObject({ windowDays: LONG_WINDOW_DAYS, marks: [] });
  });

  it("places the marks from the start of the window to now and leaves out what is older", () => {
    const history = buildHistory(
      [
        makeBackup("recent", "completed", 0),
        makeBackup("middle", "completed", 3.5 * DAY_MS),
        makeBackup("ancient", "completed", 40 * DAY_MS),
      ],
      [],
      NOW,
    );
    expect(history.marks.map((mark) => mark.names[0])).toEqual(["middle", "recent"]);
    expect(history.marks[0].position).toBeCloseTo(0.5, 5);
    expect(history.marks[1].position).toBe(1);
    // What is older than the window still counts for the recoverability point.
    expect(history.recoverableFrom?.time.toISOString()).toBe(ago(40 * DAY_MS));
    expect(history.recoverableFrom?.position).toBe(0);
  });

  it("merges the backups the strip cannot tell apart, latest first, worst state wins", () => {
    const history = buildHistory(
      [
        // Three backups within the same three hour slot of the seven day strip.
        makeBackup("ok-1", "completed", 2 * DAY_MS - 10 * 60_000),
        makeBackup("failed", "failed", 2 * DAY_MS - 20 * 60_000),
        makeBackup("ok-2", "completed", 2 * DAY_MS - 30 * 60_000),
        makeBackup("alone", "completed", 5 * DAY_MS),
      ],
      [],
      NOW,
    );
    expect(history.marks).toHaveLength(2);
    expect(history.marks[1]).toMatchObject({ state: "Failed", names: ["ok-2", "failed", "ok-1"] });
    expect(history.marks[1].time.toISOString()).toBe(ago(2 * DAY_MS - 30 * 60_000));
    expect(history.marks[0]).toMatchObject({ state: "Completed", names: ["alone"] });
  });

  it("keeps running and failed backups out of the successful facts", () => {
    const history = buildHistory(
      [
        makeBackup("ok", "completed", 3 * DAY_MS),
        makeBackup("bad", "failed", DAY_MS),
        makeBackup("now", "running", HOUR_MS),
      ],
      [],
      NOW,
    );
    expect(history.lastSuccessful?.toISOString()).toBe(ago(3 * DAY_MS));
    expect(history.marks.map((mark) => mark.state)).toEqual(["Completed", "Failed", "Running"]);
  });

  it("measures the longest gap between successful backups, the one up to now included", () => {
    const regular = buildHistory(
      [
        makeBackup("a", "completed", 6 * DAY_MS),
        makeBackup("b", "completed", 2 * DAY_MS),
        makeBackup("c", "completed", DAY_MS),
      ],
      [],
      NOW,
    );
    expect(regular.longestGapMs).toBe(4 * DAY_MS);

    const stale = buildHistory(
      [makeBackup("a", "completed", 6 * DAY_MS), makeBackup("b", "completed", 5 * DAY_MS)],
      [],
      NOW,
    );
    expect(stale.longestGapMs).toBe(5 * DAY_MS);

    expect(buildHistory([makeBackup("bad", "failed", DAY_MS)], [], NOW).longestGapMs).toBeUndefined();
  });

  it("shows no recoverability window while archiving fails", () => {
    const backups = [makeBackup("a", "completed", 2 * DAY_MS), makeBackup("b", "completed", DAY_MS)];
    expect(buildHistory(backups, [], NOW).recoverableFrom?.time.toISOString()).toBe(ago(2 * DAY_MS));
    expect(buildHistory(backups, [], NOW, { archivingFailing: true }).recoverableFrom).toBeUndefined();
    expect(buildHistory([makeBackup("bad", "failed", DAY_MS)], [], NOW).recoverableFrom).toBeUndefined();
  });

  it("takes the earliest next run among the schedules that are not suspended", () => {
    const schedules = [
      makeSchedule("weekly", { nextScheduleTime: "2026-09-21T03:00:00Z" }),
      makeSchedule("nightly", { nextScheduleTime: "2026-09-20T03:00:00Z" }),
      makeSchedule("paused", { nextScheduleTime: "2026-09-19T13:00:00Z" }, { suspend: true }),
      makeSchedule("fresh", {}),
    ];
    const history = buildHistory([], schedules, NOW);
    expect(history.nextRun?.toISOString()).toBe("2026-09-20T03:00:00.000Z");
    expect(history.hasActiveSchedule).toBe(true);

    const onlyPaused = buildHistory([], [schedules[2]], NOW);
    expect(onlyPaused.nextRun).toBeUndefined();
    expect(onlyPaused.hasActiveSchedule).toBe(false);
  });

  it("ignores a backup dated in the future", () => {
    expect(buildHistory([makeBackup("clock-skew", "completed", -HOUR_MS)], [], NOW).marks).toEqual([]);
  });
});

describe("schedulesOfCluster", () => {
  it("matches the cluster name and the namespace", () => {
    const cluster = new Cluster({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: "pg", namespace: "db" },
      spec: { instances: 1 },
    } as never);
    const schedules = [
      makeSchedule("mine", {}),
      makeSchedule("other-cluster", {}, { cluster: "pg2" }),
      makeSchedule("other-namespace", {}, { namespace: "elsewhere" }),
    ];
    expect(schedulesOfCluster(cluster, schedules).map((schedule) => schedule.metadata.name)).toEqual(["mine"]);
  });
});
