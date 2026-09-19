/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One cluster of the Overview grid (SPEC-0004 "Layout" 2): compact, about
// four lines, every figure exact in a tooltip, the whole tile a link to the
// cluster drawer (the host's own details URL, so it works like every LinkTo
// component) and the namespace badge a door to the namespace filter.

import { Renderer } from "@freelensapp/extensions";
import { humanizeRelative } from "../backup-health";
import { InstanceBricks } from "../instance-bricks";
import styles from "./tile-grid.module.scss";

import type { ClusterTile as ClusterTileModel } from "../overview-model";

const {
  Component: { Badge, BadgeBoolean, MaybeLink, NamespaceSelectBadge, ReactiveDuration, WithTooltip },
} = Renderer;

function certificateSentence(tile: ClusterTileModel): { text: string; className: string } {
  const horizon = tile.certificateHorizon;
  const date = horizon.earliest?.toISOString().slice(0, 10);
  switch (horizon.state) {
    case "expired":
      return { text: `cert expired (${date})`, className: styles.errorText };
    case "expiring":
      return { text: `cert expires in ${horizon.daysLeft} days`, className: styles.warningText };
    case "ok":
      return { text: `certs ok until ${date}`, className: "" };
    default:
      return { text: "cert expiry unknown", className: "" };
  }
}

export interface ClusterTileProps {
  tile: ClusterTileModel;
  /** The host details URL of the cluster; absent while the store has not got it yet. */
  detailsUrl?: string;
  /** The Backups list filtered to this cluster (SPEC-0005 "Doors from the M1 views"). */
  backupsUrl?: string;
  /** The host details URL of the schedule behind the next backup line. */
  scheduleUrl?: string;
  /** The Live View of the cluster (SPEC-0006); absent for a hibernated cluster. */
  liveUrl?: string;
}

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

// The whole tile is a door to the cluster drawer, and two of its lines are
// doors of their own (the backups of the cluster, the next schedule). Links
// cannot nest, so the main link stretches over the tile through its ::after
// and the inner doors sit above it (tile-grid.module.scss, ".tileMain").
export function ClusterTile({ tile, detailsUrl, backupsUrl, scheduleUrl, liveUrl }: ClusterTileProps) {
  const certificate = certificateSentence(tile);
  const lastBackup = tile.backups.lastSuccessful;
  const attention = tile.health.state === "Degraded" || tile.health.state === "Failed";

  return (
    <div
      className={[styles.clusterTile, attention ? styles.attention : ""].join(" ").trim()}
      data-testid={`cnpg-overview-tile-${tile.namespace}-${tile.name}`}
      data-state={tile.health.state}
    >
      <span className={styles.tileHeader}>
        <span className={styles.tileNamespace} onClick={stop} onKeyDown={stop}>
          <NamespaceSelectBadge namespace={tile.namespace} />
        </span>
        <MaybeLink to={detailsUrl} className={styles.tileMain} title={`${tile.namespace}/${tile.name}`}>
          {tile.name}
        </MaybeLink>
        <Badge small className={tile.health.className} label={tile.health.label} tooltip={tile.health.reason} />
      </span>
      {attention ? (
        <span className={styles.tileReason} title={tile.health.reason}>
          {tile.health.reason}
        </span>
      ) : null}
      <span className={styles.tileFacts}>
        <span className={styles.tileFact} title="Ready instances over declared instances">
          <span className={styles.tileFactLabel}>Instances</span>
          {tile.readyInstances}/{tile.declaredInstances}
          <InstanceBricks instances={tile.instances} />
        </span>
        <span
          className={styles.tileFact}
          title={tile.targetPrimary ? `Switching to ${tile.targetPrimary}` : "Current primary"}
        >
          <span className={styles.tileFactLabel}>Primary</span>
          <WithTooltip>{tile.primary ?? "N/A"}</WithTooltip>
        </span>
        <span className={styles.tileFact} title={tile.archiving.message ?? "WAL archiving"}>
          <span className={styles.tileFactLabel}>Archiving</span>
          {tile.archiving.state === "Unknown" ? (
            <BadgeBoolean />
          ) : (
            <BadgeBoolean value={tile.archiving.state === "Archiving"} />
          )}
        </span>
        <span
          className={styles.tileFact}
          title={lastBackup ? `Last successful backup ${lastBackup.toISOString()}` : "No successful backup"}
        >
          <span className={styles.tileFactLabel}>Backup</span>
          <MaybeLink
            to={backupsUrl}
            className={[styles.tileDoor, tile.backupOverdue ? styles.warningText : ""].join(" ").trim()}
            data-testid={`cnpg-overview-door-backups-${tile.namespace}-${tile.name}`}
            onClick={stop}
          >
            {lastBackup ? <ReactiveDuration timestamp={lastBackup.toISOString()} /> : "none"}
          </MaybeLink>
        </span>
      </span>
      <span className={styles.tileFooter}>
        <span className={certificate.className}>{certificate.text}</span>
        {tile.declaredFailed > 0 ? (
          <span
            className={styles.errorText}
            title="Declared databases, roles, publications or subscriptions PostgreSQL does not have as declared; the cluster drawer says which"
            data-testid={`cnpg-overview-declared-${tile.namespace}-${tile.name}`}
          >
            {tile.declaredFailed} declared {tile.declaredFailed === 1 ? "object" : "objects"} failed
          </span>
        ) : null}
        {liveUrl ? (
          <MaybeLink
            to={liveUrl}
            className={styles.tileDoor}
            title="Sessions, replication lag, WAL and databases right now"
            data-testid={`cnpg-overview-door-live-${tile.namespace}-${tile.name}`}
            onClick={stop}
          >
            live view
          </MaybeLink>
        ) : null}
        {tile.nextScheduledBackup ? (
          <MaybeLink
            to={scheduleUrl}
            className={styles.tileDoor}
            title={`${tile.nextScheduleName ?? "schedule"}: ${tile.nextScheduledBackup.toISOString()}`}
            data-testid={`cnpg-overview-door-schedule-${tile.namespace}-${tile.name}`}
            onClick={stop}
          >
            {/* A time to come, not a time gone by: the host's duration component only counts up from the past. */}
            {tile.scheduledBackupSuspended
              ? "schedule suspended"
              : `next backup ${humanizeRelative(tile.nextScheduledBackup, new Date())}`}
          </MaybeLink>
        ) : null}
      </span>
    </div>
  );
}
