/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// One chart of the Trends section (SPEC-0028): the host's `BarChart` for
// the figures per interval, the host's `Chart` as a line for the gauges,
// both on the same time axis, with the series colors read from the theme
// tokens at render. Nothing is decided here: `trends.ts` computed the
// series, this file draws them.

import { Renderer } from "@freelensapp/extensions";
import { themeColor } from "../theme-color";
import { window } from "./trends";

import type { TrendCard, TrendRange } from "./trends";

const {
  Component: { BarChart, Chart, ChartKind },
} = Renderer;

export interface TrendChartProps {
  card: TrendCard;
  range: TrendRange;
  now: number;
  startedAt: number;
}

// The tooltip item of Chart.js v4, as far as the label reads it.
interface TooltipItem {
  dataset: { label?: string };
  parsed: { y: number | null };
}

export function TrendChart({ card, range, now, startedAt }: TrendChartProps) {
  const { minTime, maxTime } = window([], range, now, startedAt);
  const datasets = card.series.map((series) => {
    const color = themeColor(series.token);
    return {
      id: series.id,
      label: series.label,
      borderColor: color,
      data: window(series.points, range, now, startedAt).points,
      ...(series.secondAxis ? { yAxisID: "second" } : {}),
    };
  });
  const label = (item: TooltipItem) => `${item.dataset.label ?? ""}: ${card.format(Number(item.parsed.y ?? 0))}`;
  const textColor = themeColor("--textColorPrimary");
  const gridColor = themeColor("--borderFaintColor");
  const secondAxis = card.series.some((series) => series.secondAxis)
    ? {
        second: {
          position: "right" as const,
          min: 0,
          grid: { display: false },
          ticks: {
            maxTicksLimit: 4,
            color: textColor,
            font: { size: 11 },
            callback: (value: number | string) => card.format(Number(value)),
          },
        },
      }
    : {};

  if (card.kind === "bars") {
    return (
      <BarChart
        data={{ datasets }}
        minTime={minTime}
        maxTime={maxTime}
        showLegend
        options={{
          plugins: { tooltip: { callbacks: { label } } },
          scales: { y: { ticks: { callback: (value: number | string) => card.format(Number(value)) } }, ...secondAxis },
        }}
      />
    );
  }
  return (
    <Chart
      type={ChartKind.LINE}
      showLegend
      data={{
        datasets: datasets.map((dataset) => ({
          ...dataset,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 3,
          borderWidth: 2,
        })),
      }}
      options={{
        maintainAspectRatio: false,
        responsive: true,
        animation: { duration: 0 },
        plugins: {
          legend: { display: false },
          tooltip: { mode: "index", intersect: false, callbacks: { label } },
        },
        scales: {
          x: {
            type: "time",
            min: minTime * 1000,
            max: maxTime * 1000,
            grid: { display: false },
            ticks: { maxTicksLimit: 6, color: textColor, font: { size: 11 }, maxRotation: 0 },
            time: { unit: "minute", displayFormats: { minute: "HH:mm" } },
          },
          y: {
            min: 0,
            grid: { color: gridColor, tickLength: 0 },
            border: { display: false },
            ticks: {
              maxTicksLimit: 5,
              color: textColor,
              font: { size: 11 },
              padding: 8,
              callback: (value: number | string) => card.format(Number(value)),
            },
          },
          ...secondAxis,
        },
      }}
    />
  );
}
