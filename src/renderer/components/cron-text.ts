/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// A `ScheduledBackup` schedule in words (SPEC-0005 "Classifiers"). The operator
// reads `spec.schedule` with a seconds-first cron parser whose day of week is
// optional and which accepts descriptors (`@daily`, `@every 1h30m`); this
// module follows those semantics and hides the package that writes the words,
// so the views depend on `describeSchedule` alone. The words are an aid: the
// views always show the raw expression too, and anything this module cannot
// describe gives `undefined`, never a guess.

import cronstrue from "cronstrue";

/**
 * The operator evaluates the schedule with its own clock, which in a container
 * is UTC unless somebody configured a time zone, while the views show dates in
 * the user's time zone: the words always travel with this note.
 */
export const SCHEDULE_TIME_ZONE_NOTE = "in the operator's time zone, normally UTC";

const DESCRIPTORS: Record<string, string> = {
  "@yearly": "Every year, on 1 January at 00:00",
  "@annually": "Every year, on 1 January at 00:00",
  "@monthly": "Every month, on day 1 at 00:00",
  "@weekly": "Every week, on Sunday at 00:00",
  "@daily": "Every day at 00:00",
  "@midnight": "Every day at 00:00",
  "@hourly": "Every hour, at minute 0",
};

const EVERY_PREFIX = "@every ";

const DURATION_UNITS_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000001,
};

const DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

/** A Go duration string (`1h30m`, `90s`) in milliseconds, or `undefined` when malformed. */
export function parseGoDuration(value: string): number | undefined {
  const text = value.trim();
  if (!DURATION_PATTERN.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(DURATION_PART)) {
    total += Number.parseFloat(amount) * DURATION_UNITS_MS[unit];
  }
  return total;
}

function plural(amount: number, unit: string): string {
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function describeEvery(duration: string): string | undefined {
  const milliseconds = parseGoDuration(duration);
  if (milliseconds === undefined || milliseconds <= 0) return undefined;
  // The operator's parser truncates the interval to whole seconds, one at least.
  const total = Math.max(1, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [
    hours > 0 ? plural(hours, "hour") : "",
    minutes > 0 ? plural(minutes, "minute") : "",
    seconds > 0 ? plural(seconds, "second") : "",
  ].filter(Boolean);
  return `Every ${parts.join(" ")}`;
}

/**
 * The schedule in words, or `undefined` when it cannot be described. A five
 * field expression is read the way the operator reads it: seconds first, with
 * the day of week left out (every day of the week).
 */
export function describeSchedule(expression: string | undefined | null): string | undefined {
  const text = expression?.trim();
  if (!text) return undefined;

  if (text.startsWith("@")) {
    if (text.startsWith(EVERY_PREFIX)) return describeEvery(text.slice(EVERY_PREFIX.length));
    return DESCRIPTORS[text];
  }

  const fields = text.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return undefined;
  const sixFields = fields.length === 5 ? [...fields, "*"] : fields;
  try {
    return cronstrue.toString(sixFields.join(" "), {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
      verbose: false,
    });
  } catch {
    return undefined;
  }
}
