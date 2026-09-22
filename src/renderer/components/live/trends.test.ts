/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import {
  cacheHitRatio,
  createTrendMemory,
  deltas,
  formatBytes,
  formatSeconds,
  ingestLag,
  ingestMetrics,
  METRICS_CAPACITY,
  metricsSnapshot,
  rates,
  STATUS_CAPACITY,
  sessionsByState,
  trendCards,
  window,
} from "./trends";

import type { InstanceReading } from "./live-model";
import type { MetricsSnapshot } from "./trends";

function exposition(values: Record<string, number>, generation?: number): string {
  const lines = Object.entries(values).map(([name, value]) => `${name} ${value}`);
  if (generation !== undefined) lines.push(`cnpg_last_update_timestamp ${generation}`);
  return lines.join("\n");
}

function readings(primary: string, standby?: string, generation?: number): Map<string, InstanceReading> {
  const map = new Map<string, InstanceReading>();
  map.set(primary, {
    metrics: {
      ok: true,
      value: parsePrometheusText(
        exposition(
          {
            'cnpg_pg_stat_database_xact_commit{datname="app"}': 100,
            'cnpg_pg_stat_database_xact_commit{datname="template1"}': 5,
            'cnpg_pg_stat_database_xact_rollback{datname="app"}': 2,
            'cnpg_pg_stat_database_blks_hit{datname="app"}': 900,
            'cnpg_pg_stat_database_blks_read{datname="app"}': 100,
            cnpg_pg_stat_archiver_archived_count: 10,
            cnpg_pg_stat_archiver_failed_count: 1,
            'cnpg_collector_pg_wal{value="size"}': 33554432,
            'cnpg_collector_pg_wal{value="count"}': 2,
            cnpg_pg_stat_checkpointer_checkpoints_timed: 4,
            cnpg_pg_stat_checkpointer_checkpoints_req: 1,
            'cnpg_pg_stat_database_deadlocks{datname="app"}': 0,
            'cnpg_pg_stat_database_temp_bytes{datname="app"}': 0,
            'cnpg_pg_database_size_bytes{datname="app"}': 8000000,
            'cnpg_pg_database_size_bytes{datname="template1"}': 7000000,
            'cnpg_backends_total{datname="app",state="active"}': 2,
            'cnpg_backends_total{datname="app",state="idle"}': 3,
            'cnpg_backends_total{datname="",state="active",usename="streaming_replica"}': 1,
          },
          generation,
        ),
      ),
    },
  });
  if (standby) {
    map.set(standby, {
      metrics: {
        ok: true,
        value: parsePrometheusText(exposition({ 'cnpg_backends_total{datname="app",state="idle in transaction"}': 1 })),
      },
    });
  }
  return map;
}

describe("the snapshot of a round", () => {
  it("reads the primary's counters without the templates, the sessions of every instance, and the cache generation", () => {
    const snapshot = metricsSnapshot(1000, "pg-1", readings("pg-1", "pg-2", 1700000000));
    expect(snapshot).toBeDefined();
    expect(snapshot?.time).toBe(1700000000000);
    expect(snapshot?.generation).toBe(1700000000);
    expect(snapshot?.xactCommit).toBe(100);
    expect(snapshot?.blksHit).toBe(900);
    expect(snapshot?.walSizeBytes).toBe(33554432);
    expect(snapshot?.checkpointsTimed).toBe(4);
    expect(snapshot?.databaseSizes).toEqual({ app: 8000000 });
    expect(snapshot?.sessions).toEqual({ active: 3, idle: 3, "idle in transaction": 1, other: 0 });
    expect(metricsSnapshot(1000, "pg-1", readings("pg-1"))?.time).toBe(1000);
    expect(metricsSnapshot(1000, undefined, readings("pg-1"))).toBeUndefined();
    expect(metricsSnapshot(1000, "pg-9", readings("pg-1"))).toBeUndefined();
  });

  it("falls back to the bgwriter checkpoint counters of older PostgreSQL", () => {
    const map = new Map<string, InstanceReading>();
    map.set("pg-1", {
      metrics: {
        ok: true,
        value: parsePrometheusText(
          exposition({ cnpg_pg_stat_bgwriter_checkpoints_timed: 7, cnpg_pg_stat_bgwriter_checkpoints_req: 2 }),
        ),
      },
    });
    const snapshot = metricsSnapshot(1000, "pg-1", map);
    expect(snapshot?.checkpointsTimed).toBe(7);
    expect(snapshot?.checkpointsRequested).toBe(2);
    expect(sessionsByState([])).toEqual({ active: 0, idle: 0, "idle in transaction": 0, other: 0 });
  });
});

describe("the memory", () => {
  it("keeps one point per cache generation and stays bounded", () => {
    const memory = createTrendMemory(0);
    expect(ingestMetrics(memory, 1000, "pg-1", readings("pg-1", undefined, 100))).toBe(true);
    expect(ingestMetrics(memory, 6000, "pg-1", readings("pg-1", undefined, 100))).toBe(false);
    expect(ingestMetrics(memory, 31000, "pg-1", readings("pg-1", undefined, 130))).toBe(true);
    expect(memory.metrics).toHaveLength(2);
    for (let index = 0; index < METRICS_CAPACITY + 10; index += 1) {
      ingestMetrics(memory, 40000 + index * 1000, "pg-1", readings("pg-1", undefined, 200 + index));
    }
    expect(memory.metrics).toHaveLength(METRICS_CAPACITY);
    ingestLag(memory, 1000, [{ standby: "pg-2", replayLagMs: 12 }, { standby: "pg-3" }]);
    ingestLag(memory, 1000, [{ standby: "pg-2", replayLagMs: 99 }]);
    expect(memory.lags).toEqual([{ time: 1000, lag: { "pg-2": 12 } }]);
    for (let index = 0; index < STATUS_CAPACITY + 5; index += 1)
      ingestLag(memory, 2000 + index, [{ standby: "pg-2", replayLagMs: index }]);
    expect(memory.lags).toHaveLength(STATUS_CAPACITY);
  });
});

describe("the arithmetic", () => {
  const snapshots: MetricsSnapshot[] = [
    {
      time: 0,
      xactCommit: 100,
      blksHit: 900,
      blksRead: 100,
      archived: 10,
      databaseSizes: {},
      sessions: { active: 0, idle: 0, "idle in transaction": 0, other: 0 },
    },
    {
      time: 30000,
      xactCommit: 160,
      blksHit: 990,
      blksRead: 110,
      archived: 12,
      databaseSizes: {},
      sessions: { active: 0, idle: 0, "idle in transaction": 0, other: 0 },
    },
    {
      time: 60000,
      xactCommit: 40,
      blksHit: 1000,
      blksRead: 110,
      archived: 12,
      databaseSizes: {},
      sessions: { active: 0, idle: 0, "idle in transaction": 0, other: 0 },
    },
    {
      time: 90000,
      xactCommit: 70,
      blksHit: 1000,
      blksRead: 110,
      archived: 15,
      databaseSizes: {},
      sessions: { active: 0, idle: 0, "idle in transaction": 0, other: 0 },
    },
  ];

  it("takes rates and deltas between consecutive snapshots and skips a counter that went down", () => {
    expect(rates(snapshots, "xactCommit")).toEqual([
      { x: 30000, y: 2 },
      { x: 90000, y: 1 },
    ]);
    expect(deltas(snapshots, "archived")).toEqual([
      { x: 30000, y: 2 },
      { x: 60000, y: 0 },
      { x: 90000, y: 3 },
    ]);
    expect(rates(snapshots, "xactRollback")).toEqual([]);
  });

  it("computes the cache hit ratio per interval and gives no point without reads", () => {
    expect(cacheHitRatio(snapshots)).toEqual([
      { x: 30000, y: 90 },
      { x: 60000, y: 100 },
    ]);
  });

  it("cuts the window of a range and spans the axis", () => {
    const points = [
      { x: 0, y: 1 },
      { x: 600000, y: 2 },
      { x: 3500000, y: 3 },
    ];
    expect(window(points, "5m", 3600000, 0)).toEqual({ points: [{ x: 3500000, y: 3 }], minTime: 3300, maxTime: 3600 });
    expect(window(points, "1h", 3700000, 0).points).toHaveLength(2);
    expect(window(points, "all", 3600000, 0)).toEqual({ points, minTime: 0, maxTime: 3600 });
  });

  it("formats the figures", () => {
    expect(formatSeconds(250)).toBe("250 ms");
    expect(formatSeconds(1500)).toBe("1.50 s");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(33554432)).toBe("32.0 MiB");
  });
});

describe("the cards", () => {
  it("are nine, with their series, tokens and last values", () => {
    const memory = createTrendMemory(0);
    ingestMetrics(memory, 1000, "pg-1", readings("pg-1", "pg-2", 100));
    ingestMetrics(memory, 31000, "pg-1", readings("pg-1", "pg-2", 130));
    ingestLag(memory, 1000, [{ standby: "pg-2", replayLagMs: 1500 }]);
    const cards = trendCards(memory);
    expect(cards.map((card) => card.key)).toEqual([
      "sessions",
      "lag",
      "transactions",
      "cacheHit",
      "walArchiving",
      "walSize",
      "databaseSizes",
      "checkpoints",
      "contention",
    ]);
    const sessions = cards[0];
    expect(sessions.series.map((series) => series.label)).toEqual(["active", "idle", "idle in transaction", "other"]);
    expect(sessions.series[0].token).toBe("--colorInfo");
    expect(sessions.last).toBe("7");
    expect(cards[1].series[0].label).toBe("pg-2");
    expect(cards[1].last).toBe("1.50 s");
    expect(cards[2].series[0].points).toEqual([{ x: 130000, y: 0 }]);
    expect(cards[5].last).toBe("32.0 MiB");
    expect(cards[6].series.map((series) => series.label)).toEqual(["app"]);
    expect(cards[8].series[1].secondAxis).toBe(true);
    expect(trendCards(createTrendMemory(0))[3].last).toBeUndefined();
  });
});
