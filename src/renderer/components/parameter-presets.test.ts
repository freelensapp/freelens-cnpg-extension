/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parameterKeyError, parameterValueError, postgresMemory } from "./create-forms";
import {
  applyPreset,
  PARAMETER_PRESETS,
  postgresSize,
  presetIntact,
  presetSizing,
  presetSizingWords,
  presetValues,
} from "./parameter-presets";

const SIZING_INPUTS = { requestsMemory: "", limitsMemory: "", storageSize: "", walEnabled: false, walSize: "" };

describe("the parameter presets of Create Cluster (SPEC-0032)", () => {
  it("sizes on the memory request, else the limit, and on the WAL volume, else the data volume", () => {
    expect(presetSizing({ ...SIZING_INPUTS, requestsMemory: "4Gi", limitsMemory: "8Gi", storageSize: "20Gi" })).toEqual(
      { memoryBytes: 4 * 1024 ** 3, memoryAssumed: false, walDiskBytes: 20 * 1024 ** 3, walDiskAssumed: false },
    );
    expect(
      presetSizing({ ...SIZING_INPUTS, limitsMemory: "2Gi", storageSize: "20Gi", walEnabled: true, walSize: "4Gi" }),
    ).toMatchObject({ memoryBytes: 2 * 1024 ** 3, walDiskBytes: 4 * 1024 ** 3 });
    const assumed = presetSizing(SIZING_INPUTS);
    expect(assumed).toMatchObject({ memoryAssumed: true, walDiskAssumed: true });
    expect(presetSizingWords(assumed)).toBe(
      "Sized for an assumed 1GB of memory (no memory set in Resources) and an assumed 1GB WAL disk.",
    );
  });

  it("writes PostgreSQL sizes in whole GB, MB or kB", () => {
    expect(postgresSize(2 * 1024 ** 3)).toBe("2GB");
    expect(postgresSize(1.5 * 1024 ** 3)).toBe("1536MB");
    expect(postgresSize(1300 * 1024)).toBe("1MB");
    expect(postgresSize(900 * 1024)).toBe("900kB");
    expect(postgresSize(10)).toBe("64kB");
  });

  it("gives the general purpose values for 4Gi of memory and a 20Gi disk", () => {
    const sizing = presetSizing({ ...SIZING_INPUTS, requestsMemory: "4Gi", storageSize: "20Gi" });
    expect(presetValues("general", sizing)).toEqual({
      shared_buffers: "1GB",
      effective_cache_size: "3GB",
      work_mem: "5MB",
      maintenance_work_mem: "256MB",
      min_wal_size: "1GB",
      max_wal_size: "4GB",
    });
  });

  it("keeps max_wal_size to a quarter of the WAL disk, and min_wal_size below it", () => {
    const small = presetSizing({ ...SIZING_INPUTS, requestsMemory: "4Gi", storageSize: "1Gi" });
    expect(presetValues("analytics", small)).toMatchObject({ min_wal_size: "64MB", max_wal_size: "256MB" });
    const big = presetSizing({ ...SIZING_INPUTS, requestsMemory: "4Gi", walEnabled: true, walSize: "200Gi" });
    expect(presetValues("analytics", big)).toMatchObject({ min_wal_size: "4GB", max_wal_size: "16GB" });
    expect(presetValues("writeHeavy", big)).toMatchObject({
      min_wal_size: "2GB",
      max_wal_size: "8GB",
      checkpoint_timeout: "15min",
    });
  });

  it("never sets a parameter the form refuses, nor min_wal_size at or above max_wal_size, nor shared_buffers above the memory", () => {
    for (const memory of ["256Mi", "1Gi", "3Gi", "64Gi", ""]) {
      for (const disk of ["300Mi", "1Gi", "10Gi", "1Ti"]) {
        const sizing = presetSizing({ ...SIZING_INPUTS, requestsMemory: memory, storageSize: disk });
        for (const preset of PARAMETER_PRESETS) {
          const values = presetValues(preset.id, sizing);
          for (const [key, value] of Object.entries(values)) {
            expect(parameterKeyError(key), `${preset.id} ${key}`).toBeUndefined();
            expect(parameterValueError(key, value, 3), `${preset.id} ${key}=${value}`).toBeUndefined();
          }
          const min = postgresMemory(values.min_wal_size)?.bytes ?? 0;
          const max = postgresMemory(values.max_wal_size)?.bytes ?? 0;
          expect(min, `${preset.id} ${memory} ${disk}`).toBeLessThan(max);
          expect(postgresMemory(values.shared_buffers)?.bytes).toBeLessThanOrEqual(sizing.memoryBytes);
        }
      }
    }
  });

  it("applies a preset over the user's rows, and a switch drops only the previous values left alone", () => {
    const user = [{ key: "log_min_duration_statement", value: "1s" }];
    const general = { shared_buffers: "1GB", work_mem: "4MB" };
    const applied = applyPreset(user, general);
    expect(applied).toEqual([
      { key: "log_min_duration_statement", value: "1s" },
      { key: "shared_buffers", value: "1GB" },
      { key: "work_mem", value: "4MB" },
    ]);
    const edited = applied.map((row) => (row.key === "work_mem" ? { ...row, value: "8MB" } : row));
    expect(presetIntact(applied, general)).toBe(true);
    expect(presetIntact(edited, general)).toBe(false);
    expect(applyPreset(applied, { shared_buffers: "2GB", checkpoint_timeout: "15min" }, general)).toEqual([
      { key: "log_min_duration_statement", value: "1s" },
      { key: "shared_buffers", value: "2GB" },
      { key: "checkpoint_timeout", value: "15min" },
    ]);
    expect(applyPreset(edited, {}, general)).toEqual([
      { key: "log_min_duration_statement", value: "1s" },
      { key: "work_mem", value: "8MB" },
    ]);
  });
});
