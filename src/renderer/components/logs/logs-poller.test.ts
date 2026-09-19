/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsPoller } from "./logs-poller";

import type { LogsRequest, LogsResult, PodLogsClient } from "../../api/instance/pod-logs";
import type { Visibility } from "../live/live-poller";

function stamped(second: number, message: string): string {
  const stamp = `2026-09-19T14:00:${String(second).padStart(2, "0")}.000000001Z`;
  return `${stamp} {"level":"info","ts":"${stamp}","logger":"instance-manager","msg":"${message}"}`;
}

function visibility(hidden = false): Visibility & { set(value: boolean): void } {
  let current = hidden;
  let listener: (() => void) | undefined;
  return {
    isHidden: () => current,
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    set: (value) => {
      current = value;
      listener?.();
    },
  };
}

describe("LogsPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the tail first, then only what was written since the last line seen, per pod", async () => {
    const requests: LogsRequest[] = [];
    const answers: Record<string, string[]> = {
      "pg-1": [`${stamped(1, "a")}\n${stamped(3, "c")}\n`, `${stamped(3, "c")}\n${stamped(5, "e")}\n`],
      "pg-2": [`${stamped(2, "b")}\n`, ""],
    };
    const client: PodLogsClient = {
      getLogs: async (request): Promise<LogsResult> => {
        requests.push(request);
        return { ok: true, value: answers[request.pod].shift() ?? "" };
      },
    };
    const poller = new LogsPoller({
      client,
      container: "postgres",
      targets: () => [
        { namespace: "db", pod: "pg-1" },
        { namespace: "db", pod: "pg-2" },
      ],
      visibility: visibility(),
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.answered).toBe(true);
    expect(poller.lines.map((line) => line.message)).toEqual(["a", "b", "c"]);
    expect(requests.map((request) => request.sinceTime)).toEqual([undefined, undefined]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(poller.lines.map((line) => line.message)).toEqual(["a", "b", "c", "e"]);
    expect(requests.slice(2).map((request) => `${request.pod}:${request.sinceTime}`)).toEqual([
      "pg-1:2026-09-19T14:00:03.000000001Z",
      "pg-2:2026-09-19T14:00:02.000000001Z",
    ]);
    poller.stop();
  });

  it("stops asking while not following or hidden, and a clear does not bring the old lines back", async () => {
    let calls = 0;
    const client: PodLogsClient = {
      getLogs: async (request): Promise<LogsResult> => {
        calls += 1;
        return { ok: true, value: request.sinceTime ? "" : `${stamped(1, "a")}\n` };
      },
    };
    const window = visibility();
    const poller = new LogsPoller({
      client,
      container: "postgres",
      targets: () => [{ namespace: "db", pod: "pg-1" }],
      visibility: window,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    poller.setFollowing(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);

    poller.clear();
    poller.setFollowing(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(poller.lines).toEqual([]);

    window.set(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    poller.stop();
  });

  it("keeps the lines of the pods that answer when one fails", async () => {
    const client: PodLogsClient = {
      getLogs: async (request): Promise<LogsResult> =>
        request.pod === "pg-2"
          ? { ok: false, failure: { kind: "forbidden", status: 403 } }
          : { ok: true, value: `${stamped(1, "a")}\n` },
    };
    const poller = new LogsPoller({
      client,
      container: "postgres",
      targets: () => [
        { namespace: "db", pod: "pg-1" },
        { namespace: "db", pod: "pg-2" },
      ],
      visibility: visibility(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.lines.map((line) => line.message)).toEqual(["a"]);
    expect([...poller.failures.keys()]).toEqual(["pg-2"]);
    poller.stop();
  });
});
