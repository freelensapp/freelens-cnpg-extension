/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The subset of the Prometheus text exposition format the live view reads from
// the instance metrics exporter (SPEC-0001 R6, A4): one sample per line,
// `name{label="value",...} value [timestamp]`, comments skipped, label values
// with escaped quotes, backslashes and newlines, `NaN`, `+Inf` and `-Inf`,
// scientific notation. Histograms and summaries need nothing more: their
// series are plain samples too.

export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseValue(text: string): number | undefined {
  switch (text) {
    case "NaN":
      return Number.NaN;
    case "+Inf":
    case "Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    default: {
      if (text === "") return undefined;
      const value = Number(text);
      return Number.isNaN(value) ? undefined : value;
    }
  }
}

function unescapeLabel(value: string): string {
  return value.replace(/\\(["\\n])/g, (_, escaped: string) => (escaped === "n" ? "\n" : escaped));
}

/** Parses `a="x",b="y"` starting after the opening brace; returns the labels and where the closing brace is. */
function parseLabels(line: string, start: number): { labels: Record<string, string>; end: number } | undefined {
  const labels: Record<string, string> = {};
  let i = start;
  while (i < line.length) {
    while (line[i] === " " || line[i] === ",") i += 1;
    if (line[i] === "}") return { labels, end: i };
    const equals = line.indexOf("=", i);
    if (equals < 0 || line[equals + 1] !== '"') return undefined;
    const key = line.slice(i, equals).trim();
    let j = equals + 2;
    while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) return undefined;
    labels[key] = unescapeLabel(line.slice(equals + 2, j));
    i = j + 1;
  }
  return undefined;
}

/** Every sample of the text; malformed lines are skipped, never thrown on. */
export function parsePrometheusText(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const brace = line.indexOf("{");
    const space = line.indexOf(" ");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (brace >= 0 && (space < 0 || brace < space)) {
      const parsed = parseLabels(line, brace + 1);
      if (!parsed) continue;
      name = line.slice(0, brace).trim();
      labels = parsed.labels;
      rest = line.slice(parsed.end + 1).trim();
    } else {
      if (space < 0) continue;
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }

    // An optional timestamp follows the value: the view has no use for it.
    const value = parseValue(rest.split(/\s+/)[0] ?? "");
    if (!name || value === undefined) continue;
    samples.push({ name, labels, value });
  }
  return samples;
}

/** The samples of one series, optionally narrowed to the given label values. */
export function selectSamples(
  samples: readonly MetricSample[],
  name: string,
  labels: Record<string, string> = {},
): MetricSample[] {
  const wanted = Object.entries(labels);
  return samples.filter(
    (sample) => sample.name === name && wanted.every(([key, value]) => sample.labels[key] === value),
  );
}

/** The value of a series that has one sample; `undefined` when absent or NaN. */
export function singleValue(
  samples: readonly MetricSample[],
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const value = selectSamples(samples, name, labels)[0]?.value;
  return value === undefined || Number.isNaN(value) ? undefined : value;
}
