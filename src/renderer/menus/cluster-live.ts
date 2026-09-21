/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// What the write actions of a PostgreSQL cluster read from the host's stores
// (SPEC-0022, SPEC-0023): the cluster as the store holds it right now, and
// the pods of its namespace as plain data. No decision lives here.

import { Renderer } from "@freelensapp/extensions";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";

import type { InstancePodFacts } from "../components/switchover";

const {
  K8sApi: { podsStore },
} = Renderer;

/** The object as the store holds it right now, or the one the row was rendered with (W2). */
export function liveCluster(object: Cluster): Cluster {
  const store = maybe(() => Cluster.getStore<Cluster>());
  const selfLink = object.metadata?.selfLink;
  return (selfLink ? store?.getByPath(selfLink) : undefined) ?? object;
}

interface PodShape {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string | undefined> };
  spec?: { nodeName?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

/** The pods of the namespace, read as plain data: the labels, the node and the Ready condition. */
export function instancePods(namespace: string): InstancePodFacts[] {
  return ((maybe(() => podsStore.items) ?? []) as PodShape[])
    .filter((pod) => pod.metadata?.namespace === namespace)
    .map((pod) => ({
      name: pod.metadata?.name ?? "",
      labels: pod.metadata?.labels,
      nodeName: pod.spec?.nodeName,
      ready:
        pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false,
    }));
}

/**
 * The pods of a cluster are known once the pod of its primary is in the
 * store: the store's own `isLoaded` says nothing about one namespace.
 */
export function podsKnown(namespace: string, primary: string | undefined): boolean {
  return Boolean(primary && maybe(() => podsStore.getByName(primary, namespace)));
}

/** Asks for the pods of the namespace and waits for them: a dialog decides on facts. */
export async function loadPods(namespace: string): Promise<void> {
  await maybe(() => podsStore.loadAll({ namespaces: [namespace], merge: true, onLoadFailure: () => undefined }))?.catch(
    () => undefined,
  );
}
