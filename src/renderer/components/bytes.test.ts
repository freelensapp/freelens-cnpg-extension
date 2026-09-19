/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { exactBytes, formatBytes } from "./bytes";

describe("formatBytes", () => {
  it("uses binary units with one decimal at most", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(17_209_976n)).toBe("16.4 MiB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GiB");
    expect(formatBytes(5 * 1024 ** 5 * 1024)).toBe("5120 PiB");
  });

  it("refuses what is not a size", () => {
    expect(formatBytes(-1)).toBe("N/A");
    expect(formatBytes(Number.NaN)).toBe("N/A");
  });
});

describe("exactBytes", () => {
  it("groups the thousands", () => {
    expect(exactBytes(17_209_976n)).toBe("17,209,976 bytes");
    expect(exactBytes(12)).toBe("12 bytes");
  });
});
