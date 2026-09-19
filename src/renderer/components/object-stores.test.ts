/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  classifyStore,
  clustersOfStore,
  oldestRecoveryPoint,
  recoveryWindows,
  storeOfCluster,
  storeProvider,
} from "./object-stores";

import type { ObjectStoreSpec, ObjectStoreStatus } from "../api/barmancloud/object-store-v1";
import type { PluginConfiguration } from "../api/cnpg/cluster-v1";

function makeStore(
  name: string,
  {
    namespace = "db",
    spec = {},
    status,
  }: { namespace?: string; spec?: ObjectStoreSpec; status?: ObjectStoreStatus } = {},
): ObjectStore {
  return new ObjectStore({
    apiVersion: "barmancloud.cnpg.io/v1",
    kind: "ObjectStore",
    metadata: { name, namespace },
    spec: { configuration: { destinationPath: "s3://backups/", s3Credentials: {} }, ...spec },
    status,
  } as never);
}

function makeCluster(name: string, plugins: PluginConfiguration[] | undefined, namespace = "db"): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: { name, namespace },
    spec: { instances: 1, plugins },
  } as never);
}

const barman = (store: string, extra: Partial<PluginConfiguration> = {}, serverName?: string): PluginConfiguration => ({
  name: "barman-cloud.cloudnative-pg.io",
  isWALArchiver: true,
  parameters: serverName ? { barmanObjectName: store, serverName } : { barmanObjectName: store },
  ...extra,
});

describe("storeProvider", () => {
  it("reads the provider from the path and the credentials", () => {
    expect(storeProvider(makeStore("a"))).toBe("S3");
    expect(
      storeProvider(
        makeStore("a", { spec: { configuration: { destinationPath: "s3://b/", endpointURL: "http://minio:9000" } } }),
      ),
    ).toBe("S3 compatible");
    expect(storeProvider(makeStore("a", { spec: { configuration: { destinationPath: "gs://bucket/pg" } } }))).toBe(
      "Google Cloud Storage",
    );
    expect(
      storeProvider(
        makeStore("a", {
          spec: { configuration: { destinationPath: "https://acct.blob.core.windows.net/c", azureCredentials: {} } },
        }),
      ),
    ).toBe("Azure Blob");
    expect(storeProvider(makeStore("a", { spec: { configuration: { destinationPath: "file:///tmp" } } }))).toBe(
      "Unknown",
    );
  });
});

describe("clustersOfStore and storeOfCluster", () => {
  const store = makeStore("main-store");

  it("finds the clusters of the same namespace whose plugin entry names the store", () => {
    const clusters = [
      makeCluster("pg-b", [barman("main-store", { isWALArchiver: false })]),
      makeCluster("pg-a", [barman("main-store", {}, "legacy-name")]),
      makeCluster("other-store", [barman("second-store")]),
      makeCluster("other-namespace", [barman("main-store")], "elsewhere"),
      makeCluster("disabled", [barman("main-store", { enabled: false })]),
      makeCluster("other-plugin", [{ name: "somebody-else", parameters: { barmanObjectName: "main-store" } }]),
      makeCluster("no-plugins", undefined),
    ];
    expect(
      clustersOfStore(store, clusters).map((writer) => [writer.name, writer.serverName, writer.walArchiver]),
    ).toEqual([
      ["pg-a", "legacy-name", true],
      ["pg-b", "pg-b", false],
    ]);
  });

  it("tells which store and server name a cluster writes to", () => {
    expect(storeOfCluster(makeCluster("pg", [barman("main-store")]))).toEqual({
      storeName: "main-store",
      serverName: "pg",
    });
    expect(storeOfCluster(makeCluster("pg", [barman("main-store", {}, "old")]))?.serverName).toBe("old");
    expect(storeOfCluster(makeCluster("pg", undefined))).toBeUndefined();
    expect(storeOfCluster(makeCluster("pg", [barman("main-store", { enabled: false })]))).toBeUndefined();
  });
});

describe("recoveryWindows", () => {
  // As observed on the E2E cluster (plugin 0.15.0).
  const status: ObjectStoreStatus = {
    serverRecoveryWindow: {
      "pg-ok": { firstRecoverabilityPoint: "2026-09-18T16:14:48Z", lastSuccessfulBackupTime: "2026-09-19T08:01:34Z" },
      "pg-broken": { lastFailedBackupTime: "2026-09-18T16:14:46Z" },
      "pg-recovered": {
        firstRecoverabilityPoint: "2026-09-10T00:00:00Z",
        lastSuccessfulBackupTime: "2026-09-19T03:00:00Z",
        lastFailedBackupTime: "2026-09-18T03:00:00Z",
      },
      "pg-regressed": {
        lastSuccessfulBackupTime: "2026-09-17T03:00:00Z",
        lastFailedBackupTime: "2026-09-19T03:00:00Z",
      },
      "pg-deleted": {
        firstRecoverabilityPoint: "2026-08-01T00:00:00Z",
        lastSuccessfulBackupTime: "2026-08-20T00:00:00Z",
      },
      "pg-nothing": {},
    },
  };
  const store = makeStore("main-store", { status });
  const clusters = ["pg-ok", "pg-broken", "pg-recovered", "pg-regressed", "pg-nothing"].map((name) =>
    makeCluster(name, [barman("main-store")]),
  );
  const windows = recoveryWindows(store, clusters);

  it("classifies every server, the failing ones first", () => {
    expect(windows.map((window) => [window.serverName, window.state])).toEqual([
      ["pg-broken", "Failing"],
      ["pg-regressed", "Failing"],
      ["pg-nothing", "Empty"],
      ["pg-deleted", "Protected"],
      ["pg-ok", "Protected"],
      ["pg-recovered", "Protected"],
    ]);
  });

  it("joins a server to its cluster and shows an orphan as such", () => {
    expect(windows.find((window) => window.serverName === "pg-ok")?.cluster?.name).toBe("pg-ok");
    expect(windows.find((window) => window.serverName === "pg-deleted")?.cluster).toBeUndefined();
  });

  it("finds the oldest recovery point of the store", () => {
    expect(oldestRecoveryPoint(windows)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(oldestRecoveryPoint([])).toBeUndefined();
  });

  it("has no window without a status", () => {
    expect(recoveryWindows(makeStore("fresh"), clusters)).toEqual([]);
  });
});

describe("classifyStore", () => {
  it("is Failing when the last backup of a server failed", () => {
    const store = makeStore("s", {
      status: { serverRecoveryWindow: { pg: { lastFailedBackupTime: "2026-09-18T16:14:46Z" } } },
    });
    expect(classifyStore(store, [makeCluster("pg", [barman("s")])])).toMatchObject({
      state: "Failing",
      className: "error",
      reason: "The last backup failed for pg",
    });
  });

  it("is In use with the clusters that write to it", () => {
    const store = makeStore("s");
    expect(
      classifyStore(store, [makeCluster("pg-1", [barman("s")]), makeCluster("pg-2", [barman("s")])]),
    ).toMatchObject({
      state: "In use",
      className: "success",
      reason: "2 clusters: pg-1, pg-2",
    });
  });

  it("is Unused without a writer, and says when the bucket still holds servers", () => {
    expect(classifyStore(makeStore("s"), [])).toMatchObject({ state: "Unused", reason: "No cluster writes here" });
    const orphaned = makeStore("s", {
      status: { serverRecoveryWindow: { gone: { lastSuccessfulBackupTime: "2026-08-20T00:00:00Z" } } },
    });
    expect(classifyStore(orphaned, []).reason).toBe("No cluster writes here; the bucket still holds 1 server");
  });
});
