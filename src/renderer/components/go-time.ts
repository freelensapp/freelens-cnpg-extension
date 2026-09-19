/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// CloudNativePG writes some timestamps with the Go `time.String()` layout,
// `2006-01-02 15:04:05.999999999 -0700 MST` (SPEC-0001 R2, the certificate
// expirations), which `Date.parse` does not accept. Everything else in the
// status is RFC 3339, which `Date.parse` does accept, so the parser tries the
// Go layout first and falls back to the platform parser.

const GO_TIME_LAYOUT =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,9})? ([+-])(\d{2})(\d{2})(?: [A-Za-z][A-Za-z0-9_+-]*| m=[+-]\d+(?:\.\d+)?)*$/;

/**
 * Parses a Go `time.String()` value, or an RFC 3339 value, into a `Date`.
 * Returns `undefined` for anything else, including empty strings.
 */
export function parseGoTime(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;

  const match = GO_TIME_LAYOUT.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes] = match;
    const fields = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    };
    const millis = fraction ? Math.floor(Number.parseFloat(fraction) * 1000) : 0;
    const local = new Date(
      Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second, millis),
    );
    // Date.UTC silently normalizes out of range fields ("2026-13-45" becomes a
    // date in 2027): accept the value only when every field round-trips.
    const roundTrips =
      local.getUTCFullYear() === fields.year &&
      local.getUTCMonth() === fields.month - 1 &&
      local.getUTCDate() === fields.day &&
      local.getUTCHours() === fields.hour &&
      local.getUTCMinutes() === fields.minute &&
      local.getUTCSeconds() === fields.second;
    if (!roundTrips) return undefined;
    const offset = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;
    return new Date(sign === "+" ? local.getTime() - offset : local.getTime() + offset);
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}
