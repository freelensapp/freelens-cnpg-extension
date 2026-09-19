/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Live View (SPEC-0006): what happens inside a PostgreSQL cluster right
// now, read from the instance manager and the metrics exporter of every
// instance through the API server pod proxy. No credentials, no SQL, no exec.
// The page owns the poller and hands the pure model to the topology and tiles.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { Cluster } from "../api/cnpg/cluster-v1";
import {
  createPodProxyClient,
  failureSentence,
  METRICS_PORT,
  metricsScheme,
  statusScheme,
} from "../api/instance/pod-proxy";
import { humanizeRelative } from "../components/backup-health";
import { classifyCluster, instanceFacts } from "../components/cluster-health";
import { parseGoDuration } from "../components/cron-text";
import { withErrorPage } from "../components/error-page";
import styles from "../components/live/live.module.scss";
import stylesInline from "../components/live/live.module.scss?inline";
import { buildLiveView } from "../components/live/live-model";
import { LivePoller, METRICS_INTERVAL_MS, STATUS_INTERVAL_MS } from "../components/live/live-poller";
import {
  BasebackupsTile,
  DatabasesTile,
  LagTile,
  ManagerTile,
  SessionsTile,
  SlotsTile,
  WalTile,
} from "../components/live/tiles";
import { Topology } from "../components/live/topology";
import { useReferenceStores } from "../components/reference-loader";
import { PsqlButton } from "../menus/open-psql";
import { CLUSTERS_PAGE_ID, extensionPageUrl, LIVE_CLUSTER_PARAM, liveViewUrl } from "../navigation";

import type { InstanceReading, LiveInput } from "../components/live/live-model";
import type { PollTarget } from "../components/live/live-poller";

const { observer } = MobxReact;

const {
  Component: { Badge, Icon, MaybeLink, Select, TabLayout },
  K8sApi: { podsStore },
  Navigation: { createPageParam },
} = Renderer;

type PageParam = ReturnType<typeof createPageParam<string>>;

let clusterParam: PageParam | undefined;

/** The `cluster` query parameter, created on first use: the host is ready by then. */
function getClusterParam(): PageParam {
  clusterParam ??= createPageParam<string>({ name: LIVE_CLUSTER_PARAM, defaultValue: "" });
  return clusterParam;
}

function splitKey(key: string): { namespace: string; name: string } | undefined {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1) return undefined;
  return { namespace: key.slice(0, index), name: key.slice(index + 1) };
}

/** The pace of the metrics: what the exporter caches for, never faster than the status. */
function metricsInterval(cluster: Cluster | undefined): number {
  const declared = parseGoDuration(cluster?.spec?.monitoring?.metricsQueriesTTL ?? "");
  return declared !== undefined && declared >= STATUS_INTERVAL_MS ? declared : METRICS_INTERVAL_MS;
}

function liveInput(cluster: Cluster, readings: ReadonlyMap<string, InstanceReading>): LiveInput {
  const namespace = cluster.getNs() ?? "";
  return {
    declaredPrimary: Cluster.getPrimary(cluster),
    readings,
    instances: instanceFacts(cluster).map((instance) => ({
      name: instance.name,
      fenced: instance.fenced,
      node: podsStore.getByName(instance.name, namespace)?.getNodeName(),
    })),
  };
}

export interface LivePageProps {
  extension: Renderer.LensExtension;
}

interface LivePanelProps {
  extension: Renderer.LensExtension;
  cluster: Cluster;
}

const LivePanel = observer(({ cluster }: LivePanelProps) => {
  const namespace = cluster.getNs() ?? "";
  // The loops read the cluster and the pods of the moment, not those of the first render.
  const latest = React.useRef(cluster);
  latest.current = cluster;

  const poller = React.useMemo(
    () =>
      new LivePoller({
        client: createPodProxyClient(),
        metricsIntervalMs: metricsInterval(cluster),
        targets: (): PollTarget[] => {
          const current = latest.current;
          // A hibernated cluster has no instances to read: not a single request leaves.
          if (Cluster.getHibernation(current)) return [];
          const ns = current.getNs() ?? "";
          return instanceFacts(current).map((instance) => ({
            namespace: ns,
            pod: instance.name,
            statusScheme: statusScheme(podsStore.getByName(instance.name, ns)),
            metricsScheme: metricsScheme(current),
          }));
        },
        sample: (readings) => {
          const view = buildLiveView(liveInput(latest.current, readings));
          const figures: Record<string, number | undefined> = { sessions: view.sessions?.total };
          for (const edge of view.edges) figures[`lag:${edge.standby}`] = edge.replayLagMs;
          return figures;
        },
      }),
    // One poller per cluster: a different cluster is a different panel (see the key below).
    // The cluster of the moment is read through the ref, so the memo has no dependency.
    [],
  );

  React.useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const now = new Date();
  const health = classifyCluster(cluster);
  const hibernated = Cluster.getHibernation(cluster);
  const view = buildLiveView(liveInput(cluster, poller.readings));
  const readings = [...poller.readings.values()];
  const metricsPending = !hibernated && readings.every((reading) => !reading.metrics);
  const failedMetrics = readings.find((reading) => reading.metrics && !reading.metrics.ok);
  const metricsFailure =
    failedMetrics?.metrics && !failedMetrics.metrics.ok && readings.every((reading) => !reading.metrics?.ok)
      ? failureSentence(failedMetrics.metrics.failure, {
          namespace,
          pod: view.instances[0]?.name ?? "the instance",
          port: METRICS_PORT,
        })
      : undefined;
  const tileProps = { view, series: poller.series, metricsPending, metricsFailure, now };
  const major = cluster.status?.pgDataImageInfo?.majorVersion;

  return (
    <>
      <div className={styles.headerFacts} data-testid="cnpg-live-facts">
        <Badge className={health.className} label={health.label} tooltip={health.reason} />
        {major !== undefined ? <span>PostgreSQL {major}</span> : null}
        <span title="The metrics exporter caches its queries, so asking more often returns the same numbers">
          status every {poller.statusIntervalMs / 1000} s, metrics every {poller.metricsIntervalMs / 1000} s
        </span>
        <span data-testid="cnpg-live-last-read">
          {poller.lastSuccess ? `last read ${humanizeRelative(new Date(poller.lastSuccess), now)}` : "no answer yet"}
        </span>
        {!poller.running && !hibernated ? <span className={styles.levelWarning}>paused</span> : null}
        <span className={styles.controls}>
          <button
            type="button"
            className={styles.control}
            aria-label={poller.paused ? "Resume the live reads" : "Pause the live reads"}
            title={poller.paused ? "Resume the live reads" : "Pause the live reads"}
            onClick={() => poller.setPaused(!poller.paused)}
          >
            <Icon small material={poller.paused ? "play_arrow" : "pause"} />
          </button>
          <button
            type="button"
            className={styles.control}
            aria-label="Read now"
            title="Read now"
            onClick={() => void poller.refresh()}
          >
            <Icon small material="refresh" />
          </button>
        </span>
      </div>

      {hibernated ? (
        <div className={styles.panel} data-testid="cnpg-live-hibernated">
          <strong>Hibernated:</strong> there are no instances to read. The cluster keeps its volumes and comes back when
          the hibernation annotation is removed.
        </div>
      ) : view.forbidden ? (
        <div className={styles.panel} data-testid="cnpg-live-forbidden">
          <strong>Live data cannot be read.</strong> Reading the instances goes through the API server pod proxy and
          needs the "get" verb on "pods/proxy" in the namespace {namespace}. The lists and the drawers of the extension
          keep working without it.
        </div>
      ) : (
        <>
          <Topology
            view={view}
            namespace={namespace}
            instanceAction={(instanceName) => <PsqlButton cluster={cluster} instanceName={instanceName} />}
          />
          <div className={styles.tiles} data-testid="cnpg-live-tiles">
            <SessionsTile {...tileProps} />
            <LagTile {...tileProps} />
            <WalTile {...tileProps} />
            <DatabasesTile {...tileProps} />
            <SlotsTile {...tileProps} />
            <BasebackupsTile {...tileProps} />
            <ManagerTile {...tileProps} />
          </div>
        </>
      )}
    </>
  );
});

export const LivePage = observer((props: LivePageProps) =>
  withErrorPage(props, () => {
    const { extension } = props;
    const clusterStore = Cluster.getStore<Cluster>();
    const param = getClusterParam();
    const selectedKey = param.get() ?? "";
    const selected = splitKey(selectedKey);

    // Pods tell the scheme of the status port and the node of every instance.
    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore },
      { label: "pods", store: podsStore },
    ]);

    const clusters = [...(clusterStore.items as Cluster[])].sort(
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
        <div className={styles.page} data-testid="cnpg-live">
          <h5 className={styles.title}>Live View</h5>
          <div className={styles.header}>
            <div className={styles.picker}>
              <Select
                id="cnpg-live-cluster"
                options={options}
                value={cluster ? selectedKey : null}
                placeholder="Select a PostgreSQL cluster"
                onChange={(option) => param.set(option?.value ?? "")}
                themeName="lens"
              />
            </div>
          </div>

          {cluster ? (
            // The key gives every cluster a panel, a poller and a memory of its own.
            <LivePanel key={selectedKey} extension={extension} cluster={cluster} />
          ) : selected && !loading ? (
            <div className={styles.panel} data-testid="cnpg-live-gone">
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
              <div className={styles.panel} data-testid="cnpg-live-empty">
                No PostgreSQL cluster in the selected namespaces.
              </div>
            ) : (
              <div className={styles.doors} data-testid="cnpg-live-doors">
                {clusters.map((item) => {
                  const health = classifyCluster(item);
                  const namespace = item.getNs() ?? "";
                  return (
                    <MaybeLink
                      key={`${namespace}/${item.getName()}`}
                      to={liveViewUrl(extension.name, namespace, item.getName())}
                      className={styles.doorRow}
                      data-testid={`cnpg-live-door-${namespace}-${item.getName()}`}
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
  }),
);
