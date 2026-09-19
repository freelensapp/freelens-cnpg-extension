/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Kubernetes pod log endpoint, read through the host's cluster proxy
// (SPEC-0018): `GET .../pods/<pod>/log`. It needs "get" on "pods/log" and
// nothing else: no exec, no credential. One method, read-only, with the typed
// failures the live views already use.

import { API_KUBE_PREFIX } from "./pod-proxy";

import type { FetchLike, ProxyFailure } from "./pod-proxy";

export const LOGS_TIMEOUT_MS = 10_000;
export const FIRST_READ_LINES = 500;
/** A ceiling for one answer, so a very chatty instance cannot flood the page. */
export const LIMIT_BYTES = 2_000_000;

export interface LogsRequest {
  namespace: string;
  pod: string;
  container: string;
  /** The first read: the last lines of the container. */
  tailLines?: number;
  /** The reads that follow: what was written from this stamp on. */
  sinceTime?: string;
}

export type LogsResult = { ok: true; value: string } | { ok: false; failure: ProxyFailure };

export function podLogsPath({ namespace, pod, container, tailLines, sinceTime }: LogsRequest): string {
  const query = new URLSearchParams({ container, timestamps: "true", limitBytes: String(LIMIT_BYTES) });
  if (sinceTime) query.set("sinceTime", sinceTime);
  else query.set("tailLines", String(tailLines ?? FIRST_READ_LINES));
  return `${API_KUBE_PREFIX}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query.toString()}`;
}

/** The sentence the page shows for a failure. */
export function logsFailureSentence(failure: ProxyFailure, target: { namespace: string; pod: string }): string {
  switch (failure.kind) {
    case "forbidden":
      return `Reading logs needs "get" on "pods/log" in ${target.namespace}`;
    case "timeout":
      return `No answer for the logs of ${target.pod} within ${LOGS_TIMEOUT_MS / 1000} s`;
    default:
      return failure.status === 404
        ? `The pod ${target.pod} is not there (anymore)`
        : `The logs of ${target.pod} cannot be read${failure.detail ? `: ${failure.detail}` : ""}`;
  }
}

export interface PodLogsClient {
  getLogs(request: LogsRequest): Promise<LogsResult>;
}

export function createPodLogsClient({
  fetch: fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = LOGS_TIMEOUT_MS,
}: {
  fetch?: FetchLike;
  timeoutMs?: number;
} = {}): PodLogsClient {
  return {
    async getLogs(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(podLogsPath(request), {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "text/plain, */*" },
        });
        const body = await response.text();
        if (response.status >= 200 && response.status < 300) return { ok: true, value: body };
        const detail = body.trim().slice(0, 300) || undefined;
        return {
          ok: false,
          failure: {
            kind: response.status === 401 || response.status === 403 ? "forbidden" : "unreachable",
            status: response.status,
            detail,
          },
        };
      } catch (error) {
        if (controller.signal.aborted) return { ok: false, failure: { kind: "timeout" } };
        return { ok: false, failure: { kind: "unreachable", detail: String(error) } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
