/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The dry run of a create (SPEC-0032): the same request as the create, through
// the host's cluster proxy, with `dryRun=All`. Admission runs, the webhooks of
// the operator included, and nothing is persisted.

import { API_KUBE_PREFIX } from "../instance/pod-proxy";

export type PostLike = (
  url: string,
  init: { method: "POST"; signal: AbortSignal; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface DryRunTarget {
  /** The `apiBase` of the kind, as `/apis/postgresql.cnpg.io/v1/clusters`. */
  apiBase: string;
  /** The namespace of a namespaced kind; undefined for a cluster scoped one. */
  namespace?: string;
  body: unknown;
}

/** The collection path of the create: the namespace goes before the plural. */
export function collectionPath({ apiBase, namespace }: Pick<DryRunTarget, "apiBase" | "namespace">): string {
  if (!namespace) return apiBase;
  const index = apiBase.lastIndexOf("/");
  return `${apiBase.slice(0, index)}/namespaces/${encodeURIComponent(namespace)}${apiBase.slice(index)}`;
}

export async function dryRunCreate(
  target: DryRunTarget,
  postImpl: PostLike = (url, init) => fetch(url, init),
  timeoutMs = 10_000,
): Promise<{ status: number; body?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await postImpl(`${API_KUBE_PREFIX}${collectionPath(target)}?dryRun=All`, {
      method: "POST",
      signal: controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(target.body),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = { message: text.slice(0, 300) };
    }
    return { status: response.status, body };
  } catch {
    return { status: 0 };
  } finally {
    clearTimeout(timer);
  }
}
