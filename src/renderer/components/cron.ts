/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The schedule of a `ScheduledBackup` as the operator reads it (SPEC-0026):
// six cron fields, seconds first, with the grammar of the parser the operator
// uses (`*`, `?`, lists, ranges, steps, names of months and days, the
// descriptors `@hourly` to `@yearly` and `@every <duration>`), the next runs
// an expression produces, and the presets the form builds an expression from.
// Pure, in UTC: the operator evaluates the schedule with the clock of its own
// pod, which is UTC unless somebody configured a time zone.

import { parseGoDuration } from "./cron-text";

export interface CronFieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: "seconds", min: 0, max: 59 },
  { name: "minutes", min: 0, max: 59 },
  { name: "hours", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day of week", min: 0, max: 6, names: DAYS },
];

/** The descriptors the operator's parser accepts, as the six fields they stand for. */
export const CRON_DESCRIPTORS: Record<string, string> = {
  "@yearly": "0 0 0 1 1 *",
  "@annually": "0 0 0 1 1 *",
  "@monthly": "0 0 0 1 * *",
  "@weekly": "0 0 0 * * 0",
  "@daily": "0 0 0 * * *",
  "@midnight": "0 0 0 * * *",
  "@hourly": "0 0 * * * *",
};

/** One parsed field: the values it matches, and whether it was a star (the day rule of the parser depends on it). */
export interface CronField {
  values: Set<number>;
  star: boolean;
}

export type CronSchedule =
  | { kind: "fields"; fields: CronField[]; expression: string }
  | { kind: "every"; seconds: number; expression: string };

function parseValue(text: string, spec: CronFieldSpec): number | undefined {
  const named = spec.names?.[text.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(text)) return undefined;
  return Number(text);
}

function parseRange(text: string, spec: CronFieldSpec): CronField | string {
  const [rangeText, stepText, ...rest] = text.split("/");
  if (rest.length > 0 || stepText === "") return `${spec.name}: too many slashes in ${text}`;
  let start: number;
  let end: number;
  let star = false;
  if (rangeText === "*" || rangeText === "?") {
    start = spec.min;
    end = spec.max;
    star = true;
  } else {
    const [lowText, highText, ...more] = rangeText.split("-");
    if (more.length > 0 || highText === "") return `${spec.name}: too many hyphens in ${text}`;
    const low = parseValue(lowText, spec);
    if (low === undefined) return `${spec.name}: ${lowText} is not a number or a name`;
    start = low;
    if (highText === undefined) {
      end = stepText === undefined ? low : spec.max;
    } else {
      const high = parseValue(highText, spec);
      if (high === undefined) return `${spec.name}: ${highText} is not a number or a name`;
      end = high;
    }
  }
  let step = 1;
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText) || Number(stepText) === 0)
      return `${spec.name}: the step ${stepText} is not a positive number`;
    step = Number(stepText);
  }
  if (start < spec.min || start > spec.max) return `${spec.name}: ${start} is out of range ${spec.min}-${spec.max}`;
  if (end < spec.min || end > spec.max) return `${spec.name}: ${end} is out of range ${spec.min}-${spec.max}`;
  if (start > end) return `${spec.name}: the beginning of the range ${start} is beyond its end ${end}`;
  const values = new Set<number>();
  for (let value = start; value <= end; value += step) values.add(value);
  return { values, star };
}

function parseField(text: string, spec: CronFieldSpec): CronField | string {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    if (part === "") return `${spec.name}: an empty entry in ${text}`;
    const range = parseRange(part, spec);
    if (typeof range === "string") return range;
    for (const value of range.values) values.add(value);
    star ||= range.star;
  }
  return { values, star };
}

export const FIVE_FIELDS_REASON =
  "The operator reads five fields seconds first, with the day of week left out, never the Kubernetes way: give six fields, seconds first (0 0 3 * * * runs every day at 03:00:00)";

/** The schedule as the operator's parser reads it, or the sentence of the field that is wrong. */
export function parseCron(expression: string): CronSchedule | string {
  const text = expression.trim().replace(/\s+/g, " ");
  if (text === "") return "A schedule is required";
  if (text.startsWith("@")) {
    if (text.startsWith("@every ")) {
      const duration = text.slice("@every ".length);
      const milliseconds = parseGoDuration(duration);
      if (milliseconds === undefined) return `@every wants a duration such as 1h30m, not ${duration}`;
      // The operator's parser truncates the interval to whole seconds, one at least.
      return { kind: "every", seconds: Math.max(1, Math.floor(milliseconds / 1000)), expression: text };
    }
    const expanded = CRON_DESCRIPTORS[text];
    if (!expanded)
      return `${text} is not a descriptor the operator knows (@hourly, @daily, @weekly, @monthly, @yearly, @every)`;
    const parsed = parseCron(expanded);
    return typeof parsed === "string" ? parsed : { ...parsed, expression: text };
  }
  const parts = text.split(" ");
  if (parts.length === 5) return FIVE_FIELDS_REASON;
  if (parts.length !== 6) {
    return `A schedule has six fields, seconds first: seconds minutes hours day-of-month month day-of-week (found ${parts.length})`;
  }
  const fields: CronField[] = [];
  for (const [index, part] of parts.entries()) {
    const field = parseField(part, CRON_FIELDS[index]);
    if (typeof field === "string") return field;
    fields.push(field);
  }
  return { kind: "fields", fields, expression: text };
}

/** Why the expression is refused, or undefined when the operator would accept it. */
export function cronError(expression: string): string | undefined {
  const parsed = parseCron(expression);
  return typeof parsed === "string" ? parsed : undefined;
}

function dayMatches(fields: CronField[], date: Date): boolean {
  const dom = fields[3];
  const dow = fields[5];
  const domMatch = dom.values.has(date.getUTCDate());
  const dowMatch = dow.values.has(date.getUTCDay());
  // The rule of the operator's parser: when either day field is a star, both must match; else either may.
  if (dom.star || dow.star) return domMatch && dowMatch;
  return domMatch || dowMatch;
}

const FIVE_YEARS_MS = 5 * 366 * 24 * 3600 * 1000;

/** The next time the schedule fires after `from`, or undefined when it never does within five years (the parser's own horizon). */
export function nextRun(schedule: CronSchedule, from: Date): Date | undefined {
  if (schedule.kind === "every") {
    return new Date(from.getTime() + schedule.seconds * 1000);
  }
  const [seconds, minutes, hours, , months] = schedule.fields;
  const limit = from.getTime() + FIVE_YEARS_MS;
  let t = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
  while (t.getTime() <= limit) {
    if (!months.values.has(t.getUTCMonth() + 1)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1, 0, 0, 0));
      continue;
    }
    if (!dayMatches(schedule.fields, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 0, 0, 0));
      continue;
    }
    if (!hours.values.has(t.getUTCHours())) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1, 0, 0));
      continue;
    }
    if (!minutes.values.has(t.getUTCMinutes())) {
      t = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes() + 1, 0),
      );
      continue;
    }
    if (!seconds.values.has(t.getUTCSeconds())) {
      t = new Date(t.getTime() + 1000);
      continue;
    }
    return t;
  }
  return undefined;
}

/** The next `count` runs after `from`. */
export function nextRuns(expression: string, from: Date, count = 3): Date[] {
  const schedule = parseCron(expression);
  if (typeof schedule === "string") return [];
  const runs: Date[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const next = nextRun(schedule, cursor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/** The seconds between the first two runs, for the warning about a schedule that runs too often. */
export function runInterval(expression: string, from: Date): number | undefined {
  const [first, second] = nextRuns(expression, from, 2);
  return first && second ? (second.getTime() - first.getTime()) / 1000 : undefined;
}

export type CronPreset = "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface CronPresetValues {
  preset: CronPreset;
  /** Minute of the hour for hourly, of the time for the others. */
  minute: string;
  hour: string;
  /** 0 (Sunday) to 6, for weekly. */
  weekday: string;
  /** 1 to 31, for monthly. */
  monthDay: string;
  /** The expression as typed, for custom. */
  custom: string;
}

export function defaultCronPresetValues(): CronPresetValues {
  return { preset: "daily", minute: "0", hour: "3", weekday: "0", monthDay: "1", custom: "0 0 3 * * *" };
}

/** The six field expression a preset stands for; `custom` is the expression as typed. */
export function cronFromPreset(values: CronPresetValues): string {
  const minute = values.minute.trim() || "0";
  const hour = values.hour.trim() || "0";
  switch (values.preset) {
    case "hourly":
      return `0 ${minute} * * * *`;
    case "daily":
      return `0 ${minute} ${hour} * * *`;
    case "weekly":
      return `0 ${minute} ${hour} * * ${values.weekday.trim() || "0"}`;
    case "monthly":
      return `0 ${minute} ${hour} ${values.monthDay.trim() || "1"} * *`;
    default:
      return values.custom.trim().replace(/\s+/g, " ");
  }
}

/** Why the numbers of a preset are wrong, by field, before they are put into an expression. */
export function cronPresetErrors(
  values: CronPresetValues,
): Partial<Record<"minute" | "hour" | "weekday" | "monthDay" | "custom", string>> {
  const errors: Partial<Record<"minute" | "hour" | "weekday" | "monthDay" | "custom", string>> = {};
  const check = (key: "minute" | "hour" | "weekday" | "monthDay", what: string, min: number, max: number) => {
    const text = values[key].trim();
    if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max)
      errors[key] = `${what} is a number from ${min} to ${max}`;
  };
  if (values.preset === "custom") {
    const error = cronError(values.custom);
    if (error) errors.custom = error;
    return errors;
  }
  check("minute", "The minute", 0, 59);
  if (values.preset !== "hourly") check("hour", "The hour", 0, 23);
  if (values.preset === "weekly") check("weekday", "The day of the week", 0, 6);
  if (values.preset === "monthly") check("monthDay", "The day of the month", 1, 31);
  return errors;
}

export const WEEKDAY_NAMES: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** A run as the form prints it: `2026-09-23 03:00:00 UTC`. */
export function formatRun(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
