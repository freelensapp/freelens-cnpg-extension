/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The frame of the ad hoc pages that look at one cluster at a time (the Logs
// of SPEC-0018, the Timeline of SPEC-0017): the title, the cluster picker fed
// by a URL parameter so that every door lands on the right cluster, the doors
// when no cluster is picked, and the panels for a cluster that is gone or a
// namespace without clusters. The page itself is what the children render.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { Cluster } from "../api/cnpg/cluster-v1";
import { CLUSTERS_PAGE_ID, extensionPageUrl } from "../navigation";
import { classifyCluster } from "./cluster-health";
import styles from "./live/live.module.scss";
import stylesInline from "./live/live.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, MaybeLink, NamespaceSelectFilter, Select, TabLayout },
  Navigation: { createPageParam },
} = Renderer;

type PageParam = ReturnType<typeof createPageParam<string>>;

const params = new Map<string, PageParam>();

/** A string query parameter of the extension's pages, created on first use: the host is ready by then. */
export function pageParam(name: string): PageParam {
  let param = params.get(name);
  if (!param) {
    param = createPageParam<string>({ name, defaultValue: "" });
    params.set(name, param);
  }
  return param;
}

export function splitClusterKey(key: string): { namespace: string; name: string } | undefined {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1) return undefined;
  return { namespace: key.slice(0, index), name: key.slice(index + 1) };
}

export interface ClusterPickerPageProps {
  extension: Renderer.LensExtension;
  title: string;
  /** Prefix of the test ids: `<testId>`, `<testId>-doors`, `<testId>-door-<ns>-<name>`, `<testId>-gone`, `<testId>-empty`. */
  testId: string;
  /** Name of the query parameter that carries `<namespace>/<name>`. */
  paramName: string;
  /** The URL of this page for a cluster, for the doors. */
  urlOf: (namespace: string, name: string) => string;
  /** Extra styles of the page that uses the frame. */
  extraStyles?: string;
  children: (cluster: Cluster, key: string) => React.ReactNode;
}

export const ClusterPickerPage = observer(
  ({ extension, title, testId, paramName, urlOf, extraStyles, children }: ClusterPickerPageProps) => {
    const clusterStore = Cluster.getStore<Cluster>();
    const param = pageParam(paramName);
    const selectedKey = param.get() ?? "";
    const selected = splitClusterKey(selectedKey);

    const clusters = [...(clusterStore.contextItems as Cluster[])].sort(
      (a, b) => (a.getNs() ?? "").localeCompare(b.getNs() ?? "") || a.getName().localeCompare(b.getName()),
    );
    const cluster = selected ? clusterStore.getByName(selected.name, selected.namespace) : undefined;
    const loading = !clusterStore.isLoaded && !clusterStore.failedLoading;
    const namespaces = [...new Set(clusters.map((item) => item.getNs() ?? ""))];
    const options = namespaces.map((namespace) => ({
      label: namespace,
      options: clusters
        .filter((item) => (item.getNs() ?? "") === namespace)
        .map((item) => ({ value: `${namespace}/${item.getName()}`, label: item.getName() })),
    }));

    return (
      <TabLayout scrollable>
        <style>{stylesInline}</style>
        {extraStyles ? <style>{extraStyles}</style> : null}
        <div className={styles.page} data-testid={testId}>
          <h5 className={styles.title}>{title}</h5>
          <div className={styles.header}>
            <div className={styles.picker}>
              <Select
                id={`${testId}-cluster`}
                options={options}
                value={cluster ? selectedKey : null}
                placeholder="Select a PostgreSQL cluster"
                onChange={(option) => param.set(option?.value ?? "")}
                themeName="lens"
              />
            </div>
            {/* The host's own namespace filter, the one of every list: the picker follows it, so it is here to move it. */}
            <div className={styles.namespaces} data-testid={`${testId}-namespaces`}>
              <NamespaceSelectFilter id={`${testId}-namespace-filter`} />
            </div>
          </div>

          {cluster ? (
            children(cluster, selectedKey)
          ) : selected && !loading ? (
            <div className={styles.panel} data-testid={`${testId}-gone`}>
              <strong>
                {selected.namespace}/{selected.name}
              </strong>{" "}
              is not among the PostgreSQL clusters of the selected namespaces: it no longer exists, or the namespace
              filter hides it.{" "}
              <MaybeLink to={extensionPageUrl(extension.name, CLUSTERS_PAGE_ID)}>PostgreSQL Clusters</MaybeLink>
            </div>
          ) : null}

          {!cluster && !loading ? (
            clusters.length === 0 ? (
              <div className={styles.panel} data-testid={`${testId}-empty`}>
                No PostgreSQL cluster in the selected namespaces. The namespaces are the filter of Freelens above, the
                one at the top of every list: on a first connection to a Kubernetes cluster it selects only{" "}
                <code>default</code>.
              </div>
            ) : (
              <div className={styles.doors} data-testid={`${testId}-doors`}>
                {clusters.map((item) => {
                  const health = classifyCluster(item);
                  const namespace = item.getNs() ?? "";
                  return (
                    <MaybeLink
                      key={`${namespace}/${item.getName()}`}
                      to={urlOf(namespace, item.getName())}
                      className={styles.doorRow}
                      data-testid={`${testId}-door-${namespace}-${item.getName()}`}
                    >
                      <Badge small className={health.className} label={health.label} />
                      <span className={styles.doorName}>{item.getName()}</span>
                      <span className={styles.muted}>{namespace}</span>
                    </MaybeLink>
                  );
                })}
              </div>
            )
          ) : null}
        </div>
      </TabLayout>
    );
  },
);
