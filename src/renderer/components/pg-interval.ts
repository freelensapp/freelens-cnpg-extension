/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// PostgreSQL interval strings in the default `postgres` output style, as the
// instance manager reports the replication lags (SPEC-0001 A4):
// "00:00:00.012345", "1 day 02:03:04", "-00:00:01", "2 days", "1 mon 3 days".
// Unparseable gives `undefined`, never zero: a lag that cannot be read must
// not look like no lag.

const UNIT_MS: Record<string, number> = {
  year: 365.25 * 86_400_000,
  mon: 30 * 86_400_000,
  day: 86_400_000,
};

const UNIT_PATTERN = /^(-?\d+)\s+(year|mon|day)s?$/;
const TIME_PATTERN = /^(-)?(\d+):(\d{2}):(\d{2})(\.\d+)?$/;

/** The interval in milliseconds, or `undefined` when empty or malformed. */
export function parsePgInterval(value: string | undefined | null): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  // Tokens come in pairs ("1 day") but for the time part, which stands alone.
  const tokens = text.split(/\s+/);
  let total = 0;
  let seen = false;
  for (let i = 0; i < tokens.length; ) {
    const time = TIME_PATTERN.exec(tokens[i]);
    if (time) {
      const [, sign, hours, minutes, seconds, fraction] = time;
      const ms =
        (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
        (fraction ? Math.round(Number(fraction) * 1000) : 0);
      total += sign ? -ms : ms;
      seen = true;
      i += 1;
      continue;
    }
    const unit = i + 1 < tokens.length ? UNIT_PATTERN.exec(`${tokens[i]} ${tokens[i + 1]}`) : null;
    if (!unit) return undefined;
    total += Number(unit[1]) * UNIT_MS[unit[2]];
    seen = true;
    i += 2;
  }
  return seen ? total : undefined;
}
