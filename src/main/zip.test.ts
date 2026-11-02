/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipFiles } from "./zip";

/** Reads an archive back through its central directory, as an unzip tool does. */
function unzip(archive: Buffer): Array<{ path: string; content: string; crc: number }> {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const path = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const content = inflateRawSync(archive.subarray(start, start + packed));
    expect(crc32(content)).toBe(crc);
    entries.push({ path, content: content.toString("utf8"), crc });
    at += 46 + nameLength;
  }
  return entries;
}

describe("the ZIP of the diagnostic report (SPEC-0038)", () => {
  it("computes the CRC-32 of the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes entries an unzip reads back, names in UTF-8, in order", () => {
    const files = [
      { path: "README.txt", content: "What is in this report.\n" },
      { path: "pods/e2e-main-1.yaml", content: "kind: Pod\n".repeat(1000) },
      { path: "notes/àccent.txt", content: "crème" },
    ];
    const archive = zipFiles(files, new Date(2026, 10, 2, 10, 30, 14));
    expect(unzip(archive).map(({ path, content }) => ({ path, content }))).toEqual(files);
    // Deflated: the repeated text takes far less room.
    expect(archive.length).toBeLessThan(2000);
    // MS-DOS date and time: 2026-11-02 10:30:14.
    expect(archive.readUInt16LE(10)).toBe((10 << 11) | (30 << 5) | 7);
    expect(archive.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (11 << 5) | 2);
  });
});
