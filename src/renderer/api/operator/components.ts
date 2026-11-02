/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the cluster runs of what CloudNativePG needs (SPEC-0036): the operator,
// cert-manager, the Barman Cloud plugin and Klio, each by its CRD and by the
// image of its workload. Asked of the API server once, through the host's
// cluster proxy, read-only; a list that is not allowed leaves the version out,
// it never fails the guide.

import { BARMAN_CLOUD_PLUGIN, KLIO_PLUGIN } from "../../components/install-guide";
import { imageVersion } from "../../components/operator";
import { API_KUBE_PREFIX } from "../instance/pod-proxy";

import type { ClusterComponents, ComponentProbe } from "../../components/install-guide";
import type { FetchLike } from "../instance/pod-proxy";

const CRDS = {
  operator: "clusters.postgresql.cnpg.io",
  certManager: "certificates.cert-manager.io",
  barmanCloud: "objectstores.barmancloud.cnpg.io",
  klio: "pluginconfigurations.klio.cnpg.io",
};

interface Workload {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { selector?: Record<string, string>; template?: { spec?: { containers?: { image?: string }[] } } };
}

async function get(fetchImpl: FetchLike, path: string): Promise<{ status: number; body?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(path, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status < 200 || response.status >= 300) return { status: response.status };
    return { status: response.status, body: JSON.parse(await response.text()) };
  } catch {
    return { status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A list filtered on the name rather than a get: a missing CRD answers an empty list, not a 404 that the
 * console of the renderer would log as an error on every cluster without the optional plugins.
 */
async function crd(fetchImpl: FetchLike, name: string): Promise<ComponentProbe["crd"]> {
  const selector = encodeURIComponent(`metadata.name=${name}`);
  const { status, body } = await get(
    fetchImpl,
    `${API_KUBE_PREFIX}/apis/apiextensions.k8s.io/v1/customresourcedefinitions?fieldSelector=${selector}`,
  );
  if (status < 200 || status >= 300) return "unknown";
  return ((body as { items?: unknown[] } | undefined)?.items ?? []).length > 0 ? "present" : "absent";
}

async function items(fetchImpl: FetchLike, path: string): Promise<Workload[]> {
  const { body } = await get(fetchImpl, path);
  return ((body as { items?: Workload[] } | undefined)?.items ?? []) as Workload[];
}

function fromWorkload(workload: Workload | undefined): Pick<ComponentProbe, "version" | "namespace"> {
  if (!workload) return {};
  return {
    version: imageVersion(workload.spec?.template?.spec?.containers?.[0]?.image),
    namespace: workload.metadata?.namespace,
  };
}

const deployments = (selector: string) =>
  `${API_KUBE_PREFIX}/apis/apps/v1/deployments?labelSelector=${encodeURIComponent(selector)}`;

/** The deployment behind the service of a CNPG-I plugin, found by the service's selector. */
async function pluginWorkload(fetchImpl: FetchLike, plugin: string): Promise<Workload | undefined> {
  const services = await items(
    fetchImpl,
    `${API_KUBE_PREFIX}/api/v1/services?labelSelector=${encodeURIComponent(`cnpg.io/pluginName=${plugin}`)}`,
  );
  const service = services[0];
  const selector = service?.spec?.selector;
  if (!service || !selector || Object.keys(selector).length === 0) return undefined;
  const query = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const found = await items(
    fetchImpl,
    `${API_KUBE_PREFIX}/apis/apps/v1/namespaces/${service.metadata?.namespace}/deployments?labelSelector=${encodeURIComponent(query)}`,
  );
  return found[0] ?? { metadata: { namespace: service.metadata?.namespace } };
}

export async function probeComponents(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<ClusterComponents> {
  const [operatorCrd, certManagerCrd, barmanCrd, klioCrd, operators, certManagers, barman, klio] = await Promise.all([
    crd(fetchImpl, CRDS.operator),
    crd(fetchImpl, CRDS.certManager),
    crd(fetchImpl, CRDS.barmanCloud),
    crd(fetchImpl, CRDS.klio),
    items(fetchImpl, deployments("app.kubernetes.io/name=cloudnative-pg")),
    items(fetchImpl, deployments("app.kubernetes.io/name=cert-manager")),
    pluginWorkload(fetchImpl, BARMAN_CLOUD_PLUGIN),
    pluginWorkload(fetchImpl, KLIO_PLUGIN),
  ]);
  // The controller of cert-manager is the one whose image names the release; its webhook and cainjector share it.
  const certManager =
    certManagers.find((item) => item.metadata?.labels?.["app.kubernetes.io/component"] === "controller") ??
    certManagers[0];
  return {
    operator: { crd: operatorCrd, ...fromWorkload(operators[0]) },
    certManager: { crd: certManagerCrd, ...fromWorkload(certManager) },
    barmanCloud: { crd: barmanCrd, ...fromWorkload(barman) },
    klio: { crd: klioCrd, ...fromWorkload(klio) },
  };
}
