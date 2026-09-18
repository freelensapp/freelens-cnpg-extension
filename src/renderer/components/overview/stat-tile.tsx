/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One tile of the Overview summary strip (SPEC-0004 "Layout" 1): a button
// with a big figure, a label and an optional host PieChart. Every tile is a
// door (DESIGN.md section 12): the caller decides where it leads.

import { Renderer } from "@freelensapp/extensions";
import { themeColor } from "../theme-color";
import styles from "./tile-grid.module.scss";

import type { ClusterHealthState } from "../cluster-health";

const {
  Component: { MaybeLink, PieChart },
} = Renderer;

export interface StatTileProps {
  label: string;
  value: string | number;
  detail?: string;
  tooltip?: string;
  /** Applied to the figure: a host status class when the figure demands attention. */
  className?: string;
  /** Where the tile leads (a host route); without it the tile is inert. */
  to?: string;
  "data-testid"?: string;
  children?: React.ReactNode;
}

export function StatTile({ label, value, detail, tooltip, className, to, children, ...rest }: StatTileProps) {
  return (
    <MaybeLink to={to} className={styles.statTile} title={tooltip} data-testid={rest["data-testid"]}>
      <span className={[styles.statValue, className ?? ""].join(" ").trim()}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {detail ? <span className={styles.statDetail}>{detail}</span> : null}
      {children}
    </MaybeLink>
  );
}

const HEALTH_TOKENS: Record<ClusterHealthState, string> = {
  Healthy: "--colorOk",
  Progressing: "--colorWarning",
  Degraded: "--colorWarning",
  Failed: "--colorError",
  Hibernated: "--colorTerminated",
  Unknown: "--colorVague",
};

export interface HealthPieProps {
  byState: Record<ClusterHealthState, number>;
}

/** The fleet by health state, with the host's chart and the theme's status colors. */
export function HealthPie({ byState }: HealthPieProps) {
  const states = (Object.keys(byState) as ClusterHealthState[]).filter((state) => byState[state] > 0);
  if (states.length === 0) return null;

  return (
    <span className={styles.statChart}>
      <PieChart
        // The chart.js types behind the host's ChartData are not resolvable
        // from an extension, hence the cast; the shape is the plain chart.js one.
        data={
          {
            labels: states,
            datasets: [
              {
                id: "cnpg-clusters-by-state",
                data: states.map((state) => byState[state]),
                backgroundColor: states.map((state) => themeColor(HEALTH_TOKENS[state])),
                borderWidth: 0,
              },
            ],
          } as never
        }
        options={{ maintainAspectRatio: false, tooltips: { enabled: false }, animation: { duration: 0 } } as never}
        showLegend={false}
        width={44}
        height={44}
      />
    </span>
  );
}
