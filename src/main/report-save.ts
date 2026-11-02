/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The file of the diagnostic report of SPEC-0038: the one the user chooses in
// the host's save dialog, and no other. The renderer sends the files it
// collected; main checks their names and sizes, asks where to save, zips them
// and writes the archive. Nothing is written when the dialog is closed.
// As freelens-velero-extension saves its artifacts.

import { writeFile } from "node:fs/promises";
import { zipFiles } from "./zip";

import type { ReportSaveAnswer, ReportSaveRequest } from "../common/ipc";

export interface SaveDialog {
  showSaveDialog(options: {
    title: string;
    message: string;
    defaultPath: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

/**
 * Electron's dialog, asked for at each save and never kept: what stands in its place at that moment is what is
 * asked, which is how the E2E answers it. Imported only when a report is saved: the bundle of main is loaded
 * without a host by the tests of the build.
 */
export function hostDialog(): SaveDialog {
  return {
    showSaveDialog: async (options) => {
      const electron = await import("electron");
      const dialog = electron.dialog ?? (electron as unknown as { default: typeof electron }).default.dialog;
      return dialog.showSaveDialog(options);
    },
  };
}

export const REPORT_BOUNDS = { files: 2000, bytes: 256 * 1024 * 1024 } as const;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUGGESTED = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

/** A relative path of the archive: segments of safe characters, no `..`, no absolute path. */
export function isReportPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "..")
  );
}

/** Why the request cannot be saved, or undefined. */
export function reportRefusal(request: ReportSaveRequest): string | undefined {
  if (!request || typeof request.suggestedName !== "string" || !SUGGESTED.test(request.suggestedName)) {
    return "Not a name for a report";
  }
  if (!Array.isArray(request.files) || request.files.length === 0) return "The report is empty";
  if (request.files.length > REPORT_BOUNDS.files) return `More than ${REPORT_BOUNDS.files} files in a report`;
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of request.files) {
    if (!isReportPath(file?.path) || typeof file.content !== "string") return "Not a file of a report";
    if (paths.has(file.path)) return `${file.path} is in the report twice`;
    paths.add(file.path);
    bytes += Buffer.byteLength(file.content, "utf8");
  }
  if (bytes > REPORT_BOUNDS.bytes) return "The report is too large";
  return undefined;
}

export async function saveReport(
  request: ReportSaveRequest,
  dialog: SaveDialog = hostDialog(),
  write: (file: string, content: Buffer) => Promise<void> = (file, content) => writeFile(file, content),
  now: () => Date = () => new Date(),
): Promise<ReportSaveAnswer> {
  const refusal = reportRefusal(request);
  if (refusal) return { error: refusal };
  const title = typeof request.title === "string" && request.title ? request.title : "Save diagnostic report";
  let chosen: { canceled: boolean; filePath?: string };
  try {
    chosen = await dialog.showSaveDialog({
      title,
      message: title,
      defaultPath: request.suggestedName,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
  } catch {
    return { error: "The save dialog could not be opened" };
  }
  if (chosen.canceled || !chosen.filePath) return { canceled: true };
  try {
    await write(chosen.filePath, zipFiles(request.files, now()));
  } catch (error) {
    return { error: `The file could not be written: ${(error as NodeJS.ErrnoException)?.code ?? "error"}` };
  }
  return { path: chosen.filePath };
}
