/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  canPausePooler,
  canResumePooler,
  connectedClientsWords,
  pausePoolerFacts,
  poolerPausePatch,
  poolerPauseState,
  resumePoolerFacts,
} from "./pooler-pause";

const POOLER = {
  name: "e2e-main-pooler-rw",
  namespace: "cnpg-e2e",
  cluster: "e2e-main",
  paused: false,
  phase: "active",
};

describe("pause and resume of a pooler (SPEC-0037)", () => {
  it("reads the state from the spec and the phase the operator reports", () => {
    expect(poolerPauseState(POOLER)).toBe("running");
    expect(poolerPauseState({ ...POOLER, paused: true })).toBe("pausing");
    expect(poolerPauseState({ ...POOLER, paused: true, phase: "paused" })).toBe("paused");
    expect(poolerPauseState({ ...POOLER, phase: "paused" })).toBe("resuming");
  });

  it("offers pause on a running pooler and resume on a paused one", () => {
    expect(canPausePooler(POOLER).enabled).toBe(true);
    expect(canResumePooler(POOLER)).toEqual({ enabled: false, reason: "The pooler is not paused" });
    expect(canPausePooler({ ...POOLER, paused: true })).toEqual({
      enabled: false,
      reason: "The pooler is paused already",
    });
    expect(canResumePooler({ ...POOLER, paused: true }).enabled).toBe(true);
  });

  it("sends the value explicitly, and lists the one write", () => {
    expect(poolerPausePatch(true)).toEqual({ spec: { pgbouncer: { paused: true } } });
    expect(poolerPausePatch(false)).toEqual({ spec: { pgbouncer: { paused: false } } });
    expect(pausePoolerFacts(POOLER).writes).toEqual([
      { verb: "patch", text: "patch Pooler cnpg-e2e/e2e-main-pooler-rw: spec.pgbouncer.paused false -> true" },
    ]);
    expect(resumePoolerFacts({ ...POOLER, paused: true }).writes[0].text).toBe(
      "patch Pooler cnpg-e2e/e2e-main-pooler-rw: spec.pgbouncer.paused true -> false",
    );
    expect(pausePoolerFacts(POOLER).notes.join(" ")).toContain("clients stay connected and wait");
  });

  it("says how many clients are connected right now", () => {
    expect(connectedClientsWords(undefined)).toBe("Reading the clients connected through the pooler");
    expect(connectedClientsWords({ active: 0, waiting: 0 })).toBe(
      "No client is connected through the pooler right now.",
    );
    expect(connectedClientsWords({ active: 1, waiting: 0 })).toBe(
      "1 client is connected through the pooler right now (1 active, 0 waiting for a server connection).",
    );
  });
});
