/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { createPodLogsClient, logsFailureSentence, podLogsPath } from "./pod-logs";

describe("podLogsPath", () => {
  it("asks for the tail on the first read and for what follows a stamp afterwards", () => {
    expect(podLogsPath({ namespace: "db", pod: "pg-1", container: "postgres" })).toBe(
      "/api-kube/api/v1/namespaces/db/pods/pg-1/log?container=postgres&timestamps=true&limitBytes=2000000&tailLines=500",
    );
    expect(
      podLogsPath({ namespace: "db", pod: "pg-1", container: "postgres", sinceTime: "2026-09-19T14:00:03.000000001Z" }),
    ).toBe(
      "/api-kube/api/v1/namespaces/db/pods/pg-1/log?container=postgres&timestamps=true&limitBytes=2000000&sinceTime=2026-09-19T14%3A00%3A03.000000001Z",
    );
  });
});

describe("createPodLogsClient", () => {
  it("only ever sends a GET, and returns the text", async () => {
    const methods: string[] = [];
    const client = createPodLogsClient({
      fetch: async (_url, init) => {
        methods.push(init.method);
        return { status: 200, text: async () => "line\n" };
      },
    });
    expect(await client.getLogs({ namespace: "db", pod: "pg-1", container: "postgres" })).toEqual({
      ok: true,
      value: "line\n",
    });
    expect(methods).toEqual(["GET"]);
  });

  it("types the failures and words them", async () => {
    const answer = (status: number, body = "") =>
      createPodLogsClient({ fetch: async () => ({ status, text: async () => body }) }).getLogs({
        namespace: "db",
        pod: "pg-1",
        container: "postgres",
      });
    const forbidden = await answer(403, "forbidden");
    expect(forbidden).toMatchObject({ ok: false, failure: { kind: "forbidden", status: 403 } });
    const gone = await answer(404);
    const waiting = await answer(400, 'container "postgres" in pod "pg-1" is waiting to start: PodInitializing');
    const target = { namespace: "db", pod: "pg-1" };
    if (forbidden.ok || gone.ok || waiting.ok) throw new Error("expected failures");
    expect(logsFailureSentence(forbidden.failure, target)).toBe('Reading logs needs "get" on "pods/log" in db');
    expect(logsFailureSentence(gone.failure, target)).toBe("The pod pg-1 is not there (anymore)");
    expect(logsFailureSentence(waiting.failure, target)).toContain("is waiting to start");

    const thrown = await createPodLogsClient({
      fetch: async () => {
        throw new Error("network down");
      },
    }).getLogs({ namespace: "db", pod: "pg-1", container: "postgres" });
    expect(thrown).toMatchObject({ ok: false, failure: { kind: "unreachable" } });
  });
});
