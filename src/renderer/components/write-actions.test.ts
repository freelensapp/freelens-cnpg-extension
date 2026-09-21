/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  apiFailureFacts,
  CONFLICT_ATTEMPTS,
  compactTimestamp,
  disabledGuard,
  enabledGuard,
  failureSentence,
  firstRefusal,
  isAlreadyExists,
  isConflict,
  isReplicaCluster,
  isWebhookUnreachable,
  rfc3339Micro,
  rfc3339Seconds,
  sameWrites,
  subjectOf,
  typedNameMatches,
  writeWithConflictRetry,
} from "./write-actions";

import type { ActionWrite, AttemptedWrite } from "./write-actions";

const NOW = new Date("2026-09-20T17:14:34.050Z");
const PATCH_CLUSTERS: AttemptedWrite = { verb: "patch", resource: "clusters", namespace: "db" };

describe("guards", () => {
  it("returns the first refusal, in order, and skips the absent ones", () => {
    expect(firstRefusal(enabledGuard, undefined, disabledGuard("first"), disabledGuard("second"))).toEqual({
      enabled: false,
      reason: "first",
    });
  });

  it("is enabled when nobody refuses", () => {
    expect(firstRefusal(enabledGuard, undefined)).toEqual({ enabled: true });
    expect(firstRefusal()).toEqual({ enabled: true });
  });
});

describe("timestamps of the upstream tooling", () => {
  it("writes RFC 3339 to the second in UTC", () => {
    expect(rfc3339Seconds(NOW)).toBe("2026-09-20T17:14:34Z");
  });

  it("writes exactly six fractional digits", () => {
    expect(rfc3339Micro(NOW)).toBe("2026-09-20T17:14:34.050000Z");
    expect(rfc3339Micro(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000000Z");
    expect(rfc3339Micro(NOW)).toMatch(/\.\d{6}Z$/);
  });

  it("does not depend on the local zone", () => {
    expect(rfc3339Seconds(new Date("2026-09-20T23:59:59+02:00"))).toBe("2026-09-20T21:59:59Z");
  });

  it("writes the compact suffix of a backup name", () => {
    expect(compactTimestamp(NOW)).toBe("20260920171434");
    expect(compactTimestamp(NOW)).toMatch(/^\d{14}$/);
  });
});

describe("sameWrites", () => {
  const a: ActionWrite[] = [{ verb: "patch", text: "one" }];

  it("compares verb and text, in order", () => {
    expect(sameWrites(a, [{ verb: "patch", text: "one" }])).toBe(true);
    expect(sameWrites(a, [{ verb: "patch", text: "two" }])).toBe(false);
    expect(sameWrites(a, [{ verb: "delete", text: "one" }])).toBe(false);
    expect(sameWrites(a, [...a, ...a])).toBe(false);
    expect(sameWrites([], [])).toBe(true);
  });
});

describe("isReplicaCluster", () => {
  it("is false without a replica stanza and with the stanza disabled", () => {
    expect(isReplicaCluster({ name: "pg" })).toBe(false);
    expect(isReplicaCluster({ name: "pg", spec: {} })).toBe(false);
    expect(isReplicaCluster({ name: "pg", spec: { replica: { enabled: false, primary: "other" } } })).toBe(false);
  });

  it("is true for the standalone form", () => {
    expect(isReplicaCluster({ name: "pg", spec: { replica: { enabled: true } } })).toBe(true);
  });

  it("reads the distributed topology: the primary is another cluster", () => {
    expect(isReplicaCluster({ name: "pg", spec: { replica: { primary: "other", self: "pg" } } })).toBe(true);
    expect(isReplicaCluster({ name: "pg", spec: { replica: { primary: "pg", self: "pg" } } })).toBe(false);
    expect(isReplicaCluster({ name: "pg", spec: { replica: { primary: "other" } } })).toBe(true);
    expect(isReplicaCluster({ name: "pg", spec: { replica: { primary: "pg" } } })).toBe(false);
    expect(isReplicaCluster({ name: "pg", spec: { replica: {} } })).toBe(false);
  });
});

describe("apiFailureFacts", () => {
  it("reads the rejection of the host's Kubernetes client", () => {
    const rejection = {
      error: { kind: "Status", code: 409, reason: "Conflict", message: "the object has been modified" },
      isUsedForNotification: false,
      toString: () => "the object has been modified",
    };
    expect(apiFailureFacts(rejection)).toEqual({
      code: 409,
      reason: "Conflict",
      message: "the object has been modified",
      alreadyNotified: false,
    });
  });

  it("knows when the host has already toasted the error", () => {
    expect(apiFailureFacts({ error: { code: 403 }, isUsedForNotification: true }).alreadyNotified).toBe(true);
  });

  it("falls back to what the error prints", () => {
    expect(apiFailureFacts(new Error("boom")).message).toBe("boom");
    expect(apiFailureFacts({ toString: () => "printed" }).message).toBe("printed");
    expect(apiFailureFacts({}).message).toBeUndefined();
  });

  it("passes its own facts through", () => {
    expect(apiFailureFacts({ code: 422, message: "invalid", reason: "Invalid" })).toMatchObject({
      code: 422,
      message: "invalid",
      reason: "Invalid",
    });
  });

  it("reports nothing rather than throwing on anything else", () => {
    expect(apiFailureFacts(undefined)).toEqual({});
    expect(apiFailureFacts(null)).toEqual({});
    expect(apiFailureFacts(42)).toEqual({});
    expect(apiFailureFacts("plain words")).toEqual({ message: "plain words" });
  });

  it("tells a conflict from a name that exists", () => {
    expect(isConflict({ code: 409, reason: "Conflict" })).toBe(true);
    expect(isConflict({ code: 409 })).toBe(true);
    expect(isConflict({ code: 409, reason: "AlreadyExists" })).toBe(false);
    expect(isAlreadyExists({ code: 409, reason: "AlreadyExists" })).toBe(true);
    expect(isAlreadyExists({ code: 422, reason: "AlreadyExists" })).toBe(false);
  });
});

describe("failureSentence", () => {
  it("names the verb and the resource on 403", () => {
    expect(failureSentence({ code: 403, message: "forbidden: nope" }, PATCH_CLUSTERS)).toBe(
      "Your account may not patch clusters in db. The API server said: forbidden: nope",
    );
  });

  it("says the object is gone on 404", () => {
    expect(failureSentence({ code: 404 }, PATCH_CLUSTERS)).toBe("The object is gone: nothing was written.");
  });

  it("points at the operator when its webhook does not answer", () => {
    const failure = {
      code: 500,
      message:
        'Internal error occurred: failed calling webhook "vcluster.cnpg.io": failed to call webhook: Post "https://cnpg-webhook-service.cnpg-system.svc:443/validate": dial tcp: connect: connection refused',
    };
    expect(isWebhookUnreachable(failure)).toBe(true);
    const sentence = failureSentence(failure, PATCH_CLUSTERS);
    expect(sentence).toContain("The operator may be down: see the Operator page.");
    expect(sentence).toContain("connection refused");
  });

  it("keeps the words of the webhook on 422, because they name the field", () => {
    const message = 'metadata.annotations.cnpg.io/hibernation: Invalid value: "maybe"';
    expect(failureSentence({ code: 422, message }, PATCH_CLUSTERS)).toBe(
      `The API server refused the write as invalid. The API server said: ${message}`,
    );
  });

  it("says nothing was written after a conflict that kept coming", () => {
    expect(failureSentence({ code: 409, reason: "Conflict" }, PATCH_CLUSTERS)).toContain("nothing was written");
  });

  it("covers a request that never got an answer and any other code", () => {
    expect(failureSentence({ message: "Failed to fetch" }, PATCH_CLUSTERS)).toBe(
      "The request did not reach the API server. The API server said: Failed to fetch",
    );
    expect(failureSentence({ code: 500 }, PATCH_CLUSTERS)).toBe("The API server answered 500.");
  });
});

describe("dialog helpers", () => {
  it("spells the subject", () => {
    expect(subjectOf("Cluster", "cnpg-e2e", "e2e-main")).toBe("Cluster cnpg-e2e/e2e-main");
  });

  it("matches the typed name exactly, forgiving only the blanks around it", () => {
    expect(typedNameMatches("e2e-main", "e2e-main")).toBe(true);
    expect(typedNameMatches("  e2e-main ", "e2e-main")).toBe(true);
    expect(typedNameMatches("E2E-main", "e2e-main")).toBe(false);
    expect(typedNameMatches("", "e2e-main")).toBe(false);
    expect(typedNameMatches("", undefined)).toBe(true);
  });
});

describe("writeWithConflictRetry", () => {
  const confirmed = [{ verb: "patch" as const, text: "patch Cluster db/pg (status): targetPrimary pg-1 -> pg-2" }];
  const conflict = { code: 409, reason: "Conflict", message: "the object has been modified" };

  it("writes once when nothing is in the way", async () => {
    let sent = 0;
    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        sent += 1;
      },
      refresh: async () => ({ guard: enabledGuard, writes: [...confirmed] }),
    });

    expect(outcome).toEqual({ kind: "written" });
    expect(sent).toBe(1);
  });

  it("retries a conflict while the lines are the ones the user confirmed", async () => {
    let sent = 0;
    let refreshed = 0;
    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        sent += 1;
        if (sent < 3) throw conflict;
      },
      refresh: async () => {
        refreshed += 1;
        return { guard: enabledGuard, writes: [...confirmed] };
      },
    });

    expect(outcome).toEqual({ kind: "written" });
    expect(sent).toBe(3);
    expect(refreshed).toBe(2);
  });

  it("gives up after the attempts of W6 and reports the conflict", async () => {
    let sent = 0;
    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        sent += 1;
        throw conflict;
      },
      refresh: async () => ({ guard: enabledGuard, writes: [...confirmed] }),
    });

    expect(sent).toBe(CONFLICT_ATTEMPTS);
    expect(outcome).toMatchObject({ kind: "failed", failure: { code: 409 } });
  });

  it("never sends a write the user did not read", async () => {
    let sent = 0;
    const other = [{ verb: "patch" as const, text: "patch Cluster db/pg (status): targetPrimary pg-3 -> pg-2" }];
    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        sent += 1;
        throw conflict;
      },
      refresh: async () => ({ guard: enabledGuard, writes: other }),
    });

    expect(outcome).toEqual({ kind: "changed", writes: other });
    expect(sent).toBe(1);
  });

  it("stops when the guard refuses the object as it is now", async () => {
    const outcome = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        throw conflict;
      },
      refresh: async () => ({ guard: disabledGuard("The cluster is hibernated"), writes: [...confirmed] }),
    });

    expect(outcome).toEqual({ kind: "refused", reason: "The cluster is hibernated" });
  });

  it("retries nothing but a conflict, and reports a refresh that fails", async () => {
    let sent = 0;
    const forbidden = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        sent += 1;
        throw { code: 403, message: "forbidden" };
      },
      refresh: async () => ({ guard: enabledGuard, writes: [...confirmed] }),
    });

    expect(sent).toBe(1);
    expect(forbidden).toMatchObject({ kind: "failed", failure: { code: 403 } });

    const exists = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        throw { code: 409, reason: "AlreadyExists" };
      },
      refresh: async () => ({ guard: enabledGuard, writes: [...confirmed] }),
    });

    expect(exists).toMatchObject({ kind: "failed", failure: { reason: "AlreadyExists" } });

    const gone = await writeWithConflictRetry({
      confirmed,
      send: async () => {
        throw conflict;
      },
      refresh: async () => {
        throw { code: 404, message: "not found" };
      },
    });

    expect(gone).toMatchObject({ kind: "failed", failure: { code: 404 } });
  });
});
