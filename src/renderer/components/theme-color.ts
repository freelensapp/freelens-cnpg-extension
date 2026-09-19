/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Chart.js needs literal colors, and the extension must not author any
// (DESIGN.md section 5): the values are read from the host's theme variables
// at render time, so both themes and any future palette change are honored.

/** The current value of a theme token such as `--colorOk`, or `fallback` when unavailable. */
export function themeColor(token: string, fallback = "currentColor"): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}
