/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Trends section of the Live View (SPEC-0028): the range control, the
// nine cards over the memory of the poller, each with its last value, its
// chart when there is something to draw and its own non-happy states. The
// cards detail the tiles above them; two carry a door of their own.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import styles from "./live.module.scss";
import { TrendChart } from "./trend-chart";
import { TREND_RANGES, trendCards } from "./trends";

import type { TrendCard, TrendKey, TrendMemory, TrendRange } from "./trends";

const { observer } = MobxReact;

const {
  Component: { MaybeLink, Radio, RadioGroup },
} = Renderer;

export interface TrendsSectionProps {
  memory: TrendMemory;
  now: number;
  /** The intervals of the poller, for the sentence of the header. */
  statusIntervalMs: number;
  metricsIntervalMs: number;
  /** The sentence of the tile that details the same figures, when the primary does not answer. */
  metricsFailure?: string;
  /** Where the title of a card leads, when it does. */
  doors?: Partial<Record<TrendKey, string>>;
}

function pointsOf(card: TrendCard): number {
  return Math.max(0, ...card.series.map((series) => series.points.length));
}

function timeOfDay(time: number): string {
  return `${new Date(time).toISOString().slice(11, 19)} UTC`;
}

interface CardProps {
  card: TrendCard;
  range: TrendRange;
  now: number;
  startedAt: number;
  metricsFailure?: string;
  door?: string;
}

function TrendCardView({ card, range, now, startedAt, metricsFailure, door }: CardProps) {
  const points = pointsOf(card);
  const failure = metricsFailure && card.key !== "lag" ? metricsFailure : undefined;
  return (
    <div
      className={styles.trendCard}
      data-testid={`cnpg-trend-${card.key}`}
      data-points={points}
      data-last={card.last ?? ""}
    >
      <div className={styles.trendHeader}>
        <span className={styles.tileTitle}>
          {door ? (
            <MaybeLink to={door} onClick={(event: React.MouseEvent) => event.stopPropagation()}>
              {card.title}
            </MaybeLink>
          ) : (
            card.title
          )}
        </span>
        <span className={styles.trendLast} title={card.unit}>
          {card.last !== undefined ? <strong>{card.last}</strong> : null}
          <span className={styles.muted}> {card.unit}</span>
        </span>
      </div>
      {failure ? (
        <div className={styles.trendEmpty} data-testid={`cnpg-trend-${card.key}-failure`}>
          {failure}
        </div>
      ) : points < 2 ? (
        <div className={styles.trendEmpty} data-testid={`cnpg-trend-${card.key}-waiting`}>
          {points === 0 && card.series.length === 0
            ? `Needs ${card.needs}, which the primary did not export.`
            : "Waiting for the next sample."}
        </div>
      ) : (
        <div className={styles.trendChart}>
          <TrendChart card={card} range={range} now={now} startedAt={startedAt} />
        </div>
      )}
    </div>
  );
}

export const TrendsSection = observer(
  ({ memory, now, statusIntervalMs, metricsIntervalMs, metricsFailure, doors }: TrendsSectionProps) => {
    const [range, setRange] = React.useState<TrendRange>("15m");
    const cards = trendCards(memory);
    const spanSeconds = TREND_RANGES.find((candidate) => candidate.value === range)?.seconds ?? 0;
    const sampledSeconds = (now - memory.startedAt) / 1000;
    return (
      <div className={styles.trends} data-testid="cnpg-trends">
        <div className={styles.trendsHeader}>
          <span className={styles.tileTitle}>Trends</span>
          <span className={styles.muted} data-testid="cnpg-trends-since">
            since {timeOfDay(memory.startedAt)}, sampled every {statusIntervalMs / 1000} s and every{" "}
            {metricsIntervalMs / 1000} s
            {Number.isFinite(spanSeconds) && sampledSeconds < spanSeconds ? ", showing what was sampled so far" : ""}
          </span>
          <span className={styles.trendsRange} data-testid="cnpg-trends-range">
            <RadioGroup asButtons value={range} onChange={(value: TrendRange) => setRange(value)}>
              {TREND_RANGES.map((candidate) => (
                <Radio key={candidate.value} value={candidate.value} label={candidate.label} />
              ))}
            </RadioGroup>
          </span>
        </div>
        <div className={styles.trendCards}>
          {cards.map((card) => (
            <TrendCardView
              key={card.key}
              card={card}
              range={range}
              now={now}
              startedAt={memory.startedAt}
              metricsFailure={metricsFailure}
              door={doors?.[card.key]}
            />
          ))}
        </div>
      </div>
    );
  },
);
