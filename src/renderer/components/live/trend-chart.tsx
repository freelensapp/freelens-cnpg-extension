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

interface TooltipItem {
  datasetIndex?: number;
  yLabel?: string | number;
}

interface TooltipData {
  datasets?: Array<{ label?: string }>;
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
  const label = (item: TooltipItem, data: TooltipData) =>
    `${data.datasets?.[item.datasetIndex ?? 0]?.label ?? ""}: ${card.format(Number(item.yLabel ?? 0))}`;
  const textColor = themeColor("--textColorPrimary");
  const gridColor = themeColor("--borderFaintColor");
  const secondAxis = card.series.some((series) => series.secondAxis)
    ? [
        {
          id: "second",
          position: "right",
          gridLines: { display: false },
          ticks: {
            min: 0,
            maxTicksLimit: 4,
            fontColor: textColor,
            fontSize: 11,
            callback: (value: number) => card.format(value),
          },
        },
      ]
    : [];

  if (card.kind === "bars") {
    return (
      <BarChart
        data={{ datasets }}
        minTime={minTime}
        maxTime={maxTime}
        showLegend
        options={{
          tooltips: { callbacks: { label } },
          scales: { yAxes: [{ ticks: { callback: (value: number) => card.format(value) } }, ...secondAxis] },
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
          lineTension: 0,
          pointRadius: 0,
          pointHoverRadius: 3,
          borderWidth: 2,
        })),
      }}
      options={{
        maintainAspectRatio: false,
        responsive: true,
        animation: { duration: 0 },
        legend: { display: false },
        tooltips: { mode: "index", intersect: false, callbacks: { label } },
        scales: {
          xAxes: [
            {
              type: "time",
              gridLines: { display: false },
              ticks: {
                min: minTime * 1000,
                max: maxTime * 1000,
                maxTicksLimit: 6,
                fontColor: textColor,
                fontSize: 11,
                maxRotation: 0,
              },
              time: { unit: "minute", displayFormats: { minute: "HH:mm" } },
            },
          ],
          yAxes: [
            {
              gridLines: { color: gridColor, drawBorder: false, tickMarkLength: 0, zeroLineWidth: 0 },
              ticks: {
                min: 0,
                maxTicksLimit: 5,
                fontColor: textColor,
                fontSize: 11,
                padding: 8,
                callback: (value: number) => card.format(value),
              },
            },
            ...secondAxis,
          ],
        },
      }}
    />
  );
}
