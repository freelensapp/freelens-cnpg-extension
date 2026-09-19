/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The Pooler drawer (SPEC-0012): what the pooler fronts and how it pools, and,
// next to that configuration, what PgBouncer is doing right now, read from the
// exporter of its pods through the API server pod proxy. The figures sit next
// to the parameters because the parameters explain them: a pool size of five
// explains three clients waiting.

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import React from "react";
import { maybe } from "../../common/utils";
import { Cluster } from "../api/cnpg/cluster-v1";
import { POOLER_NAME_LABEL, Pooler } from "../api/cnpg/pooler-v1";
import {
  createPodProxyClient,
  failureSentence,
  POOLER_METRICS_PORT,
  poolerMetricsScheme,
} from "../api/instance/pod-proxy";
import { humanizeRelative } from "../components/backup-health";
import { withErrorPage } from "../components/error-page";
import { formatCount, formatLag } from "../components/live/format";
import { buildPoolerView } from "../components/live/pooler-model";
import { PoolerPoller } from "../components/live/pooler-poller";
import { classifyPooler, poolerInstances, poolerServiceHost, poolerTypeWords } from "../components/poolers";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import styles from "./pooler-details.module.scss";
import stylesInline from "./pooler-details.module.scss?inline";

const { observer } = MobxReact;

const {
  Component: { Badge, BadgeBoolean, DrawerItem, DrawerTitle, Table, TableCell, TableHead, TableRow, WithTooltip },
  K8sApi: { podsStore, secretsStore, serviceStore },
} = Renderer;

const LEVEL_CLASS = { ok: "success", warning: "warning", error: "error" } as const;

export interface PoolerDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Pooler> {
  extension: Renderer.LensExtension;
}

/** The pods of a pooler: the operator labels them with its name. */
function poolerPodNames(name: string, namespace: string): string[] {
  return podsStore.items
    .filter((pod) => pod.getNs() === namespace && pod.metadata?.labels?.[POOLER_NAME_LABEL] === name)
    .map((pod) => pod.getName())
    .sort();
}

const RightNow = observer(({ pooler }: { pooler: Pooler }) => {
  const namespace = pooler.getNs() ?? "";
  const latest = React.useRef(pooler);
  latest.current = pooler;

  const poller = React.useMemo(
    () =>
      new PoolerPoller({
        client: createPodProxyClient(),
        targets: () => {
          const current = latest.current;
          // A paused pooler still answers; one without ready instances has nobody to ask.
          return poolerPodNames(current.getName(), current.getNs() ?? "").map((pod) => ({
            namespace: current.getNs() ?? "",
            pod,
            scheme: poolerMetricsScheme(current),
          }));
        },
      }),
    [],
  );

  React.useEffect(() => {
    poller.start();
    return () => poller.stop();
  }, [poller]);

  const now = new Date();
  const view = buildPoolerView(poller.samples);
  const failures = [...poller.failures.entries()];

  if (!poller.answered) {
    return <DrawerItem name="Right now">Reading the PgBouncer exporter of the pooler pods</DrawerItem>;
  }
  if (!view) {
    const [pod, failure] = failures[0] ?? [];
    return (
      <DrawerItem name="Right now">
        {failure && pod
          ? failureSentence(failure, { namespace, pod, port: POOLER_METRICS_PORT })
          : "The pooler has no pod to ask"}
      </DrawerItem>
    );
  }

  return (
    <>
      <DrawerItem name="Read">
        <span data-testid="cnpg-pooler-live">
          every {poller.intervalMs / 1000} s from {view.pods} pod{view.pods === 1 ? "" : "s"}
          {poller.lastSuccess ? `, last ${humanizeRelative(new Date(poller.lastSuccess), now)}` : ""}
        </span>
      </DrawerItem>
      <DrawerItem name="Clients">
        {formatCount(view.clients.active)} active, {formatCount(view.clients.waiting)} waiting for a server connection,{" "}
        {formatCount(view.clients.free)} free
      </DrawerItem>
      <DrawerItem name="Servers">
        {formatCount(view.servers.active)} active, {formatCount(view.servers.idle)} idle,{" "}
        {formatCount(view.servers.used)} used, {formatCount(view.servers.free)} free
      </DrawerItem>
      <DrawerItem name="Longest wait" labelsOnly>
        <Badge
          className={LEVEL_CLASS[view.level]}
          label={formatLag(view.longestWaitMs)}
          tooltip="How long the client that waits the most has been waiting for a server connection; an error above 5 s"
        />
      </DrawerItem>
      {failures.length > 0 ? (
        <DrawerItem name="Not answering">{failures.map(([pod]) => pod).join(", ")}</DrawerItem>
      ) : null}
      {view.pools.length === 0 ? (
        <DrawerItem name="Pools">No client is connected through the pooler</DrawerItem>
      ) : (
        <Table scrollable={false} sortSyncWithUrl={false} className={styles.table}>
          <TableHead flat sticky={false}>
            <TableCell className={styles.pool}>Database / user</TableCell>
            <TableCell className={styles.number}>Clients</TableCell>
            <TableCell className={styles.number}>Waiting</TableCell>
            <TableCell className={styles.number}>Servers</TableCell>
            <TableCell className={styles.number}>Idle</TableCell>
            <TableCell className={styles.number}>Max wait</TableCell>
          </TableHead>
          {view.pools.map((pool) => (
            <TableRow key={`${pool.database}/${pool.user}`} nowrap>
              <TableCell className={styles.pool}>
                <WithTooltip>{`${pool.database} / ${pool.user}`}</WithTooltip>
              </TableCell>
              <TableCell className={styles.number}>{formatCount(pool.clientsActive)}</TableCell>
              <TableCell className={styles.number}>
                <span className={pool.clientsWaiting > 0 ? styles.warning : undefined}>
                  {formatCount(pool.clientsWaiting)}
                </span>
              </TableCell>
              <TableCell className={styles.number}>{formatCount(pool.serversActive)}</TableCell>
              <TableCell className={styles.number}>{formatCount(pool.serversIdle)}</TableCell>
              <TableCell className={styles.number}>{formatLag(pool.maxWaitMs)}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </>
  );
});

export const PoolerDetails = observer((props: PoolerDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object (AGENTS.md): guard on the kind.
    if (!object || object.kind !== Pooler.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const name = object.getName();
    const clusterStore = maybe(() => Cluster.getStore<Cluster>());

    useReferenceStores([
      { label: Cluster.crd.plural, store: clusterStore, namespaces: [namespace] },
      { label: "pods", store: podsStore, namespaces: [namespace] },
      { label: "services", store: serviceStore, namespaces: [namespace] },
      { label: "secrets", store: secretsStore, namespaces: [namespace] },
    ]);

    const health = classifyPooler(object);
    const pgbouncer = object.spec?.pgbouncer;
    const { ready, declared } = poolerInstances(object);
    const parameters = Object.entries(pgbouncer?.parameters ?? {});
    const pods = poolerPodNames(name, namespace);
    const secrets = object.status?.secrets;
    const secretNames = [
      ["Auth query", secrets?.pgBouncerSecrets?.authQuery?.name],
      ["Client CA", secrets?.clientCA?.name],
      ["Client TLS", secrets?.clientTLS?.name],
      ["Server CA", secrets?.serverCA?.name],
      ["Server TLS", secrets?.serverTLS?.name],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
    const catalog = pgbouncer?.imageCatalogRef;

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Pooler</DrawerTitle>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">{health.reason}</DrawerItem>
        <DrawerItem name="Cluster">
          <StoreLink
            store={clusterStore}
            name={Pooler.getClusterName(object)}
            namespace={namespace}
            missing="The Cluster is not there (anymore)"
          />
        </DrawerItem>
        <DrawerItem name="Fronts">{poolerTypeWords(object)}</DrawerItem>
        <DrawerItem name="Connect to">
          <WithTooltip tooltip="What an application puts in its connection string, port 5432">
            <span className={styles.mono}>{poolerServiceHost(object)}</span>
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Pool mode">
          {(pgbouncer?.poolMode ?? "session") === "transaction"
            ? "transaction: a server connection for the length of a transaction"
            : "session: a server connection for the length of a client session"}
        </DrawerItem>
        <DrawerItem name="Instances">
          {ready}/{declared}
        </DrawerItem>
        <DrawerItem name="Image" hidden={!object.status?.image && !pgbouncer?.image}>
          <span className={styles.mono}>{object.status?.image ?? pgbouncer?.image}</span>
        </DrawerItem>
        <DrawerItem name="Image catalog" hidden={!catalog?.name}>
          {catalog?.kind ?? "ImageCatalog"} {catalog?.name}, key {catalog?.key}
        </DrawerItem>
        {/* Positive phrasing, so that green means healthy (DESIGN.md section 2): a paused pooler accepts nobody. */}
        <DrawerItem name="Accepting clients" labelsOnly>
          <BadgeBoolean value={!(pgbouncer?.paused ?? false)} />
        </DrawerItem>

        <DrawerTitle>Right now</DrawerTitle>
        <RightNow pooler={object} />

        <DrawerTitle>PgBouncer parameters</DrawerTitle>
        {parameters.length === 0 ? (
          <DrawerItem name="Parameters">The defaults of the operator</DrawerItem>
        ) : (
          parameters.map(([key, value]) => (
            <DrawerItem key={key} name={key}>
              <span className={styles.mono}>{value}</span>
            </DrawerItem>
          ))
        )}
        {pgbouncer?.pg_hba?.length ? <pre className={styles.block}>{pgbouncer.pg_hba.join("\n")}</pre> : null}

        <DrawerTitle>Pods, service and secrets</DrawerTitle>
        <DrawerItem name="Pods">
          {pods.length === 0 ? (
            "None running"
          ) : (
            <div className={styles.list}>
              {pods.map((pod) => (
                <StoreLink key={pod} store={podsStore} name={pod} namespace={namespace} />
              ))}
            </div>
          )}
        </DrawerItem>
        <DrawerItem name="Service">
          <StoreLink store={serviceStore} name={name} namespace={namespace} missing="The Service is not there (yet)" />
        </DrawerItem>
        {secretNames.map(([label, secret]) => (
          <DrawerItem key={label} name={label}>
            <StoreLink
              store={secretsStore}
              name={secret}
              namespace={namespace}
              missing="The Secret is not there (yet)"
            />
          </DrawerItem>
        ))}
      </>
    );
  }),
);
