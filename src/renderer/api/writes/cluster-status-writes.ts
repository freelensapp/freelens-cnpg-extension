/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// W7 of SPEC-0020: the only place where the extension writes to the status
// subresource of a `Cluster`, as the upstream tooling does for a switchover
// (SPEC-0022) and for the in-place restart of the primary (SPEC-0023). The
// host's `KubeApi` cannot address a subresource, so this goes through the
// cluster proxy with the user's own credentials, like the pod proxy client
// of SPEC-0006, and like that client it exposes no generic request: these two
// bodies on this one path are all it can express.
//
// Both bodies are JSON merge patches that carry `metadata.resourceVersion`
// and leave `status.conditions` out: a merge patch replaces arrays whole, and
// the operator recomputes `Ready` from the phase by itself (spike S2).

import { API_KUBE_PREFIX, REQUEST_TIMEOUT_MS } from "../instance/pod-proxy";

import type { ApiFailureFacts } from "../../components/write-actions";

export const SWITCHOVER_PHASE = "Switchover in progress";
export const INPLACE_PRIMARY_RESTART_PHASE = "Primary instance is being restarted in-place";
export const INPLACE_PRIMARY_RESTART_REASON = "Requested by the user";

export interface ClusterRef {
  namespace: string;
  name: string;
  /** `metadata.resourceVersion` of the object the patch was computed from (W6). */
  resourceVersion: string;
}

/** The slice of `fetch` the module needs, so tests can stand in for it. */
export type PatchFetch = (
  url: string,
  init: { method: "PATCH"; signal: AbortSignal; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export function clusterStatusPath(namespace: string, name: string): string {
  return `${API_KUBE_PREFIX}/apis/postgresql.cnpg.io/v1/namespaces/${encodeURIComponent(namespace)}/clusters/${encodeURIComponent(name)}/status`;
}

export function switchoverBody(ref: ClusterRef, target: string, timestamp: string): Record<string, unknown> {
  return {
    metadata: { resourceVersion: ref.resourceVersion },
    status: {
      targetPrimary: target,
      targetPrimaryTimestamp: timestamp,
      phase: SWITCHOVER_PHASE,
      phaseReason: `Switching over to ${target}`,
    },
  };
}

export function primaryRestartBody(ref: ClusterRef): Record<string, unknown> {
  return {
    metadata: { resourceVersion: ref.resourceVersion },
    status: { phase: INPLACE_PRIMARY_RESTART_PHASE, phaseReason: INPLACE_PRIMARY_RESTART_REASON },
  };
}

function failureOf(status: number, text: string): ApiFailureFacts {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; reason?: unknown };
    return {
      code: status,
      message: typeof parsed.message === "string" ? parsed.message : text.trim().slice(0, 500) || undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return { code: status, message: text.trim().slice(0, 500) || undefined };
  }
}

/** Sends one of the two bodies. Rejects with `ApiFailureFacts` on anything but a 2xx answer. */
async function patchStatus(ref: ClusterRef, body: Record<string, unknown>, fetchLike: PatchFetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: { status: number; text(): Promise<string> };
  try {
    response = await fetchLike(clusterStatusPath(ref.namespace, ref.name), {
      method: "PATCH",
      signal: controller.signal,
      headers: { "content-type": "application/merge-patch+json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const failure: ApiFailureFacts = { message: error instanceof Error ? error.message : String(error) };
    throw failure;
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status >= 300) {
    throw failureOf(response.status, await response.text());
  }
}

const frameFetch: PatchFetch = (url, init) => fetch(url, init);

/** SPEC-0022: asks the operator to move the primary to `target`. */
export function requestSwitchover(
  ref: ClusterRef,
  target: string,
  timestamp: string,
  fetchLike: PatchFetch = frameFetch,
): Promise<void> {
  return patchStatus(ref, switchoverBody(ref, target, timestamp), fetchLike);
}

/** SPEC-0023: asks the instance manager of the primary to restart PostgreSQL inside the same pod. */
export function requestPrimaryRestart(ref: ClusterRef, fetchLike: PatchFetch = frameFetch): Promise<void> {
  return patchStatus(ref, primaryRestartBody(ref), fetchLike);
}
