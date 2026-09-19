/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Byte counts for people: binary units, one decimal at most. The exact figure
// always goes in a tooltip next to the humanized one (DESIGN.md section 12,
// "Numbers are exact somewhere").

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** "512 B", "16.4 MiB", "2 GiB". Accepts the bigint distances of the LSN helpers. */
export function formatBytes(bytes: number | bigint): string {
  let value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "N/A";
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${rounded} ${UNITS[unit]}`;
}

/** "17209976 bytes", with the thousands grouped for reading. */
export function exactBytes(bytes: number | bigint): string {
  return `${BigInt(bytes).toLocaleString("en-US")} bytes`;
}
