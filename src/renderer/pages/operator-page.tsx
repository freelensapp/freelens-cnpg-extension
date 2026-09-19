/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Operator page (SPEC-0016): the thing that runs the databases, on one
// screen. Which version of CloudNativePG is installed and where, whether it is
// up and who leads, what it watches and how it is configured, whether it
// reconciles without errors right now, the CNPG-I plugins it found with the
// clusters that loaded them, and the kinds the cluster serves. All reads.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { getLeaseStore } from "../api/core/lease";
import { createPodProxyClient, failureSentence, OPERATOR_METRICS_PORT } from "../api/instance/pod-proxy";
import { discoverOperatorNamespaces } from "../api/operator/discover";
import { humanizeRelative } from "../components/backup-health";
import { withErrorPage } from "../components/error-page";
import { formatCount } from "../components/live/format";
import liveStyles from "../components/live/live.module.scss";
import liveStylesInline from "../components/live/live.module.scss?inline";
import { METRICS_INTERVAL_MS } from "../components/live/live-poller";
import { SamplesPoller } from "../components/live/samples-poller";
import {
  findOperators,
  isLeaderByMetrics,
  kindFacts,
  operatorFacts,
  pluginFacts,
  reconcileFacts,
} from "../components/operator";
import styles from "../components/operator.module.scss";
import stylesInline from "../components/operator.module.scss?inline";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";

import type { MetricSample } from "../api/instance/prometheus-text";
import type { OperatorDiscovery } from "../api/operator/discover";
import type { CrdLike, DeploymentLike, OperatorFacts, PodLike, ServiceLike } from "../components/operator";

const { observer } = MobxReact;

const {
  Component: {
    Badge,
    BadgeBoolean,
    ReactiveDuration,
    Select,
    Table,
    TableCell,
    TableHead,
    TableRow,
    TabLayout,
    WithTooltip,
  },
  K8sApi: { configMapStore, crdStore, deploymentStore, podsStore, secretsStore, serviceStore },
} = Renderer;

function pace(value: number | undefined): string {
  if (value === undefined) return "N/A";
  return value >= 10 ? `${Math.round(value)}/min` : `${value.toFixed(1)}/min`;
}

/** The reconciles per controller, from the metrics of the leader pod (or of the only pod). */
const Reconciles = observer(({ facts }: { facts: OperatorFacts }) => {
  const latest = React.useRef(facts);
  latest.current = facts;
  const pod = facts.leader ?? facts.pods[0];

  const poller = React.useMemo(
    () =>
      new SamplesPoller({
        client: createPodProxyClient(),
        intervalMs: METRICS_INTERVAL_MS,
        targets: () => {
          const current = latest.current;
          const name = current.leader ?? current.pods[0];
          return name ? [{ namespace: current.namespace, pod: name, scheme: "http" as const }] : [];
        },
        read: (client, target) =>
          client.getOperatorMetrics(target.namespace, target.pod, latest.current.metricsPort ?? OPERATOR_METRICS_PORT),
      }),
    [],
  );

  React.useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  // The pace needs two readings: the one before the last is kept here.
  const history = React.useRef<{ at: number; samples: MetricSample[] }[]>([]);
  const samples = pod ? poller.samples.get(pod) : undefined;
  if (samples && poller.lastSuccess && history.current[history.current.length - 1]?.at !== poller.lastSuccess) {
    history.current = [...history.current.slice(-1), { at: poller.lastSuccess, samples }];
  }
  const [previous, current] = history.current.length === 2 ? history.current : [undefined, history.current[0]];

  if (!pod) return <p className={styles.muted}>The operator has no pod to ask.</p>;
  if (!poller.answered) return <p className={styles.muted}>Reading the metrics of {pod}</p>;

  const failure = poller.failures.get(pod);
  if (!current) {
    return (
      <p className={styles.muted} data-testid="cnpg-operator-metrics-failure">
        {failure
          ? failureSentence(failure, {
              namespace: facts.namespace,
              pod,
              port: facts.metricsPort ?? OPERATOR_METRICS_PORT,
            })
          : `${pod} gave no answer yet`}
      </p>
    );
  }

  const rows = reconcileFacts(
    current.samples,
    previous?.samples,
    previous ? (current.at - previous.at) / 1000 : undefined,
  );
  const leading = isLeaderByMetrics(current.samples);

  return (
    <>
      <p className={styles.muted} data-testid="cnpg-operator-live">
        every {poller.intervalMs / 1000} s from {pod}
        {leading === undefined ? "" : leading ? ", which says it leads" : ", which says it does not lead"}, last{" "}
        {humanizeRelative(new Date(current.at), new Date())}
        {previous ? "" : "; the pace appears with the next reading"}
      </p>
      <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
        <TableHead flat sticky={false}>
          <TableCell className={styles.name}>Controller</TableCell>
          <TableCell className={styles.number}>Reconciles</TableCell>
          <TableCell className={styles.number}>Pace</TableCell>
          <TableCell className={styles.number}>Errors</TableCell>
          <TableCell className={styles.number}>Error pace</TableCell>
          <TableCell className={styles.number}>Workers</TableCell>
          <TableCell className={styles.number}>Queue</TableCell>
        </TableHead>
        {rows.map((row) => (
          <TableRow key={row.controller} nowrap data-testid={`cnpg-operator-controller-${row.controller}`}>
            <TableCell className={styles.name}>
              <WithTooltip>{row.controller}</WithTooltip>
            </TableCell>
            <TableCell className={styles.number}>{formatCount(row.total)}</TableCell>
            <TableCell className={styles.number}>{pace(row.perMinute)}</TableCell>
            <TableCell className={styles.number}>{formatCount(row.errors)}</TableCell>
            <TableCell className={styles.number}>
              <span className={row.level === "error" ? styles.error : undefined}>{pace(row.errorsPerMinute)}</span>
            </TableCell>
            <TableCell className={styles.number}>
              {row.activeWorkers === undefined ? "N/A" : `${row.activeWorkers}/${row.maxWorkers ?? "?"}`}
            </TableCell>
            <TableCell className={styles.number}>{formatCount(row.queueDepth)}</TableCell>
          </TableRow>
        ))}
      </Table>
    </>
  );
});

export interface OperatorPageProps {
  extension: Renderer.LensExtension;
}

export const OperatorPage = observer((props: OperatorPageProps) =>
  withErrorPage(props, () => {
    const [discovery, setDiscovery] = React.useState<OperatorDiscovery | undefined>(undefined);
    const [picked, setPicked] = React.useState<string>("");

    React.useEffect(() => {
      let alive = true;
      void discoverOperatorNamespaces().then((result) => {
        if (alive) setDiscovery(result);
      });
      return () => {
        alive = false;
      };
    }, []);

    const namespaces = discovery?.namespaces ?? [];
    const leaseStore = getLeaseStore();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    // The operator's namespace is rarely in the namespace filter: its objects are asked for by name of namespace.
    useReferenceStores(
      namespaces.length === 0
        ? [{ label: "customresourcedefinitions", store: crdStore }]
        : [
            { label: "deployments", store: deploymentStore, namespaces },
            { label: "pods", store: podsStore, namespaces },
            { label: "services", store: serviceStore, namespaces },
            { label: "configmaps", store: configMapStore, namespaces },
            { label: "secrets", store: secretsStore, namespaces },
            { label: "leases", store: leaseStore as never, namespaces },
            { label: Cluster.crd.plural, store: clusterStore },
            { label: "customresourcedefinitions", store: crdStore },
          ],
    );

    const inScope = <T extends { getNs(): string | undefined }>(items: readonly T[]) =>
      items.filter((item) => namespaces.includes(item.getNs() ?? ""));
    const deployments = inScope(deploymentStore.items) as unknown as (DeploymentLike & { getId(): string })[];
    const operators = findOperators(deployments);
    const selected =
      operators.find((item) => `${item.metadata?.namespace}/${item.metadata?.name}` === picked) ?? operators[0];
    const kinds = kindFacts(crdStore.items as unknown as CrdLike[]);

    const facts = selected
      ? operatorFacts({
          deployment: selected,
          pods: inScope(podsStore.items) as unknown as PodLike[],
          leases: (leaseStore?.items ?? []).filter((lease) => namespaces.includes(lease.metadata?.namespace ?? "")),
          configMaps: inScope(configMapStore.items) as never,
        })
      : undefined;
    const plugins = facts
      ? pluginFacts(
          (inScope(serviceStore.items) as unknown as ServiceLike[]).filter(
            (service) => service.metadata?.namespace === facts.namespace,
          ),
          deployments,
          (clusterStore?.items ?? []) as Cluster[],
        )
      : [];
    const searching = discovery === undefined || (namespaces.length > 0 && !deploymentStore.isLoaded);

    return (
      <TabLayout scrollable>
        <style>{liveStylesInline}</style>
        <style>{stylesInline}</style>
        <div className={liveStyles.page} data-testid="cnpg-operator">
          <h5 className={liveStyles.title}>Operator</h5>

          {operators.length > 1 ? (
            <div className={liveStyles.picker}>
              <Select
                id="cnpg-operator-pick"
                options={operators.map((item) => ({
                  value: `${item.metadata?.namespace}/${item.metadata?.name}`,
                  label: `${item.metadata?.namespace}/${item.metadata?.name}`,
                }))}
                value={`${selected?.metadata?.namespace}/${selected?.metadata?.name}`}
                onChange={(option) => setPicked(option?.value ?? "")}
                themeName="lens"
              />
            </div>
          ) : null}

          {!facts ? (
            <div
              className={liveStyles.panel}
              data-testid={searching ? "cnpg-operator-searching" : "cnpg-operator-missing"}
            >
              {searching ? (
                "Looking for the CloudNativePG operator"
              ) : (
                <>
                  <strong>No CloudNativePG operator deployment was found</strong>{" "}
                  {discovery?.narrowed
                    ? "in the namespaces an installation usually picks (listing deployments in every namespace is not allowed with your permissions)."
                    : "in any namespace you can list."}{" "}
                  The kinds below may still be served by an operator you cannot see.
                </>
              )}
            </div>
          ) : (
            <div className={styles.cards}>
              <section className={styles.card} data-testid="cnpg-operator-card">
                <h6 className={styles.cardTitle}>Operator</h6>
                <dl className={styles.facts}>
                  <dt>Condition</dt>
                  <dd>
                    <Badge className={facts.className} label={facts.state} tooltip={facts.reason} /> {facts.reason}
                  </dd>
                  <dt>Version</dt>
                  <dd data-testid="cnpg-operator-version">{facts.version ?? "N/A (the image has no tag)"}</dd>
                  <dt>Image</dt>
                  <dd className={styles.mono}>{facts.image ?? "N/A"}</dd>
                  <dt>Deployment</dt>
                  <dd>
                    <StoreLink inline store={deploymentStore} name={facts.name} namespace={facts.namespace} /> in{" "}
                    {facts.namespace}
                  </dd>
                  <dt>Pods</dt>
                  <dd>
                    <div className={styles.list}>
                      {facts.pods.length === 0
                        ? "None running"
                        : facts.pods.map((pod) => (
                            <span key={pod}>
                              <StoreLink inline store={podsStore} name={pod} namespace={facts.namespace} />
                              {pod === facts.leader ? " (leader)" : ""}
                            </span>
                          ))}
                    </div>
                  </dd>
                  <dt>Leader</dt>
                  <dd data-testid="cnpg-operator-leader">
                    {facts.leader ? (
                      <>
                        {facts.leader}
                        {facts.lease?.renewedAt ? (
                          <>
                            , lease renewed <ReactiveDuration timestamp={facts.lease.renewedAt.toISOString()} compact />{" "}
                            ago, {facts.lease.transitions}{" "}
                            {facts.lease.transitions === 1 ? "transition" : "transitions"}
                          </>
                        ) : null}
                      </>
                    ) : facts.leaderElection ? (
                      "No lease held by one of its pods was found"
                    ) : (
                      "Leader election is off"
                    )}
                  </dd>
                  <dt>Watches</dt>
                  <dd data-testid="cnpg-operator-watch">{facts.watchScope}</dd>
                  <dt>Concurrent reconciles</dt>
                  <dd>{facts.maxConcurrentReconciles ?? "The default of the operator"}</dd>
                </dl>
              </section>

              <section className={styles.card} data-testid="cnpg-operator-configuration">
                <h6 className={styles.cardTitle}>Configuration</h6>
                <dl className={styles.facts}>
                  <dt>Config map</dt>
                  <dd>
                    {facts.configMapName ? (
                      <StoreLink
                        inline
                        store={configMapStore}
                        name={facts.configMapName}
                        namespace={facts.namespace}
                        missing="Not there: the operator runs with its defaults"
                      />
                    ) : (
                      "None declared"
                    )}
                    {facts.configMapName && !configMapStore.getByName(facts.configMapName, facts.namespace)
                      ? " (not there: the defaults apply)"
                      : ""}
                  </dd>
                  <dt>Secret</dt>
                  <dd>
                    {facts.secretName ? (
                      <StoreLink
                        inline
                        store={secretsStore}
                        name={facts.secretName}
                        namespace={facts.namespace}
                        missing="Not there"
                      />
                    ) : (
                      "None declared"
                    )}
                    {facts.secretName
                      ? secretsStore.getByName(facts.secretName, facts.namespace)
                        ? ", never read by the extension"
                        : " (not there, or not visible to you)"
                      : ""}
                  </dd>
                  {facts.configuration.map((item) => (
                    <React.Fragment key={item.name}>
                      <dt className={styles.mono}>{item.name}</dt>
                      <dd className={styles.mono}>{item.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <p className={styles.muted}>
                  The operator reads its configuration at start: a change needs a restart of its deployment.
                </p>
              </section>

              <section className={[styles.card, styles.wide].join(" ")} data-testid="cnpg-operator-reconciles">
                <h6 className={styles.cardTitle}>Right now</h6>
                <Reconciles key={`${facts.namespace}/${facts.name}`} facts={facts} />
              </section>

              <section className={[styles.card, styles.wide].join(" ")} data-testid="cnpg-operator-plugins">
                <h6 className={styles.cardTitle}>Plugins (CNPG-I)</h6>
                {plugins.length === 0 ? (
                  <p className={styles.muted}>
                    No service with the plugin label in {facts.namespace}: the operator found no plugin.
                  </p>
                ) : (
                  <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
                    <TableHead flat sticky={false}>
                      <TableCell className={styles.wide}>Plugin</TableCell>
                      <TableCell className={styles.name}>Service</TableCell>
                      <TableCell className={styles.number}>Ready</TableCell>
                      <TableCell className={styles.wide}>Clusters that loaded it</TableCell>
                    </TableHead>
                    {plugins.map((plugin) => (
                      <TableRow key={plugin.name} nowrap>
                        <TableCell className={styles.wide}>
                          <WithTooltip tooltip={plugin.capabilities.join(", ") || undefined}>{plugin.name}</WithTooltip>
                        </TableCell>
                        <TableCell className={styles.name}>
                          <StoreLink store={serviceStore} name={plugin.service} namespace={plugin.namespace} />
                        </TableCell>
                        <TableCell className={styles.number}>
                          {plugin.ready === undefined ? (
                            <WithTooltip tooltip="No deployment matches the selector of the service">N/A</WithTooltip>
                          ) : (
                            <Badge small className={plugin.className} label={`${plugin.ready}/${plugin.declared}`} />
                          )}
                        </TableCell>
                        <TableCell className={styles.wide}>
                          <WithTooltip>
                            {plugin.clusters.length === 0
                              ? "None in the selected namespaces"
                              : plugin.clusters
                                  .map(
                                    (user) =>
                                      `${user.namespace}/${user.name}${user.version ? ` (${user.version})` : ""}`,
                                  )
                                  .join(", ")}
                          </WithTooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </Table>
                )}
              </section>
            </div>
          )}

          <section className={styles.card} data-testid="cnpg-operator-kinds">
            <h6 className={styles.cardTitle}>Kinds the cluster serves</h6>
            {kinds.length === 0 ? (
              <p className={styles.muted}>
                No CloudNativePG kind is visible: the CRDs are not installed, or listing them is not allowed.
              </p>
            ) : (
              <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
                <TableHead flat sticky={false}>
                  <TableCell className={styles.name}>Kind</TableCell>
                  <TableCell className={styles.name}>Group</TableCell>
                  <TableCell className={styles.number}>Scope</TableCell>
                  <TableCell className={styles.number}>Served</TableCell>
                  <TableCell className={styles.number}>Stored</TableCell>
                  <TableCell className={styles.number}>Has a view</TableCell>
                </TableHead>
                {kinds.map((kind) => (
                  <TableRow key={`${kind.group}/${kind.kind}`} nowrap>
                    <TableCell className={styles.name}>{kind.kind}</TableCell>
                    <TableCell className={styles.name}>
                      <WithTooltip>{kind.group}</WithTooltip>
                    </TableCell>
                    <TableCell className={styles.number}>{kind.scope}</TableCell>
                    <TableCell className={styles.number}>{kind.served.join(", ") || "N/A"}</TableCell>
                    <TableCell className={styles.number}>{kind.stored ?? "N/A"}</TableCell>
                    <TableCell className={styles.number}>
                      <BadgeBoolean value={kind.hasView} />
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            )}
          </section>
        </div>
      </TabLayout>
    );
  }),
);
