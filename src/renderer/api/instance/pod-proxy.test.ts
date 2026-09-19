/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it, vi } from "vitest";
import {
  classifyAnswer,
  createPodProxyClient,
  failureSentence,
  metricsScheme,
  podProxyPath,
  poolerMetricsScheme,
  statusScheme,
} from "./pod-proxy";

import type { FetchLike } from "./pod-proxy";

const STATUS_BODY = JSON.stringify({ isPrimary: true, pod: { metadata: { name: "pg-1" } }, currentLsn: "0/1" });

function answer(status: number, body: string) {
  return { status, text: async () => body };
}

/** A fetch that answers by scheme: the key is "http" or "https". */
function fetchByScheme(table: Record<string, () => Promise<{ status: number; text(): Promise<string> }>>) {
  const calls: string[] = [];
  const impl: FetchLike = (url) => {
    calls.push(url);
    const scheme = url.includes("/pods/https:") ? "https" : "http";
    return table[scheme]();
  };
  return { impl, calls };
}

describe("paths and schemes", () => {
  it("builds the pod proxy path behind the host cluster proxy", () => {
    expect(podProxyPath("db", "pg-1", "https", 8000, "/pg/status")).toBe(
      "/api-kube/api/v1/namespaces/db/pods/https:pg-1:8000/proxy/pg/status",
    );
    expect(podProxyPath("db", "pg-1", "http", 9187, "/metrics")).toBe(
      "/api-kube/api/v1/namespaces/db/pods/http:pg-1:9187/proxy/metrics",
    );
  });

  it("reads the status scheme from the postgres container and the metrics scheme from the cluster", () => {
    const tls = { spec: { containers: [{ name: "postgres", command: ["/controller/manager", "--status-port-tls"] }] } };
    const plain = { spec: { containers: [{ name: "postgres", command: ["/controller/manager"] }] } };
    const sidecar = { spec: { containers: [{ name: "other", command: ["--status-port-tls"] }] } };
    expect(statusScheme(tls)).toBe("https");
    expect(statusScheme(plain)).toBe("http");
    expect(statusScheme(sidecar)).toBe("http");
    expect(statusScheme(undefined)).toBe("http");
    expect(metricsScheme({ spec: { monitoring: { tls: { enabled: true } } } })).toBe("https");
    expect(metricsScheme({ spec: {} })).toBe("http");
    expect(poolerMetricsScheme({ spec: { monitoring: { tls: { enabled: true } } } })).toBe("https");
    expect(poolerMetricsScheme({})).toBe("http");
  });
});

describe("classifyAnswer and failureSentence", () => {
  const target = { namespace: "db", pod: "pg-1", port: 8000 };

  it("maps the answers of the API server to the failure table", () => {
    expect(classifyAnswer(403, "forbidden").kind).toBe("forbidden");
    expect(classifyAnswer(401, "").kind).toBe("forbidden");
    expect(classifyAnswer(503, "error trying to reach service: dial tcp: connection refused").kind).toBe("unreachable");
    expect(classifyAnswer(502, "tls: first record does not look like a TLS handshake").kind).toBe("scheme");
    expect(classifyAnswer(400, "Client sent an HTTP request to an HTTPS server").kind).toBe("scheme");
    // As observed on the E2E cluster: a bare 400 for http on the TLS status port.
    expect(classifyAnswer(400, "").kind).toBe("scheme");
  });

  it("says what failed and what it needs", () => {
    expect(failureSentence({ kind: "forbidden" }, target)).toBe('Reading live data needs "get" on "pods/proxy" in db');
    expect(failureSentence({ kind: "unreachable" }, target)).toContain("pg-1 does not answer");
    expect(failureSentence({ kind: "scheme" }, target)).toBe("Neither http nor https worked on port 8000 of pg-1");
    expect(failureSentence({ kind: "timeout" }, target)).toBe("No answer from pg-1 within 5 s");
    expect(failureSentence({ kind: "parse" }, { ...target, version: "1.31.0" })).toContain("instance manager 1.31.0");
  });
});

describe("createPodProxyClient", () => {
  it("only ever issues GET on the three read endpoints", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const client = createPodProxyClient({
      fetch: async (url, init) => {
        seen.push({ url, method: init.method });
        return answer(200, url.endsWith("/metrics") ? "up 1\n" : STATUS_BODY);
      },
    });
    await client.getStatus("db", "pg-1", "https");
    await client.getMetrics("db", "pg-1", "http");
    await client.getPoolerMetrics("db", "pg-pooler-abc", "http");
    expect(seen).toEqual([
      { url: "/api-kube/api/v1/namespaces/db/pods/https:pg-1:8000/proxy/pg/status", method: "GET" },
      { url: "/api-kube/api/v1/namespaces/db/pods/http:pg-1:9187/proxy/metrics", method: "GET" },
      { url: "/api-kube/api/v1/namespaces/db/pods/http:pg-pooler-abc:9127/proxy/metrics", method: "GET" },
    ]);
    expect(Object.keys(client).sort()).toEqual(["getMetrics", "getPoolerMetrics", "getStatus"]);
  });

  it("returns the parsed status with the scheme that worked", async () => {
    const { impl } = fetchByScheme({ https: async () => answer(200, STATUS_BODY) });
    const result = await createPodProxyClient({ fetch: impl }).getStatus("db", "pg-1", "https");
    expect(result).toMatchObject({ ok: true, scheme: "https", value: { isPrimary: true, currentLsn: "0/1" } });
  });

  it("retries once with the other scheme and remembers the answer for the pod", async () => {
    const { impl, calls } = fetchByScheme({
      https: async () => answer(502, "tls: first record does not look like a TLS handshake"),
      http: async () => answer(200, STATUS_BODY),
    });
    const client = createPodProxyClient({ fetch: impl });
    expect(await client.getStatus("db", "pg-1", "https")).toMatchObject({ ok: true, scheme: "http" });
    expect(await client.getStatus("db", "pg-1", "https")).toMatchObject({ ok: true, scheme: "http" });
    expect(calls.map((url) => (url.includes("https:") ? "https" : "http"))).toEqual(["https", "http", "http"]);
  });

  it("does not try the other scheme when the permission is missing", async () => {
    const { impl, calls } = fetchByScheme({ https: async () => answer(403, "pods/proxy is forbidden") });
    const result = await createPodProxyClient({ fetch: impl }).getStatus("db", "pg-1", "https");
    expect(result).toMatchObject({ ok: false, failure: { kind: "forbidden", status: 403 } });
    expect(calls).toHaveLength(1);
  });

  it("reports scheme when both schemes fail on the handshake, unreachable when the pod is down", async () => {
    const both = fetchByScheme({
      https: async () => answer(502, "tls: handshake failure"),
      http: async () => answer(400, "Client sent an HTTP request to an HTTPS server"),
    });
    expect(await createPodProxyClient({ fetch: both.impl }).getMetrics("db", "pg-1", "https")).toMatchObject({
      ok: false,
      failure: { kind: "scheme" },
    });

    const down = fetchByScheme({
      https: async () => answer(503, "dial tcp 10.0.0.1:8000: connect: connection refused"),
      http: async () => answer(503, "dial tcp 10.0.0.1:8000: connect: connection refused"),
    });
    expect(await createPodProxyClient({ fetch: down.impl }).getStatus("db", "pg-1", "https")).toMatchObject({
      ok: false,
      failure: { kind: "unreachable", status: 503 },
    });
  });

  it("turns a thrown fetch into unreachable and an abort into timeout", async () => {
    const thrown = createPodProxyClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await thrown.getStatus("db", "pg-1", "https")).toMatchObject({
      ok: false,
      failure: { kind: "unreachable" },
    });

    vi.useFakeTimers();
    try {
      const hanging = createPodProxyClient({
        timeoutMs: 5000,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      });
      const pending = hanging.getStatus("db", "pg-1", "https");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({ ok: false, failure: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports parse for an answer that is not an instance status", async () => {
    const html = createPodProxyClient({ fetch: async () => answer(200, "<html>hello</html>") });
    expect(await html.getStatus("db", "pg-1", "https")).toMatchObject({ ok: false, failure: { kind: "parse" } });
    const other = createPodProxyClient({ fetch: async () => answer(200, '{"kind":"Status"}') });
    expect(await other.getStatus("db", "pg-1", "https")).toMatchObject({ ok: false, failure: { kind: "parse" } });
  });
});
