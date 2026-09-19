/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePrometheusText } from "../../api/instance/prometheus-text";
import { logicalSlot, logicalSlots, readDatabase, sessionsWords } from "./database-reading";

// As read from the exporter of the primary of the E2E publisher (operator 1.30.0).
const SAMPLES = parsePrometheusText(`
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="cnpg_metrics_exporter"} 1
cnpg_backends_total{application_name="e2e-main-2",datname="",state="active",usename="streaming_replica"} 1
cnpg_backends_total{application_name="e2e_numbers_sub",datname="app",state="active",usename="app"} 1
cnpg_backends_total{application_name="pgbench",datname="app",state="idle",usename="app"} 3
cnpg_backends_total{application_name="psql",datname="app",state="idle",usename="reporting"} 1
cnpg_pg_database_size_bytes{datname="app"} 8.8643263e+07
cnpg_pg_database_size_bytes{datname="inventory"} 8.132287e+06
cnpg_pg_database_xid_age{datname="app"} 63888
cnpg_pg_database_xid_age{datname="inventory"} 1.2e+09
cnpg_pg_replication_slots_active{database="",slot_name="_cnpg_e2e_main_2",slot_type="physical"} 1
cnpg_pg_replication_slots_active{database="app",slot_name="e2e_numbers_sub",slot_type="logical"} 1
cnpg_pg_replication_slots_active{database="app",slot_name="abandoned",slot_type="logical"} 0
cnpg_pg_replication_slots_pg_wal_lsn_diff{database="",slot_name="_cnpg_e2e_main_2",slot_type="physical"} 0
cnpg_pg_replication_slots_pg_wal_lsn_diff{database="app",slot_name="e2e_numbers_sub",slot_type="logical"} 27424
cnpg_pg_replication_slots_pg_wal_lsn_diff{database="app",slot_name="abandoned",slot_type="logical"} 5.36870912e+08
`);

describe("readDatabase", () => {
  it("reads size, transaction ID age and the sessions of users by state", () => {
    const reading = readDatabase(SAMPLES, "app");
    expect(reading).toMatchObject({ sizeBytes: 88643263, xidAge: 63888, xidLevel: "ok", totalSessions: 5 });
    expect(reading?.sessions).toEqual([
      { state: "idle", count: 4 },
      { state: "active", count: 1 },
    ]);
    expect(sessionsWords(reading!)).toBe("4 idle, 1 active");
  });

  it("warns on an old transaction ID age and knows an unused database", () => {
    const reading = readDatabase(SAMPLES, "inventory");
    expect(reading).toMatchObject({ xidLevel: "warning", totalSessions: 0 });
    expect(sessionsWords(reading!)).toBe("No user session");
  });

  it("answers nothing for a database PostgreSQL does not have", () => {
    expect(readDatabase(SAMPLES, "legacy")).toBeUndefined();
  });
});

describe("logical slots", () => {
  it("lists the logical slots of a database, never the physical ones", () => {
    expect(logicalSlots(SAMPLES, "app")).toEqual([
      { name: "abandoned", database: "app", active: false, retainedBytes: 536870912 },
      { name: "e2e_numbers_sub", database: "app", active: true, retainedBytes: 27424 },
    ]);
    expect(logicalSlots(SAMPLES, "")).toEqual([]);
  });

  it("finds one slot by name", () => {
    expect(logicalSlot(SAMPLES, "app", "e2e_numbers_sub")?.active).toBe(true);
    expect(logicalSlot(SAMPLES, "app", "nope")).toBeUndefined();
  });
});
