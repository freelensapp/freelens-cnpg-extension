/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The tiles of the live view (SPEC-0006 "The page grid"). Each one is a thin
// shell over a slice of the pure model and handles its own non-happy states,
// so an endpoint that does not answer never blanks the page.

import { Renderer } from "@freelensapp/extensions";
import { humanizeDuration, humanizeRelative } from "../backup-health";
import { exactBytes, formatBytes } from "../bytes";
import { formatCount, formatLag } from "./format";
import styles from "./live.module.scss";
import { LONG_TRANSACTION_SECONDS, READY_WAL_WARNING, XID_AGE_ERROR, XID_AGE_WARNING } from "./live-model";
import { Sparkline } from "./sparkline";

import type { ReactNode } from "react";

import type { Level, LiveView } from "./live-model";
import type { SeriesPoint } from "./series";

const {
  Component: { Badge, BadgeBoolean, Table, TableCell, TableHead, TableRow, WithTooltip },
} = Renderer;

const LEVEL_CLASS: Record<Level, string> = { ok: "", warning: styles.levelWarning, error: styles.levelError };

export type SeriesMap = ReadonlyMap<string, readonly SeriesPoint[]>;

interface TileProps {
  title: string;
  testId: string;
  /** Shown in place of the content: still loading, or what failed and what it needs. */
  placeholder?: string;
  loading?: boolean;
  children?: ReactNode;
}

function Tile({ title, testId, placeholder, loading, children }: TileProps) {
  return (
    <section className={styles.tile} data-testid={testId}>
      <h6 className={styles.tileTitle}>{title}</h6>
      {loading ? (
        <div className={styles.skeleton} aria-busy="true" />
      ) : placeholder ? (
        <div className={styles.muted}>{placeholder}</div>
      ) : (
        children
      )}
    </section>
  );
}

function Figure({
  label,
  children,
  level = "ok",
  title,
}: {
  label: string;
  children: ReactNode;
  level?: Level;
  title?: string;
}) {
  return (
    <div className={styles.figure} title={title}>
      <span className={styles.figureLabel}>{label}</span>
      <span className={[styles.figureValue, LEVEL_CLASS[level]].join(" ").trim()}>{children}</span>
    </div>
  );
}

export interface LiveTileProps {
  view: LiveView;
  series: SeriesMap;
  /** True until the first metrics round has come back. */
  metricsPending: boolean;
  /** Why the metrics cannot be read, when they cannot. */
  metricsFailure?: string;
  now: Date;
}

const SESSION_STATE_CLASS: Record<string, string> = {
  active: styles.stateActive,
  idle: styles.stateIdle,
  "idle in transaction": styles.stateIdleInTransaction,
  "idle in transaction (aborted)": styles.stateIdleInTransaction,
};

export function SessionsTile({ view, series, metricsPending, metricsFailure }: LiveTileProps) {
  const sessions = view.sessions;
  return (
    <Tile
      title="Sessions"
      testId="cnpg-live-sessions"
      loading={metricsPending}
      placeholder={sessions ? undefined : (metricsFailure ?? "Waiting for the metrics of the instances")}
    >
      {sessions ? (
        <>
          <div className={styles.headline}>
            <span className={styles.headlineValue} data-testid="cnpg-live-sessions-total">
              {formatCount(sessions.total)}
            </span>
            <span className={styles.muted}>
              {sessions.maxConnections ? `of ${formatCount(sessions.maxConnections)} per instance, ` : ""}
              {formatCount(sessions.user)} of users, {formatCount(sessions.system)} of the platform
            </span>
            <Sparkline points={series.get("sessions")} label="Sessions" className={styles.sparkline} />
          </div>
          <div className={styles.stateBar} role="img" aria-label="Sessions by state">
            {sessions.byState.map((entry) => (
              <span
                key={entry.state}
                className={[styles.stateSegment, SESSION_STATE_CLASS[entry.state] ?? styles.stateOther].join(" ")}
                style={{ flexGrow: entry.count }}
                title={`${entry.state}: ${formatCount(entry.count)}`}
              />
            ))}
          </div>
          <div className={styles.legend}>
            {sessions.byState.map((entry) => (
              <span key={entry.state}>
                <span className={[styles.legendDot, SESSION_STATE_CLASS[entry.state] ?? styles.stateOther].join(" ")} />
                {entry.state} {formatCount(entry.count)}
              </span>
            ))}
          </div>
          <div className={styles.figures}>
            <Figure label="On the primary">{formatCount(sessions.primary)}</Figure>
            <Figure label="On the standbys">{formatCount(sessions.standbys)}</Figure>
            <Figure label="Waiting on a lock" level={sessions.waiting > 0 ? "warning" : "ok"}>
              {formatCount(sessions.waiting)}
            </Figure>
            <Figure
              label="Longest transaction"
              level={sessions.longestTransactionLevel}
              title={`Warning above ${LONG_TRANSACTION_SECONDS / 60} minutes; ${sessions.longestTransactionSeconds ?? 0} s`}
            >
              {sessions.longestTransactionSeconds === undefined
                ? "none"
                : humanizeDuration(sessions.longestTransactionSeconds * 1000)}
            </Figure>
          </div>
          {sessions.topDatabases.length > 0 ? (
            <div className={styles.topLists}>
              <TopList title="By database" entries={sessions.topDatabases} />
              <TopList title="By user" entries={sessions.topUsers} />
            </div>
          ) : null}
        </>
      ) : null}
    </Tile>
  );
}

function TopList({ title, entries }: { title: string; entries: Array<{ name: string; count: number }> }) {
  return (
    <div className={styles.topList}>
      <div className={styles.figureLabel}>{title}</div>
      {entries.map((entry) => (
        <div key={entry.name} className={styles.topEntry}>
          <WithTooltip>{entry.name}</WithTooltip>
          <span>{formatCount(entry.count)}</span>
        </div>
      ))}
    </div>
  );
}

export function LagTile({ view, series }: LiveTileProps) {
  const streaming = view.edges.filter((edge) => edge.streaming);
  return (
    <Tile
      title="Replication lag"
      testId="cnpg-live-lag"
      loading={view.pending}
      placeholder={
        view.edges.length === 0
          ? view.primary
            ? "No standby: nothing replicates"
            : "No primary answers, so no lag can be read"
          : undefined
      }
    >
      {view.edges.map((edge) => (
        <div key={edge.standby} className={styles.lagRow} data-testid={`cnpg-live-lag-${edge.standby}`}>
          <WithTooltip>{edge.standby}</WithTooltip>
          <span className={[styles.figureValue, LEVEL_CLASS[edge.level]].join(" ").trim()}>
            {edge.streaming ? formatLag(edge.replayLagMs) : edge.state}
          </span>
          <Sparkline points={series.get(`lag:${edge.standby}`)} label={`Replay lag of ${edge.standby}, ms`} />
        </div>
      ))}
      {streaming.length > 0 ? (
        <div className={styles.muted}>Replay lag, the worst first; warning above 10 s or 64 MiB</div>
      ) : null}
    </Tile>
  );
}

export function DatabasesTile({ view, metricsPending, metricsFailure }: LiveTileProps) {
  return (
    <Tile
      title="Databases"
      testId="cnpg-live-databases"
      loading={metricsPending}
      placeholder={view.databases.length > 0 ? undefined : (metricsFailure ?? "Waiting for the metrics of the primary")}
    >
      <Table scrollable={false} sortSyncWithUrl={false} className={styles.nested}>
        <TableHead flat sticky={false}>
          <TableCell className={styles.colName}>Database</TableCell>
          <TableCell className={styles.colBar}>Size</TableCell>
          <TableCell className={styles.colNumber}>Transaction ID age</TableCell>
        </TableHead>
        {view.databases.map((database) => (
          <TableRow key={database.name} nowrap>
            <TableCell className={styles.colName}>
              <WithTooltip>{database.name}</WithTooltip>
            </TableCell>
            <TableCell className={styles.colBar}>
              <span
                className={styles.sizeCell}
                title={database.sizeBytes !== undefined ? exactBytes(Math.round(database.sizeBytes)) : undefined}
              >
                <span className={styles.sizeBar}>
                  <span className={styles.sizeBarFill} style={{ width: `${Math.max(2, database.share * 100)}%` }} />
                </span>
                {database.sizeBytes !== undefined ? formatBytes(database.sizeBytes) : "N/A"}
              </span>
            </TableCell>
            <TableCell className={styles.colNumber}>
              <span
                className={LEVEL_CLASS[database.level]}
                title={`Warning above ${formatCount(XID_AGE_WARNING)}, error above ${formatCount(XID_AGE_ERROR)}; the wraparound limit is about 2,100,000,000`}
              >
                {formatCount(database.xidAge)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </Tile>
  );
}

export function WalTile({ view, now }: LiveTileProps) {
  const wal = view.wal;
  return (
    <Tile
      title="WAL and archiving"
      testId="cnpg-live-wal"
      loading={view.pending}
      placeholder={wal ? undefined : "No primary answers, so the WAL position cannot be read"}
    >
      {wal ? (
        <>
          <div className={styles.headline}>
            <span data-testid="cnpg-live-wal-state">
              <Badge
                className={wal.state === "Archiving" ? "success" : wal.state === "Failing" ? "error" : "info"}
                label={wal.state}
              />
            </span>
            <span className={styles.mono} title="Current WAL file">
              {wal.currentWal ?? "N/A"}
            </span>
          </div>
          <div className={styles.figures}>
            <Figure label="Last archived" title={wal.lastArchivedAt?.toISOString()}>
              <span className={styles.mono}>{wal.lastArchivedWal ?? "none"}</span>
              {wal.lastArchivedAt ? ` ${humanizeRelative(wal.lastArchivedAt, now)}` : ""}
            </Figure>
            <Figure
              label="Last failed"
              title={wal.lastFailedAt?.toISOString()}
              level={wal.state === "Failing" ? "error" : "ok"}
            >
              <span className={styles.mono}>{wal.lastFailedWal ?? "none"}</span>
              {wal.lastFailedAt ? ` ${humanizeRelative(wal.lastFailedAt, now)}` : ""}
            </Figure>
            <Figure
              label="Waiting to be archived"
              level={wal.readyLevel}
              title={`WAL files ready for the archiver; warning above ${READY_WAL_WARNING}`}
            >
              {formatCount(wal.readyFiles ?? 0)}
            </Figure>
            <Figure label="Archived / failed">
              {formatCount(wal.archivedCount)} / {formatCount(wal.failedCount)}
            </Figure>
            <Figure
              label="WAL on disk"
              title={wal.walSizeBytes !== undefined ? exactBytes(Math.round(wal.walSizeBytes)) : undefined}
            >
              {wal.walSizeBytes !== undefined ? formatBytes(wal.walSizeBytes) : "N/A"}
              {wal.walFiles !== undefined ? ` in ${formatCount(wal.walFiles)} files` : ""}
            </Figure>
            {wal.volumeSizeBytes !== undefined && wal.volumeMaxBytes !== undefined ? (
              <Figure label="WAL volume">
                {formatBytes(wal.volumeSizeBytes)} of {formatBytes(wal.volumeMaxBytes)}
              </Figure>
            ) : null}
          </div>
        </>
      ) : null}
    </Tile>
  );
}

export function SlotsTile({ view }: LiveTileProps) {
  return (
    <Tile
      title="Replication slots"
      testId="cnpg-live-slots"
      loading={view.pending}
      placeholder={view.slots.length > 0 ? undefined : view.primary ? "No replication slot" : "No primary answers"}
    >
      <Table scrollable={false} sortSyncWithUrl={false} className={styles.nested}>
        <TableHead flat sticky={false}>
          <TableCell className={styles.colName}>Slot</TableCell>
          <TableCell className={styles.colSmall}>Type</TableCell>
          <TableCell className={styles.colSmall}>Active</TableCell>
          <TableCell className={styles.colNumber}>Retained WAL</TableCell>
          <TableCell className={styles.colSmall}>WAL status</TableCell>
        </TableHead>
        {view.slots.map((slot) => (
          <TableRow key={slot.name} nowrap>
            <TableCell className={styles.colName}>
              <WithTooltip tooltip={`${slot.name}, restart LSN ${slot.restartLsn ?? "N/A"}`}>{slot.name}</WithTooltip>
            </TableCell>
            <TableCell className={styles.colSmall}>{slot.type ?? "N/A"}</TableCell>
            <TableCell className={styles.colSmall}>
              <BadgeBoolean value={slot.active} />
            </TableCell>
            <TableCell className={styles.colNumber}>
              <span
                className={LEVEL_CLASS[slot.level]}
                title={
                  slot.level === "warning"
                    ? "An inactive slot that holds WAL back: this is how a disk fills"
                    : slot.retainedBytes !== undefined
                      ? exactBytes(Math.round(slot.retainedBytes))
                      : undefined
                }
              >
                {slot.retainedBytes !== undefined ? formatBytes(slot.retainedBytes) : "N/A"}
              </span>
            </TableCell>
            <TableCell className={styles.colSmall}>{slot.walStatus ?? "N/A"}</TableCell>
          </TableRow>
        ))}
      </Table>
    </Tile>
  );
}

export function BasebackupsTile({ view }: LiveTileProps) {
  if (view.basebackups.length === 0) return null;
  return (
    <Tile title="Base backups in progress" testId="cnpg-live-basebackups">
      {view.basebackups.map((backup, index) => {
        const total = Number(backup.backupTotal);
        const streamed = Number(backup.backupStreamed);
        const share = total > 0 && Number.isFinite(streamed) ? Math.min(1, streamed / total) : undefined;
        return (
          <div key={`${backup.applicationName ?? "backup"}-${index}`} className={styles.lagRow}>
            <WithTooltip>{backup.applicationName || backup.usename || "base backup"}</WithTooltip>
            <span>{backup.phase ?? "in progress"}</span>
            <span>{share !== undefined ? `${Math.round(share * 100)}%` : ""}</span>
          </div>
        );
      })}
    </Tile>
  );
}

export function ManagerTile({ view }: LiveTileProps) {
  return (
    <Tile title="Instance manager" testId="cnpg-live-manager" loading={view.pending}>
      {view.manager.skew ? (
        <div className={[styles.muted, styles.levelWarning].join(" ")}>The instances run different versions</div>
      ) : null}
      {view.manager.instances.map((instance) => (
        <div key={instance.name} className={styles.lagRow}>
          <WithTooltip>{instance.name}</WithTooltip>
          <span>{instance.version ?? "N/A"}</span>
          <span className={styles.muted}>
            {instance.arch ?? ""}
            {instance.upgrading ? ", upgrading" : ""}
          </span>
        </div>
      ))}
    </Tile>
  );
}
