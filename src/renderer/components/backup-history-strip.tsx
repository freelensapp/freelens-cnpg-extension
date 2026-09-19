/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The backup history strip (SPEC-0005 "Backup history strip"): a thin shell
// over the pure `buildHistory` model. Time runs left to right and ends at
// "now"; the next scheduled run sits beyond it as a hollow mark. Every mark is
// a door: one backup opens its drawer, a merged mark opens the filtered list.

import { Renderer } from "@freelensapp/extensions";
import { humanizeDuration, humanizeRelative } from "./backup-health";
import styles from "./backup-history-strip.module.scss";
import stylesInline from "./backup-history-strip.module.scss?inline";

import type { BackupHistory, HistoryMark } from "./backup-history";

const {
  Component: { MaybeLink },
} = Renderer;

export interface BackupHistoryStripProps {
  history: BackupHistory;
  now: Date;
  /** The details URL of a backup by name, or undefined when it cannot be linked. */
  backupUrl: (name: string) => string | undefined;
  /** Where a merged mark leads: the Backups list filtered to the same owner. */
  listUrl: string;
}

const STATE_CLASS: Record<HistoryMark["state"], string> = {
  Completed: styles.completed,
  Failed: styles.failed,
  Running: styles.running,
  Pending: styles.pending,
  Unknown: styles.unknown,
};

function markTitle(mark: HistoryMark): string {
  const when = mark.time.toISOString();
  if (mark.names.length === 1) return `${mark.names[0]}: ${mark.state}, ${when}`;
  return `${mark.names.length} backups (${mark.names.join(", ")}): latest ${when}; opens the list`;
}

export function BackupHistoryStrip({ history, now, backupUrl, listUrl }: BackupHistoryStripProps) {
  const { marks, recoverableFrom, lastSuccessful, longestGapMs, nextRun, windowDays, hasActiveSchedule } = history;

  return (
    <div className={styles.history} data-testid="cnpg-backup-history">
      <style>{stylesInline}</style>
      <div className={styles.caption}>Backup history, last {windowDays} days</div>
      {marks.length === 0 ? (
        <div className={styles.empty}>
          No backups in the last {windowDays} days
          {hasActiveSchedule ? null : (
            <span className={styles.warning}> and no active scheduled backup is defined</span>
          )}
        </div>
      ) : (
        <div className={styles.row}>
          <div className={styles.track}>
            {recoverableFrom ? (
              <div
                className={styles.band}
                style={{ left: `${recoverableFrom.position * 100}%` }}
                title={`Recoverable since ${recoverableFrom.time.toISOString()} (the first successful backup, while WAL archiving works)`}
              />
            ) : null}
            {marks.map((mark) => (
              <MaybeLink
                key={`${mark.position}-${mark.names[0]}`}
                to={mark.names.length === 1 ? (backupUrl(mark.names[0]) ?? listUrl) : listUrl}
                className={`${styles.mark} ${STATE_CLASS[mark.state]}`}
                style={{ left: `${mark.position * 100}%` }}
                title={markTitle(mark)}
                aria-label={markTitle(mark)}
                data-state={mark.state}
                onClick={(event) => event.stopPropagation()}
              >
                {mark.names.length > 1 ? <span className={styles.count}>{mark.names.length}</span> : null}
              </MaybeLink>
            ))}
          </div>
          <div className={styles.now} title={`Now: ${now.toISOString()}`} />
          <div className={styles.next}>
            {nextRun ? (
              <span
                className={styles.nextMark}
                title={`Next scheduled run: ${nextRun.toISOString()}`}
                data-testid="cnpg-backup-history-next"
              />
            ) : null}
          </div>
        </div>
      )}
      {marks.length > 0 ? (
        <div className={styles.axis}>
          <span>{windowDays} days ago</span>
          <span>now</span>
        </div>
      ) : null}
      <div className={styles.facts}>
        <span title={lastSuccessful?.toISOString()}>
          Last successful: {lastSuccessful ? humanizeRelative(lastSuccessful, now) : "never"}
        </span>
        {longestGapMs !== undefined ? (
          <span
            title={`${Math.round(longestGapMs / 1000)} s without a successful backup, in the last ${windowDays} days`}
          >
            Longest gap: {humanizeDuration(longestGapMs)}
          </span>
        ) : null}
        <span title={nextRun?.toISOString()} className={!nextRun && !hasActiveSchedule ? styles.warning : undefined}>
          Next run:{" "}
          {nextRun ? humanizeRelative(nextRun, now) : hasActiveSchedule ? "not reported yet" : "no active schedule"}
        </span>
      </div>
    </div>
  );
}
