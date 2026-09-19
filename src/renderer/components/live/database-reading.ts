/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the exporter of the primary knows about one database (SPEC-0013 "Right
// now") and about one replication slot (SPEC-0015): size, transaction ID age
// and sessions by state; whether a slot is being consumed and the WAL it
// keeps. Pure functions over the parsed samples; no SQL anywhere.

import { selectSamples, singleValue } from "../../api/instance/prometheus-text";
import { XID_AGE_ERROR, XID_AGE_WARNING } from "./live-model";

import type { MetricSample } from "../../api/instance/prometheus-text";
import type { Level } from "./live-model";

/** Sessions the platform itself keeps open; they say nothing about the use of a database. */
const PLATFORM_USERS: readonly string[] = ["streaming_replica", "cnpg_metrics_exporter"];

export interface DatabaseReading {
  sizeBytes?: number;
  xidAge?: number;
  xidLevel: Level;
  /** Sessions of users, by state, busiest first. */
  sessions: { state: string; count: number }[];
  totalSessions: number;
}

/** `undefined` when the exporter does not list the database: PostgreSQL does not have it. */
export function readDatabase(samples: readonly MetricSample[], datname: string): DatabaseReading | undefined {
  const sizeBytes = singleValue(samples, "cnpg_pg_database_size_bytes", { datname });
  const xidAge = singleValue(samples, "cnpg_pg_database_xid_age", { datname });
  if (sizeBytes === undefined && xidAge === undefined) return undefined;

  const byState = new Map<string, number>();
  for (const sample of selectSamples(samples, "cnpg_backends_total", { datname })) {
    if (PLATFORM_USERS.includes(sample.labels.usename ?? "")) continue;
    if (Number.isNaN(sample.value)) continue;
    const state = sample.labels.state || "unknown";
    byState.set(state, (byState.get(state) ?? 0) + sample.value);
  }
  const sessions = [...byState.entries()]
    .map(([state, count]) => ({ state, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));

  return {
    sizeBytes,
    xidAge,
    xidLevel:
      xidAge === undefined ? "ok" : xidAge >= XID_AGE_ERROR ? "error" : xidAge >= XID_AGE_WARNING ? "warning" : "ok",
    sessions,
    totalSessions: sessions.reduce((sum, entry) => sum + entry.count, 0),
  };
}

export function sessionsWords(reading: DatabaseReading): string {
  if (reading.totalSessions === 0) return "No user session";
  return reading.sessions.map((entry) => `${entry.count} ${entry.state}`).join(", ");
}

export interface SlotReading {
  name: string;
  database: string;
  /** True while a subscriber is connected to the slot. */
  active: boolean;
  /** WAL the publisher keeps for the slot, in bytes. */
  retainedBytes?: number;
}

/** The logical replication slots of a database, by name. */
export function logicalSlots(samples: readonly MetricSample[], database: string): SlotReading[] {
  return selectSamples(samples, "cnpg_pg_replication_slots_active", { slot_type: "logical", database })
    .map((sample) => {
      const name = sample.labels.slot_name ?? "";
      return {
        name,
        database,
        active: sample.value === 1,
        retainedBytes: singleValue(samples, "cnpg_pg_replication_slots_pg_wal_lsn_diff", {
          slot_type: "logical",
          database,
          slot_name: name,
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function logicalSlot(samples: readonly MetricSample[], database: string, slot: string): SlotReading | undefined {
  return logicalSlots(samples, database).find((entry) => entry.name === slot);
}
