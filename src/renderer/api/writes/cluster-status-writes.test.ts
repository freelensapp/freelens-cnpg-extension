/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it, vi } from "vitest";
import {
  clusterStatusPath,
  primaryRestartBody,
  requestPrimaryRestart,
  requestSwitchover,
  switchoverBody,
} from "./cluster-status-writes";

import type { ClusterRef, PatchFetch } from "./cluster-status-writes";

const REF: ClusterRef = { namespace: "db", name: "pg", resourceVersion: "194768" };
const TIMESTAMP = "2026-09-20T17:14:34.050000Z";

function answering(status: number, text = "{}") {
  return vi.fn<PatchFetch>(async () => ({ status, text: async () => text }));
}

describe("the path", () => {
  it("is the status subresource of the cluster, behind the host's cluster proxy", () => {
    expect(clusterStatusPath("db", "pg")).toBe("/api-kube/apis/postgresql.cnpg.io/v1/namespaces/db/clusters/pg/status");
  });
});

describe("the bodies", () => {
  it("asks for a switchover with the four fields and the resource version, and no conditions", () => {
    expect(switchoverBody(REF, "pg-2", TIMESTAMP)).toEqual({
      metadata: { resourceVersion: "194768" },
      status: {
        targetPrimary: "pg-2",
        targetPrimaryTimestamp: TIMESTAMP,
        phase: "Switchover in progress",
        phaseReason: "Switching over to pg-2",
      },
    });
  });

  it("asks for the in-place restart of the primary with the two constants", () => {
    expect(primaryRestartBody(REF)).toEqual({
      metadata: { resourceVersion: "194768" },
      status: { phase: "Primary instance is being restarted in-place", phaseReason: "Requested by the user" },
    });
  });

  it("never carries status.conditions", () => {
    for (const body of [switchoverBody(REF, "pg-2", TIMESTAMP), primaryRestartBody(REF)]) {
      expect(Object.keys(body.status as Record<string, unknown>)).not.toContain("conditions");
    }
  });
});

describe("the request", () => {
  it("is a merge patch", async () => {
    const fetchLike = answering(200);
    await requestSwitchover(REF, "pg-2", TIMESTAMP, fetchLike);
    const [url, init] = fetchLike.mock.calls[0];
    expect(url).toBe(clusterStatusPath("db", "pg"));
    expect(init.method).toBe("PATCH");
    expect(init.headers["content-type"]).toBe("application/merge-patch+json");
    expect(JSON.parse(init.body)).toEqual(switchoverBody(REF, "pg-2", TIMESTAMP));
  });

  it("sends the restart body on the same path", async () => {
    const fetchLike = answering(200);
    await requestPrimaryRestart(REF, fetchLike);
    const [url, init] = fetchLike.mock.calls[0];
    expect(url).toBe(clusterStatusPath("db", "pg"));
    expect(JSON.parse(init.body)).toEqual(primaryRestartBody(REF));
  });

  it("rejects with the Status of the API server on a conflict", async () => {
    const status = JSON.stringify({
      kind: "Status",
      code: 409,
      reason: "Conflict",
      message: "the object has been modified",
    });
    await expect(requestSwitchover(REF, "pg-2", TIMESTAMP, answering(409, status))).rejects.toEqual({
      code: 409,
      reason: "Conflict",
      message: "the object has been modified",
    });
  });

  it("rejects with the text when the answer is not JSON", async () => {
    await expect(requestPrimaryRestart(REF, answering(502, "Bad Gateway"))).rejects.toEqual({
      code: 502,
      message: "Bad Gateway",
    });
  });

  it("rejects without a code when the request never got an answer", async () => {
    const failing = vi.fn<PatchFetch>(async () => {
      throw new Error("Failed to fetch");
    });
    await expect(requestPrimaryRestart(REF, failing)).rejects.toEqual({ message: "Failed to fetch" });
  });
});
