/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  collisionWarning,
  createLine,
  defaultNamespace,
  dnsLabelError,
  duplicateKeys,
  firstError,
  identifierError,
  imageReferenceError,
  integerError,
  keyValueObject,
  labelKeyError,
  labelValueError,
  objectNameError,
  parameterKeyError,
  parameterValueError,
  postgresMemory,
  quantityError,
  quantityValue,
  rfc3339Error,
  toYaml,
} from "./create-forms";

describe("names", () => {
  it("accepts a DNS subdomain and refuses what the API server refuses", () => {
    expect(objectNameError("pg-main")).toBeUndefined();
    expect(objectNameError("pg.main.v1")).toBeUndefined();
    expect(objectNameError("")).toBe("A name is required");
    expect(objectNameError(" pg")).toBe("A name has no blanks around it");
    expect(objectNameError("Pg")).toMatch(/lowercase/);
    expect(objectNameError("-pg")).toMatch(/starts and ends/);
    expect(objectNameError("a".repeat(254))).toBe("A name has 253 characters at most");
    expect(objectNameError(`${"a".repeat(64)}.b`)).toMatch(/lowercase/);
  });

  it("holds a cluster name to a DNS label of the operator's length", () => {
    expect(dnsLabelError("pg-main", 50)).toBeUndefined();
    expect(dnsLabelError("1pg", 50)).toMatch(/starts with a letter/);
    expect(dnsLabelError("pg.main", 50)).toMatch(/dashes/);
    expect(dnsLabelError("a".repeat(51), 50)).toBe("A name has 50 characters at most");
    expect(dnsLabelError("pg-", 50)).toMatch(/ends with a letter or a digit/);
  });

  it("checks a PostgreSQL identifier as the forms accept it", () => {
    expect(identifierError("app")).toBeUndefined();
    expect(identifierError("_x1")).toBeUndefined();
    expect(identifierError("1app", "A database")).toMatch(/does not start with a digit/);
    expect(identifierError("App")).toMatch(/lowercase/);
    expect(identifierError("a".repeat(64))).toBe("A name has 63 bytes at most");
    expect(identifierError("")).toBe("A name is required");
  });
});

describe("quantities", () => {
  it("reads decimal and binary units", () => {
    expect(quantityValue("10Gi")).toBe(10 * 2 ** 30);
    expect(quantityValue("500m")).toBeCloseTo(0.5);
    expect(quantityValue("2")).toBe(2);
    expect(quantityValue("1e3")).toBe(1000);
    expect(quantityValue("1G")).toBe(1e9);
    expect(quantityValue("10 Gi")).toBeUndefined();
    expect(quantityValue("ten")).toBeUndefined();
  });

  it("refuses zero, negatives and words with the reason", () => {
    expect(quantityError("10Gi", "A size")).toBeUndefined();
    expect(quantityError("", "A size")).toBe("A size is required");
    expect(quantityError("0", "A size")).toBe("A size is above zero");
    expect(quantityError("-1Gi", "A size")).toMatch(/Kubernetes quantity such as 10Gi/);
    expect(quantityError("big", "A size", "1Gi")).toBe("A size is a Kubernetes quantity such as 1Gi");
  });

  it("checks whole numbers", () => {
    expect(integerError("3", "Instances", 1)).toBeUndefined();
    expect(integerError("0", "Instances", 1)).toBe("Instances is 1 or more");
    expect(integerError("1.5", "Instances", 1)).toBe("Instances is a whole number");
    expect(integerError("", "Instances", 1)).toBe("Instances is required");
  });

  it("reads PostgreSQL memory settings, bare numbers as 8 kB blocks", () => {
    expect(postgresMemory("256MB")).toEqual({ bytes: 256 * 1024 ** 2, bare: false });
    expect(postgresMemory("1GB")).toEqual({ bytes: 1024 ** 3, bare: false });
    expect(postgresMemory("16384")).toEqual({ bytes: 16384 * 8192, bare: true });
    expect(postgresMemory("256 MB")).toEqual({ bytes: 256 * 1024 ** 2, bare: false });
    expect(postgresMemory("256Mi")).toBeUndefined();
  });
});

describe("image references", () => {
  it("wants a tag that reads as a PostgreSQL version", () => {
    expect(imageReferenceError("ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie")).toBeUndefined();
    expect(imageReferenceError("postgres:17.2")).toBeUndefined();
    expect(imageReferenceError("registry:5000/pg:16")).toBeUndefined();
    expect(imageReferenceError("ghcr.io/cloudnative-pg/postgresql:latest")).toMatch(/refuses the tag latest/);
    expect(imageReferenceError("ghcr.io/cloudnative-pg/postgresql@sha256:abc")).toMatch(/digest alone/);
    expect(imageReferenceError("ghcr.io/cloudnative-pg/postgresql")).toMatch(/needs a tag/);
    expect(imageReferenceError("ghcr.io/cloudnative-pg/postgresql:trixie")).toMatch(
      /start with the PostgreSQL version/,
    );
    expect(imageReferenceError("")).toBe("An image is required");
    expect(imageReferenceError("a b:17")).toBe("An image reference has no blanks");
  });
});

describe("timestamps", () => {
  it("wants RFC 3339", () => {
    expect(rfc3339Error("2026-09-22T10:30:00Z")).toBeUndefined();
    expect(rfc3339Error("2026-09-22T10:30:00.5+02:00")).toBeUndefined();
    expect(rfc3339Error("2026-09-22 10:30", "A target time")).toMatch(/RFC 3339/);
    expect(rfc3339Error("2026-13-45T10:30:00Z")).toBe("A time is not a real date");
    expect(rfc3339Error("")).toBe("A time is required");
  });
});

describe("PostgreSQL parameters", () => {
  it("refuses what the operator fixes and malformed names", () => {
    expect(parameterKeyError("shared_buffers")).toBeUndefined();
    expect(parameterKeyError("pg_stat_statements.max")).toBeUndefined();
    expect(parameterKeyError("port")).toBe("port is fixed by the operator and cannot be set");
    expect(parameterKeyError("ssl_cert_file")).toMatch(/fixed by the operator/);
    expect(parameterKeyError("a.b.c")).toMatch(/at most one dot/);
    expect(parameterKeyError("")).toBe("A parameter needs a name");
  });

  it("checks the values the webhook checks", () => {
    expect(parameterValueError("wal_level", "logical")).toBeUndefined();
    expect(parameterValueError("wal_level", "minimal", 1)).toBeUndefined();
    expect(parameterValueError("wal_level", "minimal", 3)).toMatch(/more than one instance/);
    expect(parameterValueError("wal_level", "archive")).toBe("wal_level is logical, replica or minimal");
    expect(parameterValueError("shared_buffers", "256MB")).toBeUndefined();
    expect(parameterValueError("shared_buffers", "lots")).toMatch(/memory setting/);
    expect(parameterValueError("wal_log_hints", "maybe")).toBe("wal_log_hints is on or off");
    expect(parameterValueError("wal_log_hints", "off", 3)).toMatch(/stay on/);
    expect(parameterValueError("work_mem", "")).toBe("A parameter needs a value");
    expect(parameterValueError("work_mem", "64MB")).toBeUndefined();
  });

  it("turns rows into the object and finds duplicates", () => {
    expect(
      keyValueObject([
        { key: "a", value: "1" },
        { key: " ", value: "x" },
        { key: "b", value: "" },
      ]),
    ).toEqual({
      a: "1",
      b: "",
    });
    expect(keyValueObject([])).toBeUndefined();
    expect([
      ...duplicateKeys([
        { key: "a", value: "1" },
        { key: "a", value: "2" },
        { key: "b", value: "" },
      ]),
    ]).toEqual(["a"]);
  });
});

describe("labels", () => {
  it("checks keys and values as Kubernetes does", () => {
    expect(labelKeyError("topology.kubernetes.io/zone")).toBeUndefined();
    expect(labelKeyError("disk")).toBeUndefined();
    expect(labelKeyError("")).toBe("A key is required");
    expect(labelKeyError("a/b/c")).toBe("A key has at most one slash");
    expect(labelKeyError("Bad_/x")).toMatch(/prefix/);
    expect(labelKeyError("-x")).toMatch(/63 characters/);
    expect(labelValueError("")).toBeUndefined();
    expect(labelValueError("ssd")).toBeUndefined();
    expect(labelValueError("a b")).toMatch(/63 characters/);
  });
});

describe("yaml and lines", () => {
  it("serializes the body in its own key order without references", () => {
    const yaml = toYaml({
      apiVersion: "v1",
      kind: "X",
      metadata: { name: "a", namespace: "b" },
      spec: { instances: 3 },
    });
    expect(yaml).toBe("apiVersion: v1\nkind: X\nmetadata:\n  name: a\n  namespace: b\nspec:\n  instances: 3\n");
  });

  it("spells the create line with placeholders while the form is empty", () => {
    expect(createLine("Cluster", "db", "pg", "3 instances")).toBe("create Cluster db/pg: 3 instances");
    expect(createLine("Cluster", "", "", "")).toBe("create Cluster <namespace>/<name>");
  });

  it("finds the first error in reading order and the default namespace", () => {
    expect(firstError(["a", "b"], { b: "second", a: undefined })).toBe("second");
    expect(firstError(["a"], {})).toBeUndefined();
    expect(defaultNamespace(["db"])).toBe("db");
    expect(defaultNamespace(["db", "other"])).toBe("");
    expect(collisionWarning("cluster", "pg", ["pg"])).toMatch(/already exists/);
    expect(collisionWarning("cluster", "pg", ["other"])).toBeUndefined();
  });
});
