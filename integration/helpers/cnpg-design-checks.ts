/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The rules of docs/development/DESIGN.md that a machine can check on the
// rendered DOM, and the domain correctness comparisons of TESTING.md. Shared
// by the pre-review pass (SPEC-0008), which runs all of them on every view,
// and by the E2E suite, where the codified ones live on as non-regression
// cases. Every function throws with what it expected and what it found.

import type { Frame } from "playwright";

/**
 * The header texts of the list on screen, without the checkbox and the menu
 * cells. The host draws the sort arrow as an icon font ligature, which is text
 * to the DOM ("arrow_drop_down"): the icons are left out.
 */
export async function listHeaders(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".TableHead .TableCell"))
      .filter((cell) => !cell.closest(".Drawer"))
      .map((cell) => {
        const copy = cell.cloneNode(true) as Element;

        for (const icon of Array.from(copy.querySelectorAll(".Icon"))) icon.remove();

        return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
      })
      .filter((text) => text.length > 0),
  );
}

/**
 * DESIGN.md section 1: `Name | Namespace | <domain columns> | Condition | Status | Age`.
 * A cluster scoped kind has no Namespace column, as in the host's own lists.
 */
export async function expectColumnGrammar(
  frame: Frame,
  page: string,
  { namespaced = true }: { namespaced?: boolean } = {},
): Promise<void> {
  const headers = await listHeaders(frame);
  const tail = headers.slice(-3);
  const headOk = headers[0] === "Name" && (namespaced ? headers[1] === "Namespace" : headers[1] !== "Namespace");

  if (!headOk || tail.join("|") !== "Condition|Status|Age") {
    throw new Error(
      `${page}: the columns should read Name, ${namespaced ? "Namespace, " : ""}..., Condition, Status, Age; got ${headers.join(", ")}`,
    );
  }

  if (headers.length < (namespaced ? 6 : 5)) {
    throw new Error(`${page}: a list without domain columns is a kubectl get, got ${headers.join(", ")}`);
  }
}

/** DESIGN.md section 1: a missing value reads "N/A", never an empty cell. */
export async function expectNoEmptyCells(frame: Frame, page: string): Promise<void> {
  const empty = await frame.evaluate(() => {
    const found: string[] = [];

    for (const row of Array.from(document.querySelectorAll(".TableRow:not(.TableHead)"))) {
      // Only the rows of a list page: nested tables inside a drawer are checked where they are asserted.
      if (row.closest(".Drawer")) continue;

      const cells = Array.from(row.querySelectorAll(":scope > .TableCell"));

      cells.forEach((cell, index) => {
        if (cell.classList.contains("checkbox") || cell.classList.contains("menu")) return;
        // A cell that draws something (a badge, bricks, an icon) is not empty.
        if ((cell.textContent ?? "").trim() === "" && cell.querySelector("*") === null) {
          found.push(`row "${(cells[1]?.textContent ?? "").trim()}", cell ${index}`);
        }
      });
    }

    return found;
  });

  if (empty.length > 0) {
    throw new Error(`${page}: empty cells instead of "N/A": ${empty.join("; ")}`);
  }
}

/** Links cannot nest: a link inside a link is invalid HTML and an ambiguous click. */
export async function expectNoNestedLinks(frame: Frame, where: string): Promise<void> {
  const nested = await frame.locator("a a").count();

  if (nested > 0) {
    throw new Error(`${where}: ${nested} link(s) nested inside a link`);
  }
}

/**
 * DESIGN.md section 5: no authored color. Inside the extension's own subtrees
 * an inline style may carry positions and sizes, never a color of its own.
 * Values that author nothing (`inherit`, `currentColor`, `transparent`, a theme
 * token through `var()`) are fine, and so is whatever a host component writes
 * on its own elements (the host select styles its input inline).
 */
export async function expectNoAuthoredColors(frame: Frame, where: string): Promise<void> {
  const offenders = await frame.evaluate(() => {
    const colorProperties = /^(color|background|background-color|border-color|border|outline-color|fill|stroke)$/i;
    const neutral = /^(inherit|currentcolor|transparent|none|initial|unset|0|var\(.*\))$/i;
    const paints = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
    const found: string[] = [];

    for (const root of Array.from(document.querySelectorAll('[data-testid^="cnpg-"]'))) {
      for (const element of [root, ...Array.from(root.querySelectorAll("[style]"))]) {
        // Host components style their own elements: not ours to answer for. The legend of the host
        // chart paints its bricks with the colors of the datasets, which the trends take from the theme.
        if (element.closest(".Select, .Badge, .Icon, .Tooltip, .LegendBadge")) continue;

        for (const declaration of (element.getAttribute("style") ?? "").split(";")) {
          const separator = declaration.indexOf(":");

          if (separator < 0) continue;

          const property = declaration.slice(0, separator).trim();
          const value = declaration.slice(separator + 1).trim();
          const authored = colorProperties.test(property) ? !neutral.test(value) : paints.test(value);

          if (authored) found.push(`${element.tagName.toLowerCase()} { ${property}: ${value} }`);
        }
      }
    }

    return found;
  });

  if (offenders.length > 0) {
    throw new Error(`${where}: authored colors in inline styles: ${offenders.slice(0, 5).join("; ")}`);
  }
}

/** An LSN `X/Y` as its 64 bit position. */
export function lsnPosition(lsn: string): bigint {
  const match = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/.exec(lsn.trim());

  if (!match) {
    throw new Error(`"${lsn}" is not an LSN`);
  }

  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

/**
 * TESTING.md "Domain correctness checks": what the live view shows for the
 * primary lies between what the instance manager answers before and after the
 * page is read. The write position only grows, so the sandwich holds on an
 * idle cluster and under load alike.
 */
export function expectLsnBetween(shown: string, before: string, after: string): void {
  const position = lsnPosition(shown);

  if (position < lsnPosition(before) || position > lsnPosition(after)) {
    throw new Error(`the live view shows LSN ${shown}, outside of what the instance answered: ${before} then ${after}`);
  }
}
