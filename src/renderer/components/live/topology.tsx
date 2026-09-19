/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The replication topology (SPEC-0006 "The page grid"): the primary on the
// left, the other instances on the right, one line each with the sync state
// and the replay lag. A thin shell over `layoutTopology`: the lines live in an
// SVG stretched over the middle column, the cards and the labels are DOM.

import { Renderer } from "@freelensapp/extensions";
import { failureSentence, STATUS_PORT } from "../../api/instance/pod-proxy";
import { exactBytes, formatBytes } from "../bytes";
import { StoreLink } from "../store-link";
import { formatLag } from "./format";
import styles from "./live.module.scss";
import { LINE_BOX_WIDTH, layoutTopology } from "./topology-layout";

import type { LiveEdge, LiveInstance, LiveView } from "./live-model";

const {
  Component: { Badge, WithTooltip },
  K8sApi: { podsStore },
} = Renderer;

const LEVEL_CLASS: Record<LiveEdge["level"], string> = {
  ok: styles.levelOk,
  warning: styles.levelWarning,
  error: styles.levelError,
};

function InstanceCard({ instance, namespace }: { instance: LiveInstance; namespace: string }) {
  const failure = instance.statusFailure
    ? failureSentence(instance.statusFailure, {
        namespace,
        pod: instance.name,
        port: STATUS_PORT,
        version: instance.managerVersion,
      })
    : undefined;

  return (
    <div
      className={[styles.instanceCard, instance.role === "primary" ? styles.primaryCard : ""].join(" ").trim()}
      data-testid={`cnpg-live-instance-${instance.name}`}
      data-role={instance.role}
    >
      <div className={styles.instanceHeader}>
        <span className={styles.instanceName}>
          <StoreLink store={podsStore} name={instance.name} namespace={namespace} />
        </span>
        <Badge
          small
          className={instance.role === "primary" ? "success" : "info"}
          label={instance.role === "unknown" ? "role unknown" : instance.role}
        />
      </div>
      {instance.pending ? <div className={styles.muted}>Waiting for the instance manager</div> : null}
      {failure ? (
        <div className={styles.failure} title={instance.statusFailure?.detail}>
          {failure}
        </div>
      ) : null}
      {instance.postgresDown ? (
        <div className={styles.failure} title={instance.postgresDown}>
          PostgreSQL does not answer on this instance{instance.fenced ? " (fenced)" : ""}
        </div>
      ) : null}
      {!instance.pending && !failure && !instance.postgresDown ? (
        <div className={styles.instanceFacts}>
          <span title={instance.role === "primary" ? "Current write position" : "Last position replayed"}>
            LSN <span className={styles.mono}>{instance.lsn ?? "N/A"}</span>
          </span>
          <span>timeline {instance.timeline ?? "N/A"}</span>
          {instance.node ? (
            <span title="Kubernetes node">
              <WithTooltip>{instance.node}</WithTooltip>
            </span>
          ) : null}
        </div>
      ) : null}
      {instance.flags.length > 0 ? (
        <div className={styles.flags}>
          {instance.flags.map((flag) => (
            <Badge key={flag} small className="warning" label={flag} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EdgeLabel({ edge }: { edge: LiveEdge }) {
  const lagTooltip = [
    `write ${formatLag(edge.writeLagMs)}`,
    `flush ${formatLag(edge.flushLagMs)}`,
    `replay ${formatLag(edge.replayLagMs)}`,
    edge.syncPriority !== undefined ? `sync priority ${edge.syncPriority}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className={[styles.edgeLabel, LEVEL_CLASS[edge.level]].join(" ")}
      data-testid={`cnpg-live-edge-${edge.standby}`}
      data-level={edge.level}
    >
      <span className={styles.edgeState}>{edge.streaming ? (edge.syncState ?? "streaming") : edge.state}</span>
      {edge.streaming ? (
        <>
          <span title={lagTooltip}>lag {formatLag(edge.replayLagMs)}</span>
          {edge.replayBytes !== undefined ? (
            <span title={`${exactBytes(edge.replayBytes)} of WAL still to replay`}>
              {formatBytes(edge.replayBytes)}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export interface TopologyProps {
  view: LiveView;
  namespace: string;
}

export function Topology({ view, namespace }: TopologyProps) {
  const layout = layoutTopology(view.instances, view.edges, view.primary);
  const rows = Math.max(1, layout.rows.length);

  return (
    <div className={styles.topology} data-testid="cnpg-live-topology">
      {view.primaryDisagreement ? <div className={styles.banner}>{view.primaryDisagreement}</div> : null}
      {view.syncWarning ? <div className={styles.banner}>{view.syncWarning}</div> : null}
      {/* Equal rows: the lines are laid out in row units, not in pixels. */}
      <div className={styles.topologyGrid} style={{ gridTemplateRows: `repeat(${rows}, minmax(84px, 1fr))` }}>
        <div className={styles.primaryColumn} style={{ gridRow: `1 / span ${rows}` }}>
          {layout.primary ? (
            <InstanceCard instance={layout.primary} namespace={namespace} />
          ) : (
            <div className={styles.noPrimary}>No instance says it is the primary</div>
          )}
        </div>
        <svg
          className={styles.lines}
          style={{ gridRow: `1 / span ${rows}` }}
          viewBox={`0 0 ${LINE_BOX_WIDTH} ${layout.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.lines.map((line) => (
            <line
              key={line.standby}
              x1={0}
              y1={line.y1}
              x2={LINE_BOX_WIDTH}
              y2={line.y2}
              className={[styles.line, LEVEL_CLASS[line.level], line.streaming ? "" : styles.lineBroken]
                .join(" ")
                .trim()}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {layout.rows.map((row, index) => [
          <div key={`edge-${row.instance.name}`} className={styles.edgeCell} style={{ gridRow: index + 1 }}>
            {row.edge && layout.primary ? <EdgeLabel edge={row.edge} /> : null}
          </div>,
          <div key={`card-${row.instance.name}`} className={styles.rowCard} style={{ gridRow: index + 1 }}>
            <InstanceCard instance={row.instance} namespace={namespace} />
          </div>,
        ])}
        {layout.rows.length === 0 && layout.primary ? (
          <div className={styles.rowCard} style={{ gridRow: 1 }}>
            <div className={styles.muted}>A single instance: no standby to replicate to</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
