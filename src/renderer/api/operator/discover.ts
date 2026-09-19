/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Where the operator lives (SPEC-0016). The pages of the extension follow the
// namespace filter of the host, and the operator's namespace is rarely in it,
// so the Operator page asks the API server once: every deployment with the
// operator's label, cluster-wide, and when that is not allowed, the namespaces
// an installation usually picks. Read-only, through the host's cluster proxy.

import { API_KUBE_PREFIX } from "../instance/pod-proxy";

import type { FetchLike } from "../instance/pod-proxy";

export const OPERATOR_SELECTOR = "app.kubernetes.io/name=cloudnative-pg";
/** Release manifest and Helm default, OLM on OpenShift, OLM elsewhere. */
export const USUAL_NAMESPACES: readonly string[] = ["cnpg-system", "openshift-operators", "operators"];

export interface OperatorDiscovery {
  namespaces: string[];
  /** True when the cluster-wide list was refused and only the usual namespaces were tried. */
  narrowed: boolean;
}

async function list(fetchImpl: FetchLike, path: string): Promise<{ status: number; namespaces: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(path, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status < 200 || response.status >= 300) return { status: response.status, namespaces: [] };
    const parsed = JSON.parse(await response.text()) as { items?: { metadata?: { namespace?: string } }[] };
    return {
      status: response.status,
      namespaces: (parsed.items ?? []).map((item) => item.metadata?.namespace ?? "").filter(Boolean),
    };
  } catch {
    return { status: 0, namespaces: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverOperatorNamespaces(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<OperatorDiscovery> {
  const selector = encodeURIComponent(OPERATOR_SELECTOR);
  const everywhere = await list(fetchImpl, `${API_KUBE_PREFIX}/apis/apps/v1/deployments?labelSelector=${selector}`);
  if (everywhere.status >= 200 && everywhere.status < 300) {
    return { namespaces: [...new Set(everywhere.namespaces)].sort(), narrowed: false };
  }
  const found: string[] = [];
  for (const namespace of USUAL_NAMESPACES) {
    const local = await list(
      fetchImpl,
      `${API_KUBE_PREFIX}/apis/apps/v1/namespaces/${namespace}/deployments?labelSelector=${selector}`,
    );
    found.push(...local.namespaces);
  }
  return { namespaces: [...new Set(found)].sort(), narrowed: true };
}
