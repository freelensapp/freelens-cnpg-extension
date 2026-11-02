/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { belongsTo, cleanObject, referencedObjectStores, reportEvents, reportFileName, reportFiles } from "./report";

import type { ReportObject } from "./report";

const CLUSTER: ReportObject = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: {
    name: "e2e-main",
    namespace: "cnpg-e2e",
    managedFields: [{ manager: "kubectl" }],
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}", keep: "me" },
  },
  spec: {
    instances: 3,
    plugins: [{ name: "barman-cloud.cloudnative-pg.io", parameters: { barmanObjectName: "main-store" } }],
    externalClusters: [{ name: "old", plugin: { parameters: { barmanObjectName: "old-store" } } }],
  },
};

function pod(name: string, cluster = "e2e-main"): ReportObject {
  return {
    kind: "Pod",
    metadata: { name, namespace: "cnpg-e2e", labels: { "cnpg.io/cluster": cluster } },
    spec: {
      containers: [
        {
          name: "postgres",
          env: [
            { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
            { name: "DB_PASSWORD", value: "hunter2" },
            { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "s", key: "t" } } },
          ],
        },
      ],
    },
  };
}

describe("the diagnostic report (SPEC-0038)", () => {
  it("ties objects to the cluster by label, by spec.cluster, by name and by reference", () => {
    expect(belongsTo("pods", pod("e2e-main-1"), CLUSTER)).toBe(true);
    expect(belongsTo("pods", pod("other-1", "other"), CLUSTER)).toBe(false);
    expect(belongsTo("backups", { kind: "Backup", spec: { cluster: { name: "e2e-main" } } }, CLUSTER)).toBe(true);
    expect(belongsTo("failoverquorums", { kind: "FailoverQuorum", metadata: { name: "e2e-main" } }, CLUSTER)).toBe(
      true,
    );
    expect(referencedObjectStores(CLUSTER)).toEqual(["main-store", "old-store"]);
    expect(belongsTo("objectstores", { kind: "ObjectStore", metadata: { name: "old-store" } }, CLUSTER)).toBe(true);
    expect(belongsTo("objectstores", { kind: "ObjectStore", metadata: { name: "else" } }, CLUSTER)).toBe(false);
  });

  it("removes managedFields and the last-applied annotation, and redacts sensitive values", () => {
    const cleaned = cleanObject(CLUSTER);
    expect(cleaned.metadata?.managedFields).toBeUndefined();
    expect(cleaned.metadata?.annotations).toEqual({ keep: "me" });
    expect(CLUSTER.metadata?.managedFields).toBeDefined();
    const env = (cleanObject(pod("e2e-main-1")).spec as { containers: Array<{ env: unknown[] }> }).containers[0].env;
    expect(env).toEqual([
      { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
      { name: "DB_PASSWORD", value: "<redacted>" },
      { name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "s", key: "t" } } },
    ]);
    expect(cleanObject({ kind: "ConfigMap", data: { "api.key": "abc", mode: "x", password: "p" } }).data).toEqual({
      "api.key": "<redacted>",
      mode: "x",
      password: "<redacted>",
    });
  });

  it("keeps the events about the objects of the report only", () => {
    const events = [
      { kind: "Event", involvedObject: { kind: "Pod", name: "e2e-main-1" } },
      { kind: "Event", involvedObject: { kind: "Pod", name: "other-1" } },
      { kind: "Event", involvedObject: { kind: "Cluster", name: "e2e-main" } },
    ];
    expect(reportEvents(events, [CLUSTER, pod("e2e-main-1")])).toHaveLength(2);
  });

  it("lays the archive out in folders, README first, with no secret value anywhere", () => {
    const files = reportFiles({
      cluster: CLUSTER,
      objects: { pods: [pod("e2e-main-2"), pod("e2e-main-1")] },
      events: [{ kind: "Event", involvedObject: { kind: "Pod", name: "e2e-main-1" }, message: "Started" }],
      statuses: [
        { instance: "e2e-main-1", status: { isPrimary: true } },
        { instance: "e2e-main-2", error: "no answer" },
      ],
      logs: [{ pod: "e2e-main-1", text: "line\n" }],
      logLines: 200,
      unreadable: ["jobs: forbidden"],
      generatedAt: new Date("2026-11-02T09:30:14Z"),
      context: "kind-cnpg-e2e",
    });
    expect(files.map((file) => file.path)).toEqual([
      "README.txt",
      "cluster.yaml",
      "pods/e2e-main-1.yaml",
      "pods/e2e-main-2.yaml",
      "events.yaml",
      "status/e2e-main-1.json",
      "status/e2e-main-2.json",
      "logs/e2e-main-1.log",
    ]);
    const readme = files[0].content;
    expect(readme).toContain("Diagnostic report of the CloudNativePG cluster cnpg-e2e/e2e-main");
    expect(readme).toContain("  pods: 2");
    expect(readme).toContain("the last 200 lines of the postgres container of each instance (1)");
    expect(readme).toContain("No Secret was read");
    expect(readme).toContain("  jobs: forbidden");
    expect(files.find((file) => file.path === "status/e2e-main-2.json")?.content).toBe(
      '{\n  "error": "no answer"\n}\n',
    );
    expect(files.some((file) => file.content.includes("hunter2"))).toBe(false);
    expect(files.some((file) => file.path.endsWith(".yaml") && file.content.includes("managedFields"))).toBe(false);
  });

  it("names the file after the cluster, the namespace and the moment", () => {
    expect(reportFileName("cnpg-e2e", "e2e-main", new Date(2026, 10, 2, 10, 30, 14))).toBe(
      "e2e-main-cnpg-e2e-20261102-103014.zip",
    );
  });
});
