/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One cluster of the Overview grid (SPEC-0004 "Layout" 2): compact, about
// four lines, every figure exact in a tooltip, the whole tile a door to the
// cluster drawer and the namespace badge a door to the namespace filter.

import { Renderer } from "@freelensapp/extensions";
import { InstanceBricks } from "../instance-bricks";
import styles from "./tile-grid.module.scss";

import type { ClusterTile as ClusterTileModel } from "../overview-model";

const {
  Component: { Badge, BadgeBoolean, NamespaceSelectBadge, ReactiveDuration, WithTooltip },
} = Renderer;

function certificateSentence(tile: ClusterTileModel): { text: string; className: string } {
  const horizon = tile.certificateHorizon;
  const date = horizon.earliest?.toISOString().slice(0, 10);
  switch (horizon.state) {
    case "expired":
      return { text: `cert expired (${date})`, className: "error" };
    case "expiring":
      return { text: `cert expires in ${horizon.daysLeft} days`, className: "warning" };
    case "ok":
      return { text: `certs ok until ${date}`, className: "" };
    default:
      return { text: "cert expiry unknown", className: "" };
  }
}

export interface ClusterTileProps {
  tile: ClusterTileModel;
  onOpen: (tile: ClusterTileModel) => void;
}

export function ClusterTile({ tile, onOpen }: ClusterTileProps) {
  const certificate = certificateSentence(tile);
  const lastBackup = tile.backups.lastSuccessful;
  const attention = tile.health.state === "Degraded" || tile.health.state === "Failed";

  return (
    <button
      type="button"
      className={[styles.clusterTile, attention ? styles.attention : ""].join(" ").trim()}
      onClick={() => onOpen(tile)}
      data-testid={`cnpg-overview-tile-${tile.namespace}-${tile.name}`}
      data-state={tile.health.state}
    >
      <span className={styles.tileHeader}>
        <span
          className={styles.tileNamespace}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <NamespaceSelectBadge namespace={tile.namespace} />
        </span>
        <span className={styles.tileName} title={`${tile.namespace}/${tile.name}`}>
          {tile.name}
        </span>
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
          {lastBackup ? (
            <span className={tile.backupOverdue ? styles.warningText : ""}>
              <ReactiveDuration timestamp={lastBackup.toISOString()} />
            </span>
          ) : (
            <span className={tile.backupOverdue ? styles.warningText : ""}>none</span>
          )}
        </span>
      </span>
      <span className={styles.tileFooter}>
        <span
          className={
            certificate.className === "error"
              ? styles.errorText
              : certificate.className === "warning"
                ? styles.warningText
                : ""
          }
        >
          {certificate.text}
        </span>
        {tile.nextScheduledBackup ? (
          <span title={tile.nextScheduledBackup.toISOString()}>
            {tile.scheduledBackupSuspended ? "schedule suspended" : "next backup "}
            {tile.scheduledBackupSuspended ? (
              ""
            ) : (
              <ReactiveDuration timestamp={tile.nextScheduledBackup.toISOString()} />
            )}
          </span>
        ) : null}
      </span>
    </button>
  );
}
