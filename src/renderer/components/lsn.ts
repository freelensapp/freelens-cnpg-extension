/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// PostgreSQL log sequence numbers are written as `X/Y`, two hexadecimal
// numbers: the high 32 bits and the low 32 bits of a 64 bit position. They
// must be compared numerically (SPEC-0001 A4): "0/F000000" is behind
// "0/10000000" even though it sorts after it as a string.

const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/;

/** Parses an `X/Y` LSN into its 64 bit position, or `undefined` when malformed. */
export function parseLsn(value: string | undefined | null): bigint | undefined {
  if (!value) return undefined;
  const match = LSN_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

/**
 * Compares two LSNs numerically: negative when `a` is behind `b`, zero when
 * equal, positive when ahead. Malformed values sort before valid ones and are
 * equal to each other, so a sort never throws.
 */
export function compareLsn(a: string | undefined | null, b: string | undefined | null): number {
  const left = parseLsn(a);
  const right = parseLsn(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Bytes between two LSNs (`to - from`), or `undefined` when either is malformed. */
export function lsnDistance(from: string | undefined | null, to: string | undefined | null): bigint | undefined {
  const left = parseLsn(from);
  const right = parseLsn(to);
  if (left === undefined || right === undefined) return undefined;
  return right - left;
}
