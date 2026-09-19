/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// How the live view writes its figures: humanized for the eye, exact in the
// tooltip (DESIGN.md section 12, "Numbers are exact somewhere").

import { humanizeDuration } from "../backup-health";

/** A replication lag: milliseconds below a second, then the two-unit duration. */
export function formatLag(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "N/A";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return humanizeDuration(milliseconds);
}

/** 1234567 as "1,234,567". */
export function formatCount(value: number | undefined): string {
  return value === undefined ? "N/A" : Math.round(value).toLocaleString("en-US");
}
