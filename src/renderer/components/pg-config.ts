/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The PostgreSQL configuration page of SPEC-0035: `custom.conf` and
// `pg_hba.conf` as the operator wrote them on the primary, read into rows, and
// where each parameter comes from. Pure.

import { FIXED_POSTGRES_PARAMETERS, OPERATOR_WRITTEN_PARAMETERS } from "./create-forms";

export type ParameterOrigin = "spec" | "default" | "fixed" | "operator";

export const ORIGIN_WORDS: Record<ParameterOrigin, string> = {
  spec: "set in the spec",
  default: "the operator's default, written into the spec",
  fixed: "fixed by the operator",
  operator: "written by the operator from other settings",
};

export interface ConfigParameter {
  name: string;
  value: string;
  origin: ParameterOrigin;
  /** The value the spec asks for, when it differs from the file: a change not applied yet. */
  specValue?: string;
}

// `name = 'value'`, the form the instance manager writes; '' is a quote inside the value.
const LINE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(?:'((?:[^']|'')*)'|(\S*))\s*(?:#.*)?$/;

export function parseCustomConf(text: string): Array<{ name: string; value: string }> {
  return text.split("\n").flatMap((line) => {
    const match = LINE.exec(line);
    if (!match) return [];
    return [{ name: match[1], value: match[2] !== undefined ? match[2].replaceAll("''", "'") : (match[3] ?? "") }];
  });
}

function originOf(name: string, spec: Readonly<Record<string, string>>): ParameterOrigin {
  if (FIXED_POSTGRES_PARAMETERS.includes(name) || name.startsWith("ssl") || name === "allow_alter_system") {
    return "fixed";
  }
  if (name in spec) return OPERATOR_WRITTEN_PARAMETERS.includes(name) ? "default" : "spec";
  return "operator";
}

/** The rows of the Configuration tab, in the order of the file. */
export function configParameters(text: string, spec: Readonly<Record<string, string>> = {}): ConfigParameter[] {
  return parseCustomConf(text).map(({ name, value }) => {
    const origin = originOf(name, spec);
    const asked = spec[name];
    return {
      name,
      value,
      origin,
      ...(asked !== undefined && asked !== value && origin !== "fixed" ? { specValue: asked } : {}),
    };
  });
}

/** Parameters of the spec the file does not have yet. */
export function missingParameters(text: string, spec: Readonly<Record<string, string>> = {}): string[] {
  const written = new Set(parseCustomConf(text).map((row) => row.name));
  return Object.keys(spec)
    .filter((name) => !written.has(name))
    .sort();
}

export type HbaSection = "fixed" | "user" | "default";

export const HBA_SECTION_WORDS: Record<HbaSection, string> = {
  fixed: "the operator's own",
  user: "from spec.postgresql.pg_hba",
  default: "the operator's default",
};

export interface HbaRule {
  line: number;
  section: HbaSection;
  type: string;
  database: string;
  user: string;
  address?: string;
  method: string;
  options?: string;
  raw: string;
}

const SECTION_HEADERS: Array<[RegExp, HbaSection]> = [
  [/^#\s*FIXED RULES\s*$/, "fixed"],
  [/^#\s*USER-DEFINED RULES\s*$/, "user"],
  [/^#\s*DEFAULT RULES\s*$/, "default"],
];

/** One row per rule, in order, with the section of the file it is in (the operator writes three). */
export function parseHba(text: string): HbaRule[] {
  let section: HbaSection = "user";
  const rules: HbaRule[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const header = SECTION_HEADERS.find(([pattern]) => pattern.test(line));
    if (header) {
      section = header[1];
      return;
    }
    if (line === "" || line.startsWith("#")) return;
    const fields = line.split(/\s+/);
    const local = fields[0] === "local";
    const methodAt = local ? 3 : 4;
    rules.push({
      line: index + 1,
      section,
      type: fields[0],
      database: fields[1] ?? "",
      user: fields[2] ?? "",
      ...(local ? {} : { address: fields[3] ?? "" }),
      method: fields[methodAt] ?? "",
      ...(fields.length > methodAt + 1 ? { options: fields.slice(methodAt + 1).join(" ") } : {}),
      raw: line,
    });
  });
  return rules;
}

export interface InstanceRestart {
  name: string;
  pendingRestart: boolean;
  pendingRestartForDecrease: boolean;
  /** False when its instance manager did not answer: it may be restarting. */
  answered?: boolean;
}

/** The words of the strip of an instance. */
export function restartWords(instance: InstanceRestart): string {
  if (instance.answered === false) return "not answering: it may be restarting";
  if (instance.pendingRestartForDecrease) {
    return "restart pending: a value went down, the primary restarts first and the replicas follow";
  }
  if (instance.pendingRestart) return "restart pending: a changed parameter needs a restart";
  return "configuration loaded, no restart pending";
}

/** Rows whose name, value or origin words contain the search, case insensitive. */
export function filterParameters(rows: readonly ConfigParameter[], search: string): ConfigParameter[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.name, row.value, ORIGIN_WORDS[row.origin], row.specValue ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}

export function filterHba(rules: readonly HbaRule[], search: string): HbaRule[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rules];
  return rules.filter((rule) => rule.raw.toLowerCase().includes(needle));
}
