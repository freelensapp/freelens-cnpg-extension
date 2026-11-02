/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  CLUSTER_FIELDS,
  COMMON_FIELDS,
  IDLE_CHECK,
  prefixFieldOf,
  readServerAnswer,
  serverCheckBlockReason,
} from "./server-check";

// The answer of the operator's webhook (CNPG 1.30.1) on the lab, verbatim, for min_wal_size 2GB with max_wal_size 1MB.
const WEBHOOK_REFUSAL = {
  kind: "Status",
  apiVersion: "v1",
  metadata: {},
  status: "Failure",
  message:
    'admission webhook "vcluster.cnpg.io" denied the request: Cluster.postgresql.cnpg.io "drtest" is invalid: spec.postgresql.parameters.min_wal_size: Invalid value: "2GB": Invalid vale. Parameter min_wal_size (default 80MB) should be smaller than parameter max_wal_size (default 1GB)',
  reason: "Invalid",
  details: {
    name: "drtest",
    group: "postgresql.cnpg.io",
    kind: "Cluster",
    causes: [
      {
        reason: "FieldValueInvalid",
        message:
          'Invalid value: "2GB": Invalid vale. Parameter min_wal_size (default 80MB) should be smaller than parameter max_wal_size (default 1GB)',
        field: "spec.postgresql.parameters.min_wal_size",
      },
    ],
  },
  code: 422,
};

describe("the server check of a creation form (SPEC-0032)", () => {
  const fieldOf = prefixFieldOf(CLUSTER_FIELDS);

  it("reads a 2xx as valid, about the YAML it was sent", () => {
    expect(readServerAnswer(201, {}, "a: 1")).toEqual({ state: "valid", yaml: "a: 1", causes: [] });
  });

  it("reads a webhook refusal with the path, and the field of the form it belongs to", () => {
    const check = readServerAnswer(422, WEBHOOK_REFUSAL, "y", fieldOf);
    expect(check.state).toBe("refused");
    expect(check.causes).toEqual([
      {
        path: "spec.postgresql.parameters.min_wal_size",
        field: "PostgreSQL parameters",
        message:
          'Invalid value: "2GB": Invalid vale. Parameter min_wal_size (default 80MB) should be smaller than parameter max_wal_size (default 1GB)',
      },
    ]);
  });

  it("reads a name that exists (409) as a refusal about the name, and a 400 without causes in the server's words", () => {
    const exists = readServerAnswer(409, { message: 'clusters "e2e-main" already exists' }, "y", fieldOf);
    expect(exists.state).toBe("refused");
    expect(exists.causes).toEqual([
      { path: "metadata.name", field: "Name", message: 'clusters "e2e-main" already exists' },
    ]);
    expect(readServerAnswer(400, undefined, "y").causes).toEqual([{ message: "The API server answered 400" }]);
  });

  it("leaves a refused permission, no answer or another code unchecked, which does not block", () => {
    for (const [status, why] of [
      [403, "may not ask"],
      [401, "may not ask"],
      [0, "did not answer"],
      [500, "answered 500"],
    ] as const) {
      const check = readServerAnswer(status, { message: "x" }, "y");
      expect(check.state).toBe("unchecked");
      expect(check.message).toContain(why);
      expect(serverCheckBlockReason(check, "y")).toBeUndefined();
    }
  });

  it("blocks OK while checking, on a stale answer and on a refusal; not when idle or valid", () => {
    expect(serverCheckBlockReason(IDLE_CHECK, "y")).toBeUndefined();
    expect(serverCheckBlockReason({ state: "checking", yaml: "y", causes: [] }, "y")).toBe(
      "Checking the form with the API server",
    );
    expect(serverCheckBlockReason({ state: "valid", yaml: "old", causes: [] }, "new")).toBe(
      "Checking the form with the API server",
    );
    expect(serverCheckBlockReason({ state: "valid", yaml: "y", causes: [] }, "y")).toBeUndefined();
    expect(serverCheckBlockReason(readServerAnswer(422, WEBHOOK_REFUSAL, "y", fieldOf), "y")).toBe(
      'The API server refuses it (PostgreSQL parameters): Invalid value: "2GB": Invalid vale. Parameter min_wal_size (default 80MB) should be smaller than parameter max_wal_size (default 1GB)',
    );
  });

  it("maps a path to the longest matching prefix, on dots and indexes only", () => {
    const map = prefixFieldOf([
      ["spec.postgresql", "PostgreSQL"],
      ["spec.postgresql.parameters", "PostgreSQL parameters"],
      ["spec.instances", "Instances"],
    ]);
    expect(map("spec.postgresql.parameters.work_mem")).toBe("PostgreSQL parameters");
    expect(map("spec.postgresql.pg_hba[0]")).toBe("PostgreSQL");
    expect(map("spec.instances")).toBe("Instances");
    expect(map("spec.instancesX")).toBeUndefined();
    expect(prefixFieldOf(COMMON_FIELDS)("metadata.name")).toBe("Name");
    expect(fieldOf("spec.storage.size")).toBe("Storage");
  });
});
