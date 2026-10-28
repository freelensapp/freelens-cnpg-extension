/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Cluster } from "../api/cnpg/cluster-v1";
import { enabledGuard, writeWithConflictRetry } from "../components/write-actions";
import { clusterReader, liveCluster } from "./cluster-live";

const selfLink = "/apis/postgresql.cnpg.io/v1/namespaces/db/clusters/pg";

function clusterAt(resourceVersion: string, fenced?: string): Cluster {
  return new Cluster({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "pg",
      namespace: "db",
      selfLink,
      resourceVersion,
      annotations: fenced ? { "cnpg.io/fencedInstances": fenced } : {},
    },
  } as never);
}

/**
 * The host's store as the writes meet it: `getByPath` returns what it holds,
 * and `load` of an object it holds returns it without asking the API server,
 * which only `api.get` does.
 */
function storeHolding(held: Cluster, onServer: () => Cluster | null) {
  const get = vi.fn(async (_params: { name: string; namespace?: string }) => onServer());
  const store = {
    getByPath: (path: string) => (path === selfLink ? held : undefined),
    load: vi.fn(async () => held),
    api: { get },
  };
  vi.spyOn(Cluster, "getStore").mockReturnValue(store as never);
  return { store, get };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clusterReader", () => {
  it("starts from the object the store holds", () => {
    const held = clusterAt("10");
    storeHolding(held, () => clusterAt("11"));

    expect(clusterReader(clusterAt("9")).current()).toBe(held);
    expect(liveCluster(clusterAt("9"))).toBe(held);
  });

  it("reads the object again from the API server, and the next attempt uses that read", async () => {
    const held = clusterAt("10");
    const onServer = clusterAt("11");
    const { get } = storeHolding(held, () => onServer);
    const reader = clusterReader(clusterAt("9"));

    expect(await reader.reread()).toBe(onServer);
    expect(get).toHaveBeenCalledWith({ name: "pg", namespace: "db" });
    expect(reader.current()).toBe(onServer);
  });

  it("keeps what it had when the API server returns nothing", async () => {
    const held = clusterAt("10");
    storeHolding(held, () => null);
    const reader = clusterReader(clusterAt("9"));

    expect(await reader.reread()).toBe(held);
    expect(reader.current()).toBe(held);
  });

  it("falls back to the row's object when there is no store", async () => {
    const row = clusterAt("9");
    vi.spyOn(Cluster, "getStore").mockImplementation(() => {
      throw new Error("Store for Cluster is not registered");
    });
    const reader = clusterReader(row);

    expect(reader.current()).toBe(row);
    expect(await reader.reread()).toBe(row);
  });

  // The lift of a fence of 1.0.0 (SPEC-0024, notes): the operator updated the
  // status between the dialog's read and the click; every retry sent the
  // version the store held, which the store's `load` did not refresh, and all
  // three attempts met the same conflict.
  it("gets a write through a conflict when the store still holds the refused version", async () => {
    const held = clusterAt("10", "pg-2");
    const onServer = clusterAt("11", "pg-2");
    storeHolding(held, () => onServer);
    const reader = clusterReader(held);
    const sentWith: string[] = [];
    const lines = (cluster: Cluster) => [
      { verb: "patch" as const, text: `fenced ${cluster.metadata?.annotations?.["cnpg.io/fencedInstances"]}` },
    ];

    const outcome = await writeWithConflictRetry({
      confirmed: lines(reader.current()),
      send: async () => {
        const version = reader.current().metadata?.resourceVersion ?? "";
        sentWith.push(version);
        if (version !== "11") throw { code: 409, reason: "Conflict", message: "the object has been modified" };
      },
      refresh: async () => ({ guard: enabledGuard, writes: lines(await reader.reread()) }),
    });

    expect(outcome).toEqual({ kind: "written" });
    expect(sentWith).toEqual(["10", "11"]);
  });

  it("refuses a retry when the re-read changes the write the user confirmed", async () => {
    const held = clusterAt("10", "pg-2");
    storeHolding(held, () => clusterAt("11", "pg-2,pg-3"));
    const reader = clusterReader(held);
    const lines = (cluster: Cluster) => [
      { verb: "patch" as const, text: `fenced ${cluster.metadata?.annotations?.["cnpg.io/fencedInstances"]}` },
    ];
    let sent = 0;

    const outcome = await writeWithConflictRetry({
      confirmed: lines(reader.current()),
      send: async () => {
        sent += 1;
        throw { code: 409, reason: "Conflict", message: "the object has been modified" };
      },
      refresh: async () => ({ guard: enabledGuard, writes: lines(await reader.reread()) }),
    });

    expect(outcome).toEqual({ kind: "changed", writes: [{ verb: "patch", text: "fenced pg-2,pg-3" }] });
    expect(sent).toBe(1);
  });
});
