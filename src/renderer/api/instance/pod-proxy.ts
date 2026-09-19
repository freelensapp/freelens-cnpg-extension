/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The only way the extension talks to an instance (SPEC-0006 "Data access"):
// `GET` on the instance manager status and on the metrics exporter, through
// the API server's pod proxy behind the host's cluster proxy, with the user's
// own credentials (spike S1 of SPEC-0001). The module exposes no generic
// request: the two read endpoints are all it can express, so the action
// endpoints of the instance manager are out of reach by construction.

import { isPostgresqlStatus } from "./postgresql-status";

import type { PostgresqlStatus } from "./postgresql-status";

/** Prefix of the Kubernetes API behind the host's cluster proxy, from the cluster frame. */
export const API_KUBE_PREFIX = "/api-kube";

export const STATUS_PORT = 8000;
export const METRICS_PORT = 9187;
export const REQUEST_TIMEOUT_MS = 5000;

export type ProxyScheme = "http" | "https";

export type ProxyFailureKind = "forbidden" | "unreachable" | "scheme" | "timeout" | "parse";

export interface ProxyFailure {
  kind: ProxyFailureKind;
  /** HTTP status of the last attempt, when there was an answer. */
  status?: number;
  /** What the API server or the runtime said, for the tooltip and the logs. */
  detail?: string;
}

export type ProxyResult<T> = { ok: true; value: T; scheme: ProxyScheme } | { ok: false; failure: ProxyFailure };

/** The slice of `fetch` the client needs, so tests can stand in for it. */
export type FetchLike = (
  url: string,
  init: { method: "GET"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

export function podProxyPath(namespace: string, pod: string, scheme: ProxyScheme, port: number, path: string): string {
  return `${API_KUBE_PREFIX}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${scheme}:${encodeURIComponent(pod)}:${port}/proxy${path}`;
}

interface PodLike {
  spec?: { containers?: Array<{ name?: string; command?: string[]; args?: string[] }> };
}

/** SPEC-0001 A3: the status port speaks TLS when the `postgres` container was started with `--status-port-tls`. */
export function statusScheme(pod: PodLike | undefined): ProxyScheme {
  const container = pod?.spec?.containers?.find((candidate) => candidate.name === "postgres");
  const words = [...(container?.command ?? []), ...(container?.args ?? [])];
  return words.includes("--status-port-tls") ? "https" : "http";
}

/** SPEC-0001 A3: the metrics port speaks TLS when the cluster opted in. */
export function metricsScheme(cluster: { spec?: { monitoring?: { tls?: { enabled?: boolean } } } }): ProxyScheme {
  return cluster.spec?.monitoring?.tls?.enabled ? "https" : "http";
}

// What the API server relays when the scheme is wrong: a TLS handshake against
// a plain port, a plain request against a TLS port (both directions of Go's
// own messages), or bytes that are not HTTP at all.
const SCHEME_HINTS = [
  "tls",
  "http response to https client",
  "http request to an https server",
  "first record does not look like",
  "malformed http",
];

/** What a non-2xx answer of the API server means for the view. */
export function classifyAnswer(status: number, body: string): ProxyFailure {
  const detail = body.trim().slice(0, 300) || undefined;
  if (status === 401 || status === 403) return { kind: "forbidden", status, detail };
  const lower = body.toLowerCase();
  // A plain request against the TLS status port comes back from the API server
  // as a bare 400 (observed on the E2E cluster): nothing else makes a GET on
  // these two endpoints a bad request.
  if (status === 400 || SCHEME_HINTS.some((hint) => lower.includes(hint))) return { kind: "scheme", status, detail };
  return { kind: "unreachable", status, detail };
}

/** The sentence a card shows for a failure (SPEC-0006, the failure table). */
export function failureSentence(
  failure: ProxyFailure,
  target: { namespace: string; pod: string; port: number; version?: string },
): string {
  switch (failure.kind) {
    case "forbidden":
      return `Reading live data needs "get" on "pods/proxy" in ${target.namespace}`;
    case "unreachable":
      return `The instance manager of ${target.pod} does not answer (pod not ready, fenced or restarting)`;
    case "scheme":
      return `Neither http nor https worked on port ${target.port} of ${target.pod}`;
    case "timeout":
      return `No answer from ${target.pod} within ${REQUEST_TIMEOUT_MS / 1000} s`;
    case "parse":
      return `Unexpected answer from ${target.pod}: the instance manager${target.version ? ` ${target.version}` : ""} may be newer than this extension knows`;
  }
}

export interface PodProxyClient {
  getStatus(namespace: string, pod: string, preferred: ProxyScheme): Promise<ProxyResult<PostgresqlStatus>>;
  getMetrics(namespace: string, pod: string, preferred: ProxyScheme): Promise<ProxyResult<string>>;
}

export interface PodProxyClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function createPodProxyClient({
  fetch: fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = REQUEST_TIMEOUT_MS,
}: PodProxyClientOptions = {}): PodProxyClient {
  // The scheme that worked, per pod and port: a pod created by an older
  // operator may disagree with what its cluster declares today.
  const remembered = new Map<string, ProxyScheme>();

  async function attempt(url: string): Promise<{ ok: true; body: string } | { ok: false; failure: ProxyFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json, text/plain, */*" },
      });
      const body = await response.text();
      if (response.status >= 200 && response.status < 300) return { ok: true, body };
      return { ok: false, failure: classifyAnswer(response.status, body) };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, failure: { kind: "timeout" } };
      return { ok: false, failure: { kind: "unreachable", detail: String(error) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(
    namespace: string,
    pod: string,
    port: number,
    path: string,
    preferred: ProxyScheme,
  ): Promise<ProxyResult<string>> {
    const key = `${namespace}/${pod}:${port}`;
    const first = remembered.get(key) ?? preferred;
    const second: ProxyScheme = first === "https" ? "http" : "https";

    const one = await attempt(podProxyPath(namespace, pod, first, port, path));
    if (one.ok) {
      remembered.set(key, first);
      return { ok: true, value: one.body, scheme: first };
    }
    // A missing permission or a timeout says nothing about the scheme.
    if (one.failure.kind === "forbidden" || one.failure.kind === "timeout") return { ok: false, failure: one.failure };

    const two = await attempt(podProxyPath(namespace, pod, second, port, path));
    if (two.ok) {
      remembered.set(key, second);
      return { ok: true, value: two.body, scheme: second };
    }
    if (one.failure.kind === "scheme" && two.failure.kind === "scheme") {
      return { ok: false, failure: { ...two.failure, kind: "scheme" } };
    }
    // Report the attempt on the scheme the pod declares: it is the one that tells the truth about the pod.
    return { ok: false, failure: one.failure.kind === "scheme" ? two.failure : one.failure };
  }

  return {
    async getStatus(namespace, pod, preferred) {
      const result = await get(namespace, pod, STATUS_PORT, "/pg/status", preferred);
      if (!result.ok) return result;
      try {
        const parsed: unknown = JSON.parse(result.value);
        if (isPostgresqlStatus(parsed)) return { ok: true, value: parsed, scheme: result.scheme };
      } catch {
        // Falls through to the parse failure below.
      }
      return { ok: false, failure: { kind: "parse", detail: result.value.slice(0, 300) } };
    },
    getMetrics(namespace, pod, preferred) {
      return get(namespace, pod, METRICS_PORT, "/metrics", preferred);
    },
  };
}
