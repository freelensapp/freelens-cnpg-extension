/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { isPostgresqlStatus, parseStatusTime, statusPodName } from "./postgresql-status";

describe("isPostgresqlStatus", () => {
  it("accepts the answer of a primary and of a replica, unknown fields included", () => {
    const primary = {
      currentLsn: "0/B000060",
      isPrimary: true,
      pod: { metadata: { name: "e2e-main-1" }, spec: { containers: null }, status: {} },
      replicationInfo: [{ applicationName: "e2e-main-2", syncPriority: "0" }],
      aFieldFromTheFuture: { nested: true },
    };
    const replica = { receivedLsn: "0/B000060", isPrimary: false, pod: { metadata: { name: "e2e-main-2" } } };
    expect(isPostgresqlStatus(primary)).toBe(true);
    expect(isPostgresqlStatus(replica)).toBe(true);
    expect(isPostgresqlStatus(primary) && statusPodName(primary)).toBe("e2e-main-1");
  });

  it("rejects what is not a status", () => {
    expect(isPostgresqlStatus(null)).toBe(false);
    expect(isPostgresqlStatus("<html>502</html>")).toBe(false);
    expect(isPostgresqlStatus({ kind: "Status", code: 403 })).toBe(false);
    expect(isPostgresqlStatus({ isPrimary: "yes", pod: {} })).toBe(false);
    expect(isPostgresqlStatus({ isPrimary: true })).toBe(false);
    expect(isPostgresqlStatus({ isPrimary: true, pod: null })).toBe(false);
  });
});

describe("parseStatusTime", () => {
  it("reads RFC 3339 and treats the infinities and the empty string as never", () => {
    expect(parseStatusTime("2026-09-19T08:02:24.28131Z")?.toISOString()).toBe("2026-09-19T08:02:24.281Z");
    expect(parseStatusTime("-infinity")).toBeUndefined();
    expect(parseStatusTime("infinity")).toBeUndefined();
    expect(parseStatusTime("")).toBeUndefined();
    expect(parseStatusTime(undefined)).toBeUndefined();
    expect(parseStatusTime("yesterday")).toBeUndefined();
  });
});
