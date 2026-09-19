/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { parsePrometheusText, selectSamples, singleValue } from "./prometheus-text";

// Trimmed from the answer of a primary of the E2E cluster (operator 1.30.0).
const RECORDED = `
# HELP cnpg_backends_total Number of backends
# TYPE cnpg_backends_total gauge
cnpg_backends_total{application_name="cnpg_metrics_exporter",datname="app",state="active",usename="cnpg_metrics_exporter"} 1
cnpg_backends_total{application_name="e2e-main-2",datname="",state="active",usename="streaming_replica"} 1
cnpg_backends_waiting_total 0
cnpg_collector_pg_wal{value="size"} 2.01326592e+08
cnpg_collector_pg_wal{value="volume_size"} NaN
cnpg_collector_postgres_version{cluster="e2e-main",full="18.4"} 18.4
cnpg_pg_database_size_bytes{datname="app"} 8.017599e+06
cnpg_pg_stat_archiver_last_archived_time 1.78980494428131e+09
`;

describe("parsePrometheusText", () => {
  it("reads a recorded answer of the metrics exporter", () => {
    const samples = parsePrometheusText(RECORDED);
    expect(samples).toHaveLength(8);
    expect(samples[0]).toEqual({
      name: "cnpg_backends_total",
      labels: {
        application_name: "cnpg_metrics_exporter",
        datname: "app",
        state: "active",
        usename: "cnpg_metrics_exporter",
      },
      value: 1,
    });
    expect(singleValue(samples, "cnpg_collector_pg_wal", { value: "size" })).toBe(201_326_592);
    expect(singleValue(samples, "cnpg_pg_database_size_bytes", { datname: "app" })).toBe(8_017_599);
    expect(singleValue(samples, "cnpg_backends_waiting_total")).toBe(0);
    expect(selectSamples(samples, "cnpg_backends_total")).toHaveLength(2);
    expect(selectSamples(samples, "cnpg_backends_total", { usename: "streaming_replica" })).toHaveLength(1);
  });

  it("keeps NaN as a sample and hides it from singleValue", () => {
    const samples = parsePrometheusText(RECORDED);
    const [volume] = selectSamples(samples, "cnpg_collector_pg_wal", { value: "volume_size" });
    expect(Number.isNaN(volume.value)).toBe(true);
    expect(singleValue(samples, "cnpg_collector_pg_wal", { value: "volume_size" })).toBeUndefined();
    expect(singleValue(samples, "missing_series")).toBeUndefined();
  });

  it("reads infinities, timestamps and escaped label values", () => {
    const samples = parsePrometheusText(
      [
        'up{quote="say \\"hi\\"",path="C:\\\\data",text="a\\nb"} 1 1758268800000',
        "limit +Inf",
        "floor -Inf",
        'spaced{ a="1", b="2" } 3',
        'comma_inside{list="a,b}c"} 4',
      ].join("\n"),
    );
    expect(samples[0]).toEqual({ name: "up", labels: { quote: 'say "hi"', path: "C:\\data", text: "a\nb" }, value: 1 });
    expect(samples[1].value).toBe(Number.POSITIVE_INFINITY);
    expect(samples[2].value).toBe(Number.NEGATIVE_INFINITY);
    expect(samples[3]).toEqual({ name: "spaced", labels: { a: "1", b: "2" }, value: 3 });
    expect(samples[4]).toEqual({ name: "comma_inside", labels: { list: "a,b}c" }, value: 4 });
  });

  it("skips what is malformed instead of throwing", () => {
    const samples = parsePrometheusText(
      ['broken{a="1" 2', "novalue", 'unterminated{a="1} 2', "text notanumber", "", "ok 5"].join("\n"),
    );
    expect(samples).toEqual([{ name: "ok", labels: {}, value: 5 }]);
  });
});
