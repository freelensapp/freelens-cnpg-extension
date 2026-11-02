/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Steps the scenarios share: waiting for what fills in, the name cell of a
// row, scrolling to an element a re-render may replace, and the dock terminal.
// Its name does not match `*.tests.ts`, so Vitest does not collect it as a
// test file.

import type { Frame, Locator } from "playwright";

/** The name cell of a list row: clicking it opens the drawer without hitting a link in another cell. */
export function tableRowName(frame: Frame, name: string) {
  return frame.locator(".TableRow", { hasText: name }).first().locator(".TableCell", { hasText: name }).first();
}

/** Reads a value until it satisfies the predicate: the live view fills in as the instances answer. */
export async function waitUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();

  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await read();
  }

  return value;
}

/**
 * Scrolls to an element that a re-render may replace under the call: the drawers redraw their lists when a
 * watch event lands, and `scrollIntoViewIfNeeded` gives up on a node that detached instead of resolving the
 * locator again. Each attempt resolves it afresh.
 */
export async function scrollIntoView(locator: Locator, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded();
      return;
    } catch (error) {
      if (attempt >= attempts || !/not attached|detached|not stable/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** The visible text of the dock terminal, whitespace dropped: xterm's DOM renderer splits and pads the rows. */
export async function terminalText(frame: Frame): Promise<string> {
  const rows = frame.locator(".xterm-rows:visible").last();

  return ((await rows.innerText().catch(() => "")) ?? "").replace(/\s+/g, "");
}

/**
 * Types a line into the dock terminal: xterm keeps the keyboard in a hidden
 * textarea, so the screen is clicked first. On a slow runner the first key
 * after the click was seen to get lost ("elect" for "select"): the focus gets
 * a moment to settle, the keys go one at a time, and the line starts with a
 * space, which both psql and the shell ignore, so a lost first key costs nothing.
 */
export async function typeInTerminal(frame: Frame, line: string): Promise<void> {
  await frame.locator(".xterm-screen:visible").last().click();
  await frame.waitForTimeout(500);
  await frame.page().keyboard.type(` ${line}`, { delay: 20 });
  await frame.page().keyboard.press("Enter");
}

/** Closes the dock tabs whose title starts with the given text, so they do not cover the views that follow. */
export async function closeDockTabs(frame: Frame, title: string): Promise<void> {
  const tabs = frame.locator(".Dock .Tab", { hasText: title });

  for (let guard = 0; guard < 10 && (await tabs.count()) > 0; guard += 1) {
    const tab = tabs.first();

    await tab.hover();
    await tab.locator(".Icon").last().click();
    await frame.waitForTimeout(500);
  }
}
