/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { isReportPath, reportRefusal, saveReport } from "./report-save";

import type { SaveDialog } from "./report-save";

const REQUEST = {
  suggestedName: "e2e-main-cnpg-e2e-20261102-103014.zip",
  title: "Save the diagnostic report of cnpg-e2e/e2e-main",
  files: [
    { path: "README.txt", content: "readme" },
    { path: "cluster.yaml", content: "kind: Cluster" },
  ],
};

function dialog(answer: { canceled: boolean; filePath?: string }) {
  const asked: unknown[] = [];
  const fake: SaveDialog = {
    showSaveDialog: async (options) => {
      asked.push(options);
      return answer;
    },
  };
  return { asked, fake };
}

describe("the save of the diagnostic report (SPEC-0038)", () => {
  it("asks where to save with the suggested name, and writes the archive there only", async () => {
    const { asked, fake } = dialog({ canceled: false, filePath: "/home/u/report.zip" });
    const written: Array<[string, number]> = [];
    const answer = await saveReport(REQUEST, fake, async (file, content) => {
      written.push([file, content.readUInt32LE(0)]);
    });
    expect(answer).toEqual({ path: "/home/u/report.zip" });
    expect(written).toEqual([["/home/u/report.zip", 0x04034b50]]);
    expect(asked).toEqual([
      {
        title: REQUEST.title,
        message: REQUEST.title,
        defaultPath: REQUEST.suggestedName,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      },
    ]);
  });

  it("writes nothing when the dialog is closed, and says why a write failed", async () => {
    const written: string[] = [];
    expect(
      await saveReport(REQUEST, dialog({ canceled: true }).fake, async (file) => {
        written.push(file);
      }),
    ).toEqual({ canceled: true });
    expect(written).toEqual([]);
    expect(
      await saveReport(REQUEST, dialog({ canceled: false, filePath: "/ro/x.zip" }).fake, async () => {
        throw Object.assign(new Error("no"), { code: "EACCES" });
      }),
    ).toEqual({ error: "The file could not be written: EACCES" });
  });

  it("refuses names and paths that could leave the archive, and reports too large", async () => {
    expect(isReportPath("pods/e2e-main-1.yaml")).toBe(true);
    for (const path of ["../x", "/etc/passwd", "a//b", "a/../b", ".hidden", "a b"])
      expect(isReportPath(path)).toBe(false);
    expect(reportRefusal({ ...REQUEST, suggestedName: "../x.zip" })).toBe("Not a name for a report");
    expect(reportRefusal({ ...REQUEST, files: [] })).toBe("The report is empty");
    expect(reportRefusal({ ...REQUEST, files: [...REQUEST.files, REQUEST.files[0]] })).toBe(
      "README.txt is in the report twice",
    );
    const { asked, fake } = dialog({ canceled: false, filePath: "/x.zip" });
    expect(await saveReport({ ...REQUEST, files: [{ path: "../evil", content: "" }] }, fake)).toEqual({
      error: "Not a file of a report",
    });
    expect(asked).toEqual([]);
  });
});
