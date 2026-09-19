/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parseLogLine, parseLogText } from "./log-line";

// Lines recorded from an instance of the E2E cluster (operator 1.30.0, PostgreSQL 18.4), with the
// Kubernetes timestamp in front as the log API writes it; the stack trace is shortened.
const MANAGER =
  '2026-09-19T14:08:59.675586171Z {"level":"info","ts":"2026-09-19T14:08:59.670503072Z","msg":"OS distribution is supported","logger":"instance-manager","logging_pod":"e2e-main-1","entry":{"version":"13 (trixie)"}}';
const NO_LOGGER =
  '2026-09-19T14:09:00.526395117Z {"level":"info","ts":"2026-09-19T14:09:00.52544626Z","msg":"The PID file is stale (executable mismatch), deleting it","file":"/var/lib/postgresql/data/pgdata/postmaster.pid","logging_pod":"e2e-main-1"}';
const POSTGRES =
  '2026-09-19T14:09:27.214607909Z {"level":"info","ts":"2026-09-19T14:09:27.214106819Z","logger":"postgres","msg":"record","logging_pod":"e2e-main-1","record":{"log_time":"2026-09-19 14:09:27.213 UTC","user_name":"app","database_name":"app","process_id":"115","connection_from":"10.244.2.4:39192","command_tag":"START_REPLICATION","error_severity":"LOG","sql_state_code":"00000","message":"starting logical decoding for slot \\"e2e_numbers_sub\\"","detail":"Streaming transactions committing after 0/817B5E10, reading WAL from 0/8161F128.","application_name":"e2e_numbers_sub","backend_type":"walsender","query_id":"0"}}';
const WAL_ARCHIVE =
  '2026-09-19T14:09:22.894436782Z {"level":"error","ts":"2026-09-19T14:09:22.884454102Z","logger":"wal-archive","msg":"Error while calling ArchiveWAL, failing","pluginName":"barman-cloud.cloudnative-pg.io","logging_pod":"e2e-main-1","error":"rpc error: code = Unknown desc = unexpected failure invoking barman-cloud-wal-archive: exit status 4","stacktrace":"github.com/cloudnative-pg/machinery/pkg/log.(*logger).Error\\n"}';
const DATABASE_CONTROLLER =
  '2026-09-19T14:09:00.355621239Z {"level":"info","ts":"2026-09-19T14:09:00.354056947Z","logger":"database-resource","msg":"Defaulting for database","version":"v1","logging_pod":"e2e-main-1","name":"e2e-db-bad-extension","namespace":"cnpg-e2e"}';
const CONTROLDATA =
  '2026-09-19T14:09:00.525102950Z {"level":"info","ts":"2026-09-19T14:09:00.524457987Z","logger":"pg_controldata","msg":"pg_control version number:            1800\\nCatalog version number:               202506291","pipe":"stdout","logging_pod":"e2e-main-1"}';

describe("parseLogLine", () => {
  it("reads a line of the instance manager: source, level, message, the time it happened", () => {
    const line = parseLogLine(MANAGER, "e2e-main-1");
    expect(line).toMatchObject({
      pod: "e2e-main-1",
      source: "Instance manager",
      logger: "instance-manager",
      level: "info",
      message: "OS distribution is supported",
      stamp: "2026-09-19T14:08:59.675586171Z",
      fields: [],
    });
    expect(line.time?.toISOString()).toBe("2026-09-19T14:08:59.670Z");
    expect(line.id).toBe("e2e-main-1/2026-09-19T14:08:59.675586171Z");
    expect(line.raw.startsWith("{")).toBe(true);
  });

  it("takes a line without a logger for the instance manager", () => {
    expect(parseLogLine(NO_LOGGER, "e2e-main-1")).toMatchObject({
      source: "Instance manager",
      message: "The PID file is stale (executable mismatch), deleting it",
    });
  });

  it("reads a PostgreSQL record: the message of the record and who, where, from where", () => {
    const line = parseLogLine(POSTGRES, "e2e-main-1");
    expect(line).toMatchObject({
      source: "PostgreSQL",
      level: "info",
      message: 'starting logical decoding for slot "e2e_numbers_sub"',
    });
    expect(line.fields).toEqual([
      { name: "severity", value: "LOG" },
      { name: "user", value: "app" },
      { name: "database", value: "app" },
      { name: "application", value: "e2e_numbers_sub" },
      { name: "from", value: "10.244.2.4:39192" },
      { name: "detail", value: "Streaming transactions committing after 0/817B5E10, reading WAL from 0/8161F128." },
      { name: "backend", value: "walsender" },
    ]);
  });

  it("takes the level of a PostgreSQL line from its severity, not from the wrapper", () => {
    const at = (severity: string, state = "00000") =>
      parseLogLine(
        `2026-09-19T14:09:27Z {"level":"info","logger":"postgres","msg":"record","record":{"error_severity":"${severity}","sql_state_code":"${state}","message":"m","query":"select 1/0"}}`,
        "pg-1",
      );
    expect(at("ERROR", "22012").level).toBe("error");
    expect(at("FATAL").level).toBe("error");
    expect(at("PANIC").level).toBe("error");
    expect(at("WARNING").level).toBe("warning");
    expect(at("NOTICE").level).toBe("info");
    expect(at("DEBUG2").level).toBe("debug");
    expect(at("ERROR", "22012").fields).toContainEqual({ name: "query", value: "select 1/0" });
    expect(at("ERROR", "22012").fields).toContainEqual({ name: "SQL state", value: "22012" });
    expect(at("LOG").fields.some((field) => field.name === "SQL state")).toBe(false);
  });

  it("reads a WAL archiving failure with its error and its plugin, never the stack trace", () => {
    const line = parseLogLine(WAL_ARCHIVE, "e2e-main-1");
    expect(line).toMatchObject({
      source: "WAL archiving",
      level: "error",
      message: "Error while calling ArchiveWAL, failing",
    });
    expect(line.fields).toEqual([
      {
        name: "error",
        value: "rpc error: code = Unknown desc = unexpected failure invoking barman-cloud-wal-archive: exit status 4",
      },
      { name: "plugin", value: "barman-cloud.cloudnative-pg.io" },
    ]);
  });

  it("files the controllers of the declarative objects and the PostgreSQL tools under their source", () => {
    expect(parseLogLine(DATABASE_CONTROLLER, "e2e-main-1")).toMatchObject({
      source: "Declarative objects",
      fields: [{ name: "object", value: "e2e-db-bad-extension" }],
    });
    const controldata = parseLogLine(CONTROLDATA, "e2e-main-1");
    expect(controldata.source).toBe("PostgreSQL");
    expect(controldata.message).toContain("Catalog version number");
    expect(
      parseLogLine('2026-09-19T14:09:00Z {"level":"warn","logger":"something-new","msg":"x"}', "pg-1"),
    ).toMatchObject({ source: "Other", level: "warning" });
  });

  it("keeps a line that is not JSON, or that is broken JSON, as it is", () => {
    expect(parseLogLine("2026-09-19T14:09:00.1Z plain text from a script", "pg-1")).toMatchObject({
      source: "Other",
      level: "info",
      message: "plain text from a script",
      stamp: "2026-09-19T14:09:00.1Z",
    });
    expect(parseLogLine('2026-09-19T14:09:00.1Z {"level":"info","msg":"cut', "pg-1").message).toBe(
      '{"level":"info","msg":"cut',
    );
    const bare = parseLogLine("no timestamp at all", "pg-1");
    expect(bare).toMatchObject({ message: "no timestamp at all", stamp: undefined, time: undefined });
    expect(bare.id).toBe("pg-1/no timestamp at all");
  });
});

describe("parseLogText", () => {
  it("splits an answer of the log API and skips the empty lines", () => {
    const lines = parseLogText(`${MANAGER}\n\n${POSTGRES}\n`, "e2e-main-1");
    expect(lines.map((line) => line.source)).toEqual(["Instance manager", "PostgreSQL"]);
  });
});
