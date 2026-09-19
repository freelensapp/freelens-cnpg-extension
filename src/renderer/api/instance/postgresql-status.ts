/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The answer of the instance manager's `GET /pg/status` (SPEC-0001 R5),
// written from the contract and checked against the answers of the operator
// 1.30.0 on the E2E cluster. Every field is optional but the two the guard
// asks for: the instance manager omits what is zero or empty, and a newer one
// may add fields this extension does not know yet.

export interface ReplicationInfo {
  applicationName?: string;
  state?: string;
  /** The LSN sent to the standby (the JSON name says "received"). */
  receivedLsn?: string;
  writeLsn?: string;
  flushLsn?: string;
  replayLsn?: string;
  /** PostgreSQL interval strings, see `pg-interval.ts`. */
  writeLag?: string;
  flushLag?: string;
  replayLag?: string;
  syncState?: string;
  /** A number in a string on 1.30.0. */
  syncPriority?: string | number;
}

export interface ReplicationSlotInfo {
  slotName?: string;
  plugin?: string;
  slotType?: string;
  database?: string;
  restartLsn?: string;
  walStatus?: string;
  safeWalSize?: number;
  active?: boolean;
}

export interface BasebackupInfo {
  usename?: string;
  applicationName?: string;
  backendStart?: string;
  phase?: string;
  backupTotal?: number;
  backupStreamed?: number;
  tablespacesTotal?: number;
  tablespacesStreamed?: number;
  [key: string]: unknown;
}

export interface PostgresqlStatus {
  isPrimary: boolean;
  /** A trimmed Pod object: only `metadata.name` is filled. */
  pod: { metadata?: { name?: string } };
  currentLsn?: string;
  receivedLsn?: string;
  replayLsn?: string;
  systemID?: string;
  replayPaused?: boolean;
  pendingRestart?: boolean;
  pendingRestartForDecrease?: boolean;
  isWalReceiverActive?: boolean;
  isPgRewindRunning?: boolean;
  /**
   * True when the instance manager answers but PostgreSQL does not (a fenced
   * instance, a PostgreSQL that is starting or stopped); the error says why.
   */
  mightBeUnavailable?: boolean;
  mightBeUnavailableMaskedError?: string;
  isArchivingWAL?: boolean;
  isPodReady?: boolean;
  node?: string;
  lastArchivedWAL?: string;
  /** RFC 3339, or "-infinity" on an instance that never archived. */
  lastArchivedWALTime?: string;
  lastFailedWAL?: string;
  lastFailedWALTime?: string;
  currentWAL?: string;
  readyWalFiles?: number;
  timeLineID?: number;
  replicationInfo?: ReplicationInfo[];
  replicationSlotsInfo?: ReplicationSlotInfo[];
  pgStatBasebackupsInfo?: BasebackupInfo[];
  instanceManagerVersion?: string;
  instanceArch?: string;
  isInstanceManagerUpgrading?: boolean;
  sessionID?: string;
  [key: string]: unknown;
}

/**
 * True when the value has the shape of an instance status. Unknown fields are
 * welcome; an answer without the pod and the role is not a status at all (an
 * error page of a proxy, a different endpoint).
 */
export function isPostgresqlStatus(value: unknown): value is PostgresqlStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.isPrimary === "boolean" && typeof candidate.pod === "object" && candidate.pod !== null;
}

/** The pod the status speaks for. */
export function statusPodName(status: PostgresqlStatus): string | undefined {
  return status.pod?.metadata?.name || undefined;
}

/** An instance manager time: RFC 3339, with "-infinity" and the empty string meaning "never". */
export function parseStatusTime(value: string | undefined | null): Date | undefined {
  if (!value || value === "-infinity" || value === "infinity") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time);
}
