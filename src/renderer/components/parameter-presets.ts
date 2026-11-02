/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The parameter presets of Create Cluster (SPEC-0032): a starting point for
// postgresql.conf, sized on the memory of the instances and on the disk the WAL
// lives on. Never a parameter the operator fixes, never ssl*. Pure.

import { quantityValue } from "./create-forms";

import type { KeyValue } from "./create-forms";

export type PresetId = "general" | "writeHeavy" | "analytics" | "development";

export interface ParameterPreset {
  id: PresetId;
  label: string;
  description: string;
}

export const PARAMETER_PRESETS: readonly ParameterPreset[] = [
  {
    id: "general",
    label: "General purpose",
    description: "a quarter of the memory to shared_buffers, room for checkpoints",
  },
  {
    id: "writeHeavy",
    label: "Write heavy",
    description: "more WAL between checkpoints, checkpoints every 15 minutes",
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "more memory per sort and per maintenance, finer statistics",
  },
  {
    id: "development",
    label: "Small development",
    description: "small buffers and WAL, for a cluster on a laptop",
  },
];

export interface PresetSizing {
  /** The memory of an instance, in bytes. */
  memoryBytes: number;
  /** True when no memory was set and the preset assumes `ASSUMED_MEMORY`. */
  memoryAssumed: boolean;
  /** The disk the WAL lives on, in bytes. */
  walDiskBytes: number;
  walDiskAssumed: boolean;
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** The memory a preset assumes when the form sets none. */
export const ASSUMED_MEMORY = GB;
/** The share of the WAL disk `max_wal_size` may take: the rest is for WAL kept for the standbys and the archive. */
const WAL_DISK_SHARE = 4;
/** Two WAL segments of 16MB: PostgreSQL refuses a smaller `min_wal_size`. */
const MIN_WAL_FLOOR = 32 * MB;
/** The connections the operator leaves by default: the share of memory a sort may take is counted on them. */
const CONNECTIONS = 100;

export interface SizingInputs {
  requestsMemory: string;
  limitsMemory: string;
  storageSize: string;
  walEnabled: boolean;
  walSize: string;
}

/** The memory request, else the limit; the WAL volume when there is one, else the data volume. */
export function presetSizing(form: SizingInputs): PresetSizing {
  const memory = quantityValue(form.requestsMemory) || quantityValue(form.limitsMemory);
  const disk = form.walEnabled ? quantityValue(form.walSize) : quantityValue(form.storageSize);
  return {
    memoryBytes: memory && memory > 0 ? memory : ASSUMED_MEMORY,
    memoryAssumed: !(memory && memory > 0),
    walDiskBytes: disk && disk > 0 ? disk : GB,
    walDiskAssumed: !(disk && disk > 0),
  };
}

/** A PostgreSQL memory setting: whole GB when it is one, else whole MB, else whole kB. */
export function postgresSize(bytes: number): string {
  if (bytes >= GB && bytes % GB === 0) return `${bytes / GB}GB`;
  if (bytes >= MB) return `${Math.floor(bytes / MB)}MB`;
  return `${Math.max(64, Math.floor(bytes / KB))}kB`;
}

function walSizes(sizing: PresetSizing, min: number, max: number): Record<string, string> {
  const maxWal = Math.max(2 * MIN_WAL_FLOOR, Math.min(max, Math.floor(sizing.walDiskBytes / WAL_DISK_SHARE)));
  const minWal = Math.max(MIN_WAL_FLOOR, Math.min(min, Math.floor(maxWal / 4)));
  return { min_wal_size: postgresSize(minWal), max_wal_size: postgresSize(maxWal) };
}

/** The values of a preset for this sizing, in the order they are added to the form. */
export function presetValues(id: PresetId, sizing: PresetSizing): Record<string, string> {
  const memory = sizing.memoryBytes;
  if (id === "development") {
    return {
      shared_buffers: postgresSize(Math.min(memory / 4, 128 * MB)),
      effective_cache_size: postgresSize(memory / 2),
      work_mem: "4MB",
      maintenance_work_mem: postgresSize(Math.min(memory / 16, 64 * MB)),
      ...walSizes(sizing, 80 * MB, GB),
    };
  }
  const sharedBuffers = memory / 4;
  const perSort = (memory - sharedBuffers) / CONNECTIONS;
  const common = {
    shared_buffers: postgresSize(sharedBuffers),
    effective_cache_size: postgresSize((memory * 3) / 4),
  };
  if (id === "analytics") {
    return {
      ...common,
      work_mem: postgresSize(perSort / 2),
      maintenance_work_mem: postgresSize(Math.min(memory / 8, 2 * GB)),
      ...walSizes(sizing, 4 * GB, 16 * GB),
      default_statistics_target: "500",
    };
  }
  const oltp = {
    ...common,
    work_mem: postgresSize(perSort / 6),
    maintenance_work_mem: postgresSize(Math.min(memory / 16, 2 * GB)),
  };
  if (id === "writeHeavy") {
    return { ...oltp, ...walSizes(sizing, 2 * GB, 8 * GB), checkpoint_timeout: "15min" };
  }
  return { ...oltp, ...walSizes(sizing, GB, 4 * GB) };
}

/** True when every value a preset set is still in the rows as it set it: the user has not edited them. */
export function presetIntact(rows: readonly KeyValue[], applied: Readonly<Record<string, string>>): boolean {
  return Object.entries(applied).every(([key, value]) =>
    rows.some((row) => row.key.trim() === key && row.value.trim() === value),
  );
}

/**
 * The rows with a preset's values: a row of the previous preset the user left alone goes when the new one
 * has no such key, a row of the same key takes the new value, the rest is added at the end. The user's own
 * rows stay as they are.
 */
export function applyPreset(
  rows: readonly KeyValue[],
  values: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>> = {},
): KeyValue[] {
  const kept = rows
    .filter((row) => {
      const key = row.key.trim();
      return !(key in previous && previous[key] === row.value.trim() && !(key in values));
    })
    .map((row) => (row.key.trim() in values ? { key: row.key, value: values[row.key.trim()] } : { ...row }));
  const present = new Set(kept.map((row) => row.key.trim()));
  return [
    ...kept,
    ...Object.entries(values)
      .filter(([key]) => !present.has(key))
      .map(([key, value]) => ({ key, value })),
  ];
}

/** What the preset was sized on, in words. */
export function presetSizingWords(sizing: PresetSizing): string {
  const memory = sizing.memoryAssumed
    ? `an assumed ${postgresSize(sizing.memoryBytes)} of memory (no memory set in Resources)`
    : `${postgresSize(sizing.memoryBytes)} of memory`;
  const disk = sizing.walDiskAssumed ? "an assumed 1GB WAL disk" : `a WAL disk of ${postgresSize(sizing.walDiskBytes)}`;
  return `Sized for ${memory} and ${disk}.`;
}
