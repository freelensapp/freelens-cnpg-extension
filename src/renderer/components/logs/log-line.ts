/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One line of an instance's log as a row (SPEC-0018). CloudNativePG writes one
// JSON object per line: who said it (`logger`), how serious it is (`level`),
// the message, and for PostgreSQL the whole CSV log record under `record`.
// The Kubernetes log API puts its own timestamp in front when asked to. A line
// that is not JSON is kept as it is: a log view never drops a line.

export type LogSource =
  | "PostgreSQL"
  | "Instance manager"
  | "WAL archiving"
  | "Backup"
  | "Plugin"
  | "Declarative objects"
  | "Other";

export type LogLevel = "error" | "warning" | "info" | "debug";

export interface LogField {
  name: string;
  value: string;
}

export interface LogLine {
  /** Unique within a pod: the Kubernetes timestamp, which has nanoseconds. */
  id: string;
  time?: Date;
  /** The raw timestamp, kept to ask the API for what comes after it. */
  stamp?: string;
  pod: string;
  source: LogSource;
  /** The `logger` as written, for the tooltip. */
  logger?: string;
  level: LogLevel;
  message: string;
  fields: LogField[];
  raw: string;
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\s(.*)$/s;

const SOURCE_BY_LOGGER: Record<string, LogSource> = {
  postgres: "PostgreSQL",
  pg_controldata: "PostgreSQL",
  pg_ctl: "PostgreSQL",
  initdb: "PostgreSQL",
  pg_rewind: "PostgreSQL",
  pg_basebackup: "PostgreSQL",
  pg_upgrade: "PostgreSQL",
  "instance-manager": "Instance manager",
  "wal-archive": "WAL archiving",
  "wal-restore": "WAL archiving",
  barman: "Backup",
  "barman-cloud-backup": "Backup",
  "barman-cloud-wal-archive": "WAL archiving",
  "barman-cloud-wal-restore": "WAL archiving",
  backup: "Backup",
};

function sourceOf(logger: string | undefined, entry: Record<string, unknown>): LogSource {
  if (!logger) return "Instance manager";
  const known = SOURCE_BY_LOGGER[logger];
  if (known) return known;
  // The controllers of the declarative objects run in the instance manager
  // and log as `<kind>-resource` or with a `controllerKind`.
  if (logger.endsWith("-resource") || typeof entry.controllerKind === "string") return "Declarative objects";
  if (logger.includes("plugin") || typeof entry.pluginName === "string") return "Plugin";
  return "Other";
}

const ERROR_SEVERITIES = ["PANIC", "FATAL", "ERROR"];
const DEBUG_SEVERITIES = ["DEBUG", "DEBUG1", "DEBUG2", "DEBUG3", "DEBUG4", "DEBUG5"];

function levelOf(level: unknown, severity: unknown): LogLevel {
  if (typeof severity === "string" && severity) {
    const upper = severity.toUpperCase();
    if (ERROR_SEVERITIES.includes(upper)) return "error";
    if (upper === "WARNING") return "warning";
    if (DEBUG_SEVERITIES.includes(upper)) return "debug";
    return "info";
  }
  switch (String(level ?? "").toLowerCase()) {
    case "error":
    case "fatal":
    case "panic":
    case "dpanic":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "info";
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** The few fields worth a second line, in reading order; never the stack trace. */
function fieldsOf(entry: Record<string, unknown>, record: Record<string, unknown> | undefined): LogField[] {
  const candidates: [string, unknown][] = record
    ? [
        ["severity", record.error_severity],
        ["user", record.user_name],
        ["database", record.database_name],
        ["application", record.application_name],
        ["from", record.connection_from],
        ["detail", record.detail],
        ["hint", record.hint],
        ["query", record.query],
        ["SQL state", record.sql_state_code === "00000" ? undefined : record.sql_state_code],
        ["backend", record.backend_type],
      ]
    : [
        ["error", entry.error ?? entry.err],
        ["plugin", entry.pluginName],
        ["object", entry.name],
        ["reason", entry.reason],
      ];
  const fields: LogField[] = [];
  for (const [name, value] of candidates) {
    const shown = text(value);
    if (shown) fields.push({ name, value: shown });
  }
  return fields;
}

export function parseLogLine(rawLine: string, pod: string): LogLine {
  const raw = rawLine.replace(/\r?\n$/, "");
  const stamped = STAMP.exec(raw);
  const stamp = stamped?.[1];
  const body = stamped ? stamped[2] : raw;
  const stampTime = stamp ? new Date(stamp) : undefined;
  const time = stampTime && !Number.isNaN(stampTime.getTime()) ? stampTime : undefined;
  const base = { id: `${pod}/${stamp ?? raw}`, time, stamp, pod, raw: body };

  let entry: Record<string, unknown> | undefined;
  if (body.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entry = parsed as Record<string, unknown>;
    } catch {
      // Not JSON after all: kept as it is, below.
    }
  }
  if (!entry) {
    return { ...base, source: "Other", level: "info", message: body, fields: [] };
  }

  const record =
    entry.record && typeof entry.record === "object" ? (entry.record as Record<string, unknown>) : undefined;
  const logger = text(entry.logger);
  const own = text(entry.ts);
  const ownTime = own ? new Date(own) : undefined;
  return {
    ...base,
    // The instance manager's own time is when it happened; the Kubernetes one is when it was written.
    time: ownTime && !Number.isNaN(ownTime.getTime()) ? ownTime : time,
    source: sourceOf(logger, entry),
    logger,
    level: levelOf(entry.level, record?.error_severity),
    message: text(record?.message) ?? text(entry.msg) ?? body,
    fields: fieldsOf(entry, record),
  };
}

/** The lines of one answer of the log API. */
export function parseLogText(body: string, pod: string): LogLine[] {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parseLogLine(line, pod));
}
