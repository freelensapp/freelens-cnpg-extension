/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configParameters,
  filterHba,
  filterParameters,
  missingParameters,
  parseCustomConf,
  parseHba,
  restartWords,
} from "./pg-config";

// Recorded on the lab from the primary of e2e-main (CloudNativePG 1.30.1): `cat` of the two files.
const CUSTOM = readFileSync(new URL("../../../test/fixtures/e2e-main-custom.conf", import.meta.url), "utf8");
const HBA = readFileSync(new URL("../../../test/fixtures/e2e-main-pg_hba.conf", import.meta.url), "utf8");
// The spec of e2e-main as the operator's webhook left it: its defaults are written into it.
const SPEC: Record<string, string> = {
  archive_mode: "on",
  archive_timeout: "5min",
  wal_keep_size: "512MB",
  wal_level: "logical",
  shared_preload_libraries: "",
};

describe("the PostgreSQL configuration of the primary (SPEC-0035)", () => {
  it("reads every line of custom.conf, quotes and dots included", () => {
    const rows = parseCustomConf(CUSTOM);
    expect(rows).toHaveLength(38);
    expect(rows[0]).toEqual({ name: "allow_alter_system", value: "off" });
    expect(rows.find((row) => row.name === "synchronous_standby_names")?.value).toBe(
      'ANY 1 ("e2e-main-2","e2e-main-3","e2e-main-1")',
    );
    expect(rows.at(-1)?.name).toBe("cnpg.config_sha256");
    expect(parseCustomConf("a = 'it''s'\nb = 3\n# c = 4\n")).toEqual([
      { name: "a", value: "it's" },
      { name: "b", value: "3" },
    ]);
  });

  it("says where each parameter comes from, and a value of the spec not applied yet", () => {
    const rows = configParameters(CUSTOM, { ...SPEC, work_mem: "8MB", archive_timeout: "10min" });
    const origin = (name: string) => rows.find((row) => row.name === name)?.origin;
    expect(origin("port")).toBe("fixed");
    expect(origin("ssl_cert_file")).toBe("fixed");
    expect(origin("allow_alter_system")).toBe("fixed");
    expect(origin("wal_keep_size")).toBe("default");
    expect(origin("cnpg.config_sha256")).toBe("operator");
    expect(origin("max_worker_processes")).toBe("operator");
    expect(rows.find((row) => row.name === "archive_timeout")).toMatchObject({ value: "5min", specValue: "10min" });
    expect(missingParameters(CUSTOM, { ...SPEC, work_mem: "8MB" })).toEqual(["work_mem"]);
    expect(configParameters("work_mem = '8MB'\n", { work_mem: "8MB" })[0].origin).toBe("spec");
  });

  it("reads the HBA rules into rows, with the section the operator wrote each in", () => {
    const rules = parseHba(HBA);
    expect(rules.map((rule) => [rule.section, rule.type, rule.user, rule.method])).toEqual([
      ["fixed", "local", "cnpg_metrics_exporter", "peer"],
      ["fixed", "local", "all", "peer"],
      ["fixed", "hostssl", "streaming_replica", "cert"],
      ["fixed", "hostssl", "streaming_replica", "cert"],
      ["fixed", "hostssl", "cnpg_pooler_pgbouncer", "cert"],
      ["default", "host", "all", "scram-sha-256"],
    ]);
    expect(rules[0]).toMatchObject({ database: "all", options: "map=cnpg_metrics_exporter" });
    expect(rules[0].address).toBeUndefined();
    expect(rules[2]).toMatchObject({ database: "postgres", address: "all", options: "map=cnpg_streaming_replica" });
    const user = parseHba("# USER-DEFINED RULES\nhostssl app app 10.0.0.0/8 scram-sha-256\n");
    expect(user[0]).toMatchObject({ section: "user", address: "10.0.0.0/8", method: "scram-sha-256" });
  });

  it("searches both tabs, and says the pending restart of an instance in words", () => {
    expect(filterParameters(configParameters(CUSTOM, SPEC), "wal_").map((row) => row.name)).toContain("wal_level");
    expect(filterParameters(configParameters(CUSTOM, SPEC), "fixed by").length).toBeGreaterThan(5);
    expect(filterHba(parseHba(HBA), "pooler")).toHaveLength(1);
    expect(restartWords({ name: "x", pendingRestart: false, pendingRestartForDecrease: false })).toBe(
      "configuration loaded, no restart pending",
    );
    expect(restartWords({ name: "x", pendingRestart: true, pendingRestartForDecrease: false })).toBe(
      "restart pending: a changed parameter needs a restart",
    );
    expect(restartWords({ name: "x", pendingRestart: false, pendingRestartForDecrease: false, answered: false })).toBe(
      "not answering: it may be restarting",
    );
    expect(restartWords({ name: "x", pendingRestart: true, pendingRestartForDecrease: true })).toContain(
      "the primary restarts first",
    );
  });
});
