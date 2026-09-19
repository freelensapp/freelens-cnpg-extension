/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The PostgreSQL Cluster drawer (SPEC-0003 "Drawer"): nine self-guarding
// sections over the pure health model, with every reference rendered as a
// link only when its object is actually in the store (DESIGN.md section 3).

import { Renderer } from "@freelensapp/extensions";
import * as MobxReact from "mobx-react";
import { maybe } from "../../common/utils";
import { ObjectStore } from "../api/barmancloud/object-store-v1";
import { Backup } from "../api/cnpg/backup-v1";
import { Cluster } from "../api/cnpg/cluster-v1";
import { FailoverQuorum } from "../api/cnpg/failover-quorum-v1";
import { ClusterImageCatalog, ImageCatalog } from "../api/cnpg/image-catalog-v1";
import { Pooler } from "../api/cnpg/pooler-v1";
import { ScheduledBackup } from "../api/cnpg/scheduled-backup-v1";
import { buildHistory, schedulesOfCluster } from "../components/backup-history";
import { BackupHistoryStrip } from "../components/backup-history-strip";
import {
  archivingState,
  backupFacts,
  backupsOfCluster,
  certificateFacts,
  classifyCluster,
  instanceFacts,
} from "../components/cluster-health";
import { withErrorPage } from "../components/error-page";
import { quorumFacts } from "../components/failover-quorum";
import { InstanceBricks } from "../components/instance-bricks";
import { objectExists } from "../components/object-existence";
import { classifyPooler, poolersOfCluster, poolerTypeWords } from "../components/poolers";
import { useReferenceStores } from "../components/reference-loader";
import { StoreLink } from "../components/store-link";
import { PsqlButton } from "../menus/open-psql";
import { BACKUPS_PAGE_ID, extensionPageUrl, liveViewUrl } from "../navigation";
import { ClusterDeclarativeSection } from "./cluster-declarative-section";
import styles from "./cluster-details.module.scss";
import stylesInline from "./cluster-details.module.scss?inline";

import type { CertificateFact, InstanceFact } from "../components/cluster-health";

const { observer } = MobxReact;

const {
  Component: {
    Badge,
    BadgeBoolean,
    DrawerItem,
    DrawerTitle,
    LinkToNode,
    LinkToPod,
    LinkToSecret,
    LocaleDate,
    MaybeLink,
    MonacoEditor,
    Table,
    TableCell,
    TableHead,
    TableRow,
    WithTooltip,
  },
  K8sApi: { nodesStore, podsStore, pvcStore, secretsStore, serviceStore },
  Navigation: { getDetailsUrl },
} = Renderer;

const notAvailable = "N/A";

const CERTIFICATE_CLASS: Record<CertificateFact["state"], string> = {
  ok: "success",
  expiring: "warning",
  expired: "error",
  unknown: "info",
};

const INSTANCE_HEALTH_CLASS: Record<InstanceFact["health"], string> = {
  healthy: "success",
  replicating: "warning",
  failed: "error",
  unknown: "info",
};

export interface ClusterDetailsProps extends Renderer.Component.KubeObjectDetailsProps<Cluster> {
  extension: Renderer.LensExtension;
}

/** A secret name rendered as a link when the Secret is in the store, else as text. */
function SecretRef({ name, namespace }: { name: string | undefined; namespace: string }) {
  if (!name) return <>{notAvailable}</>;
  return objectExists(secretsStore, name, namespace) ? (
    <LinkToSecret name={name} namespace={namespace} />
  ) : (
    <WithTooltip tooltip="The Secret is not in the cluster (yet)">{name}</WithTooltip>
  );
}

/** A Service name rendered as a link when the Service is in the store, else as text. */
function ServiceRef({ name, namespace }: { name: string | undefined; namespace: string }) {
  if (!name) return <>{notAvailable}</>;
  const service = serviceStore.getByName(name, namespace);
  return service ? (
    <MaybeLink to={getDetailsUrl(service.selfLink)} onClick={(event) => event.stopPropagation()}>
      {name}
    </MaybeLink>
  ) : (
    <WithTooltip tooltip="The Service is not in the cluster (yet)">{name}</WithTooltip>
  );
}

/** A PVC name rendered as a link when the claim is in the store, else as text. */
function PvcRef({ name, namespace }: { name: string; namespace: string }) {
  const claim = pvcStore.getByName(name, namespace);
  return claim ? (
    <MaybeLink to={getDetailsUrl(claim.selfLink)} onClick={(event) => event.stopPropagation()}>
      {name}
    </MaybeLink>
  ) : (
    <WithTooltip>{name}</WithTooltip>
  );
}

function PvcList({ title, names, namespace }: { title: string; names: string[] | undefined; namespace: string }) {
  if (!names || names.length === 0) return null;
  return (
    <DrawerItem name={title}>
      <div className={styles.list}>
        {names.map((name) => (
          <PvcRef key={name} name={name} namespace={namespace} />
        ))}
      </div>
    </DrawerItem>
  );
}

export const ClusterDetails = observer((props: ClusterDetailsProps) =>
  withErrorPage(props, () => {
    const { object } = props;

    // The host hands the drawer a plain copy of the object, never an instance
    // of this class (AGENTS.md "CRD KubeObject Pattern"): guard on the kind.
    if (!object || object.kind !== Cluster.kind) {
      return <></>;
    }

    const namespace = object.getNs() ?? "";
    const name = object.getName();
    const spec = object.spec;
    const status = object.status;
    const backupStore = maybe(() => Backup.getStore<Backup>());
    const scheduleStore = maybe(() => ScheduledBackup.getStore<ScheduledBackup>());
    // The Barman Cloud plugin is optional: without its CRD there is no store to read.
    const objectStoreStore = maybe(() => ObjectStore.getStore<ObjectStore>());
    const poolerStore = maybe(() => Pooler.getStore<Pooler>());
    const failoverQuorumStore = maybe(() => FailoverQuorum.getStore<FailoverQuorum>());
    // One per cluster with the failover quorum on, named after the cluster (SPEC-0011).
    const failoverQuorum = failoverQuorumStore?.getByName(object.getName(), object.getNs()) as
      | FailoverQuorum
      | undefined;
    const health = classifyCluster(object);
    const archiving = archivingState(object);
    const instances = instanceFacts(object);
    const certificates = certificateFacts(object);
    const fenced = Cluster.getFencedInstances(object);
    const hibernated = Cluster.getHibernation(object);
    const conditions = status?.conditions ?? [];
    const declared = Cluster.getInstances(object);
    const ready = Cluster.getReadyInstances(object);
    const primary = Cluster.getPrimary(object);
    const targetPrimary = status?.targetPrimary;
    const switching = Boolean(primary && targetPrimary && targetPrimary !== primary);

    // Pods, PVCs, Services and Secrets of the cluster's namespace decide which
    // references become links; nodes are cluster-scoped. The loader retries and
    // watches while the drawer is open.
    useReferenceStores([
      {
        label: "pods",
        store: podsStore,
        namespaces: [namespace],
        lookups: instances.map((i) => ({ name: i.name, namespace })),
      },
      { label: "nodes", store: nodesStore },
      { label: "persistentvolumeclaims", store: pvcStore, namespaces: [namespace] },
      { label: "services", store: serviceStore, namespaces: [namespace] },
      { label: "secrets", store: secretsStore, namespaces: [namespace] },
      { label: Backup.crd.plural, store: backupStore, namespaces: [namespace] },
      { label: ScheduledBackup.crd.plural, store: scheduleStore, namespaces: [namespace] },
      { label: ObjectStore.crd.plural, store: objectStoreStore, namespaces: [namespace] },
      { label: FailoverQuorum.crd.plural, store: failoverQuorumStore, namespaces: [namespace] },
      { label: Pooler.crd.plural, store: poolerStore, namespaces: [namespace] },
      {
        label: ImageCatalog.crd.plural,
        store: maybe(() => ImageCatalog.getStore<ImageCatalog>()),
        namespaces: [namespace],
      },
      {
        label: ClusterImageCatalog.crd.plural,
        store: maybe(() => ClusterImageCatalog.getStore<ClusterImageCatalog>()),
      },
    ]);

    const namespaceBackups = ((backupStore?.items ?? []) as Backup[]).filter((b) => b.getNs() === namespace);
    const objectStores = ((objectStoreStore?.items ?? []) as ObjectStore[]).filter((s) => s.getNs() === namespace);
    const backups = backupFacts(object, namespaceBackups, objectStores);

    // The PgBouncer poolers in front of the cluster (SPEC-0012).
    const poolers = poolersOfCluster(object, (poolerStore?.items ?? []) as Pooler[]);

    // The backup history strip and its doors (SPEC-0005): the cluster's own
    // backups over time, its schedules, and the way to the filtered list.
    const now = new Date();
    const ownBackups = backupsOfCluster(object, namespaceBackups);
    const ownSchedules = schedulesOfCluster(object, (scheduleStore?.items ?? []) as ScheduledBackup[]);
    const history = buildHistory(ownBackups, ownSchedules, now, { archivingFailing: archiving.state === "Failing" });
    const backupsListUrl = extensionPageUrl(props.extension.name, BACKUPS_PAGE_ID, name);
    const backupUrl = (backupName: string) => {
      const backup = backupStore?.getByName(backupName, namespace);
      return backup ? getDetailsUrl(backup.selfLink) : undefined;
    };
    const podsByName = new Map(
      instances.map((instance) => [instance.name, podsStore.getByName(instance.name, namespace)] as const),
    );
    const nodeOf = (instance: InstanceFact): string | undefined =>
      instance.node ?? podsByName.get(instance.name)?.getNodeName();
    const nodes = new Map<string, string[]>();
    for (const instance of instances) {
      const node = nodeOf(instance);
      if (!node) continue;
      nodes.set(node, [...(nodes.get(node) ?? []), instance.name]);
    }

    const synchronous = spec?.postgresql?.synchronous;
    const minSync = spec?.minSyncReplicas ?? 0;
    const syncConfigured = synchronous
      ? `${synchronous.method ?? "any"} ${synchronous.number ?? 0}`
      : `${minSync} to ${spec?.maxSyncReplicas ?? 0}`;
    const replicasReady = instances.filter((i) => i.role === "replica" && i.health === "healthy").length;
    const syncShortfall = minSync > 0 && replicasReady < minSync;
    const parameters = spec?.postgresql?.parameters ?? {};
    const parameterCount = Object.keys(parameters).length;
    const parametersYaml = Object.entries(parameters)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    const plugins = spec?.plugins ?? [];
    const walArchiver = plugins.find((plugin) => plugin.isWALArchiver);
    const inTreeBackup = Boolean(spec?.backup?.barmanObjectStore);
    const image = status?.pgDataImageInfo?.image ?? status?.image ?? spec?.imageName;
    const readService = status?.readService ?? `${name}-ro`;
    const anyService = `${name}-r`;
    const applicationSecret = `${name}-app`;
    const superuserSecret = spec?.enableSuperuserAccess
      ? (spec.superuserSecret?.name ?? `${name}-superuser`)
      : undefined;

    return (
      <>
        <style>{stylesInline}</style>

        <DrawerTitle>Health</DrawerTitle>
        <DrawerItem name="Live view" hidden={hibernated}>
          <MaybeLink
            to={liveViewUrl(props.extension.name, namespace, name)}
            data-testid="cnpg-cluster-live-view-link"
            onClick={(event) => event.stopPropagation()}
          >
            Sessions, replication lag, WAL and databases right now
          </MaybeLink>
        </DrawerItem>
        <DrawerItem name="Condition" labelsOnly>
          <Badge className={health.className} label={health.label} tooltip={health.reason} />
        </DrawerItem>
        <DrawerItem name="Status">
          <WithTooltip>{health.reason}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Phase" hidden={!status?.phase}>
          <WithTooltip tooltip={status?.phaseReason}>{status?.phase}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Hibernation" hidden={!hibernated}>
          On
        </DrawerItem>
        <DrawerItem name="Fenced instances" hidden={fenced.length === 0}>
          <WithTooltip>{fenced.join(", ")}</WithTooltip>
        </DrawerItem>
        {conditions.length > 0 ? (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.conditions}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.type}>Type</TableCell>
              <TableCell className={styles.status}>Status</TableCell>
              <TableCell className={styles.reason}>Reason</TableCell>
              <TableCell className={styles.since}>Since</TableCell>
              <TableCell className={styles.message}>Message</TableCell>
            </TableHead>
            {conditions.map((condition) => (
              <TableRow key={condition.type} nowrap>
                <TableCell className={styles.type}>
                  <WithTooltip>{condition.type}</WithTooltip>
                </TableCell>
                <TableCell className={styles.status}>
                  <Badge
                    small
                    className={
                      condition.status === "True" ? "success" : condition.status === "False" ? "error" : "info"
                    }
                    label={condition.status}
                  />
                </TableCell>
                <TableCell className={styles.reason}>
                  <WithTooltip>{condition.reason ?? notAvailable}</WithTooltip>
                </TableCell>
                <TableCell className={styles.since}>
                  {condition.lastTransitionTime ? (
                    <Renderer.Component.ReactiveDuration timestamp={condition.lastTransitionTime} />
                  ) : (
                    notAvailable
                  )}
                </TableCell>
                <TableCell className={styles.message}>
                  <WithTooltip>{condition.message ?? notAvailable}</WithTooltip>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        ) : null}

        <DrawerTitle>Instances</DrawerTitle>
        <DrawerItem name="Ready">
          {ready}/{declared}
          <InstanceBricks instances={instances} />
        </DrawerItem>
        <DrawerItem name="Primary" hidden={!primary}>
          {primary && objectExists(podsStore, primary, namespace) ? (
            <LinkToPod name={primary} namespace={namespace} />
          ) : (
            <WithTooltip>{primary}</WithTooltip>
          )}
        </DrawerItem>
        <DrawerItem name="Primary since" hidden={!status?.currentPrimaryTimestamp}>
          <LocaleDate date={status?.currentPrimaryTimestamp ?? ""} />
        </DrawerItem>
        <DrawerItem name="Primary failing since" hidden={!status?.currentPrimaryFailingSinceTimestamp}>
          <LocaleDate date={status?.currentPrimaryFailingSinceTimestamp ?? ""} />
        </DrawerItem>
        <DrawerItem name="Target primary" hidden={!switching}>
          <WithTooltip tooltip="A switchover or a failover is in flight">{targetPrimary}</WithTooltip>
        </DrawerItem>
        {instances.length > 0 ? (
          <Table scrollable={false} sortSyncWithUrl={false} className={styles.instances}>
            <TableHead flat sticky={false}>
              <TableCell className={styles.name}>Name</TableCell>
              <TableCell className={styles.role}>Role</TableCell>
              <TableCell className={styles.health}>Health</TableCell>
              <TableCell className={styles.node}>Node</TableCell>
              <TableCell className={styles.ip}>IP</TableCell>
              <TableCell className={styles.timeline}>Timeline</TableCell>
              <TableCell className={styles.fenced}>Fenced</TableCell>
              <TableCell className={styles.psql}>psql</TableCell>
            </TableHead>
            {instances.map((instance) => {
              const node = nodeOf(instance);
              return (
                <TableRow key={instance.name} nowrap>
                  <TableCell className={styles.name}>
                    {objectExists(podsStore, instance.name, namespace) ? (
                      <LinkToPod name={instance.name} namespace={namespace} />
                    ) : (
                      <WithTooltip tooltip="The pod is not in the cluster (yet)">{instance.name}</WithTooltip>
                    )}
                  </TableCell>
                  <TableCell className={styles.role}>
                    <WithTooltip>{instance.role}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.health}>
                    <Badge small className={INSTANCE_HEALTH_CLASS[instance.health]} label={instance.health} />
                  </TableCell>
                  <TableCell className={styles.node}>
                    {node && objectExists(nodesStore, node) ? (
                      <LinkToNode name={node} />
                    ) : (
                      <WithTooltip>{node ?? notAvailable}</WithTooltip>
                    )}
                  </TableCell>
                  <TableCell className={styles.ip}>
                    <WithTooltip>{instance.ip ?? notAvailable}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.timeline}>
                    <WithTooltip>{instance.timeline ?? notAvailable}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.fenced}>
                    <BadgeBoolean value={instance.fenced} />
                  </TableCell>
                  <TableCell className={styles.psql}>
                    <PsqlButton cluster={object} instanceName={instance.name} />
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        ) : null}

        <DrawerTitle>Replication</DrawerTitle>
        <DrawerItem name="Failover quorum" hidden={!failoverQuorum}>
          {failoverQuorum ? (
            <span className={styles.topologyRow}>
              <Badge
                small
                className={quorumFacts(failoverQuorum, object).className}
                label={quorumFacts(failoverQuorum, object).label}
                tooltip={quorumFacts(failoverQuorum, object).reason}
              />
              <StoreLink store={failoverQuorumStore} name={name} namespace={namespace} />
            </span>
          ) : null}
        </DrawerItem>
        <DrawerItem name="Synchronous replicas">
          <WithTooltip
            tooltip={synchronous ? "spec.postgresql.synchronous" : "spec.minSyncReplicas to spec.maxSyncReplicas"}
          >
            {syncConfigured}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Synchronous shortfall" hidden={!syncShortfall} labelsOnly>
          <Badge
            className="warning"
            label={`${replicasReady} healthy replicas, ${minSync} required`}
            tooltip="Fewer healthy replicas than the minimum synchronous replicas: commits may stall"
          />
        </DrawerItem>
        <DrawerItem name="Timeline" hidden={status?.timelineID === undefined}>
          {status?.timelineID}
        </DrawerItem>
        <DrawerItem name="Topology" hidden={nodes.size === 0}>
          <div className={styles.list}>
            {[...nodes.entries()].map(([node, names]) => (
              <span key={node} className={styles.topologyRow}>
                {objectExists(nodesStore, node) ? <LinkToNode name={node} /> : <span>{node}</span>}
                <span className={styles.topologyInstances}>{names.join(", ")}</span>
              </span>
            ))}
          </div>
        </DrawerItem>
        <DrawerItem name="Replica cluster" hidden={!spec?.replica?.enabled}>
          <WithTooltip>{spec?.replica?.source ?? "enabled"}</WithTooltip>
        </DrawerItem>

        <DrawerTitle>PostgreSQL</DrawerTitle>
        <DrawerItem name="Image" hidden={!image}>
          <WithTooltip>{image}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Image catalog" hidden={!spec?.imageCatalogRef}>
          <span className={styles.topologyRow}>
            <StoreLink
              store={
                spec?.imageCatalogRef?.kind === ClusterImageCatalog.kind
                  ? maybe(() => ClusterImageCatalog.getStore<ClusterImageCatalog>())
                  : maybe(() => ImageCatalog.getStore<ImageCatalog>())
              }
              name={spec?.imageCatalogRef?.name}
              namespace={spec?.imageCatalogRef?.kind === ClusterImageCatalog.kind ? undefined : namespace}
              missing="The catalog is not in the cluster (yet)"
            />
            <span className={styles.topologyInstances}>
              {spec?.imageCatalogRef?.kind ?? "ImageCatalog"}, PostgreSQL {spec?.imageCatalogRef?.major}
            </span>
          </span>
        </DrawerItem>
        <DrawerItem name="Major version" hidden={status?.pgDataImageInfo?.majorVersion === undefined}>
          {status?.pgDataImageInfo?.majorVersion}
        </DrawerItem>
        <DrawerItem name="Extensions" hidden={!status?.pgDataImageInfo?.extensions?.length}>
          <WithTooltip>
            {status?.pgDataImageInfo?.extensions?.map((extension) => extension.name).join(", ")}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="System ID" hidden={!status?.systemID}>
          <WithTooltip>{status?.systemID}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Parameters">{parameterCount === 0 ? "None" : `${parameterCount} configured`}</DrawerItem>
        {parameterCount > 0 ? (
          <div className={styles.editor}>
            <MonacoEditor
              id={`cnpg-parameters-${namespace}-${name}`}
              readOnly
              language="yaml"
              value={parametersYaml}
              style={{ minHeight: Math.min(60 + parameterCount * 19, 320) }}
              options={{ scrollbar: { alwaysConsumeMouseWheel: false }, minimap: { enabled: false } }}
            />
          </div>
        ) : null}

        <ClusterDeclarativeSection cluster={object} extension={props.extension} />

        <DrawerTitle>Storage</DrawerTitle>
        <DrawerItem name="Data volume" hidden={!spec?.storage}>
          <WithTooltip>
            {spec?.storage?.size ?? notAvailable}
            {spec?.storage?.storageClass ? ` (${spec.storage.storageClass})` : ""}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="WAL volume" hidden={!spec?.walStorage}>
          <WithTooltip>
            {spec?.walStorage?.size ?? notAvailable}
            {spec?.walStorage?.storageClass ? ` (${spec.walStorage.storageClass})` : ""}
          </WithTooltip>
        </DrawerItem>
        <DrawerItem name="Volumes" hidden={status?.pvcCount === undefined}>
          {status?.pvcCount}
        </DrawerItem>
        <PvcList title="Healthy volumes" names={status?.healthyPVC} namespace={namespace} />
        <PvcList title="Resizing volumes" names={status?.resizingPVC} namespace={namespace} />
        <PvcList title="Initializing volumes" names={status?.initializingPVC} namespace={namespace} />
        <PvcList title="Dangling volumes" names={status?.danglingPVC} namespace={namespace} />
        <PvcList title="Unusable volumes" names={status?.unusablePVC} namespace={namespace} />

        <DrawerTitle>Backups and archiving</DrawerTitle>
        <DrawerItem name="WAL archiving" labelsOnly>
          <Badge
            className={archiving.state === "Archiving" ? "success" : archiving.state === "Failing" ? "error" : "info"}
            label={archiving.state}
            tooltip={archiving.message ?? archiving.reason}
          />
        </DrawerItem>
        <DrawerItem name="Archiving message" hidden={!archiving.message}>
          <WithTooltip>{archiving.message}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Backup plugin" hidden={!walArchiver && plugins.length === 0}>
          <WithTooltip>{(walArchiver ?? plugins[0])?.name}</WithTooltip>
        </DrawerItem>
        <DrawerItem name="Object store" hidden={!(walArchiver ?? plugins[0])?.parameters?.barmanObjectName}>
          <StoreLink
            store={objectStoreStore}
            name={(walArchiver ?? plugins[0])?.parameters?.barmanObjectName}
            namespace={namespace}
            missing="The ObjectStore is not in the cluster (yet)"
          />
        </DrawerItem>
        <DrawerItem name="Backup method" hidden={!inTreeBackup} labelsOnly>
          <Badge
            className="warning"
            label="barmanObjectStore (deprecated)"
            tooltip="Use the Barman Cloud plugin instead"
          />
        </DrawerItem>
        <BackupHistoryStrip history={history} now={now} backupUrl={backupUrl} listUrl={backupsListUrl} />
        <DrawerItem name="Scheduled backups">
          {ownSchedules.length === 0 ? (
            "None defined"
          ) : (
            <div className={styles.list}>
              {ownSchedules.map((schedule) => (
                <StoreLink
                  key={schedule.getName()}
                  store={scheduleStore}
                  name={schedule.getName()}
                  namespace={namespace}
                />
              ))}
            </div>
          )}
        </DrawerItem>
        <DrawerItem name="Backups" hidden={ownBackups.length === 0}>
          <MaybeLink to={backupsListUrl} onClick={(event) => event.stopPropagation()}>
            All backups of this cluster ({ownBackups.length})
          </MaybeLink>
        </DrawerItem>
        <DrawerItem name="Last successful backup">
          {backups.lastSuccessful ? <LocaleDate date={backups.lastSuccessful} /> : notAvailable}
        </DrawerItem>
        <DrawerItem name="Last failed backup" hidden={!backups.lastFailed}>
          {backups.lastFailed ? <LocaleDate date={backups.lastFailed} /> : null}
        </DrawerItem>
        <DrawerItem name="First recoverability point" hidden={!backups.firstRecoverabilityPoint}>
          {backups.firstRecoverabilityPoint ? <LocaleDate date={backups.firstRecoverabilityPoint} /> : null}
          <span className={styles.topologyInstances}>
            {backups.recoverabilitySource === "object store"
              ? " as the Barman Cloud plugin reports it"
              : backups.recoverabilitySource === "backups"
                ? " approximated by the earliest completed Backup object"
                : ""}
          </span>
        </DrawerItem>
        <DrawerItem name="Backup facts source">
          <WithTooltip
            tooltip={
              backups.source === "backups"
                ? `${backups.count} Backup objects of this cluster`
                : backups.source === "object store"
                  ? "The recovery window the Barman Cloud plugin reports in the object store, no Backup object found"
                  : backups.source === "status"
                    ? "Deprecated cluster status fields, no Backup object found"
                    : "No Backup object and no status field"
            }
          >
            {backups.source === "backups"
              ? "Backup objects"
              : backups.source === "object store"
                ? "object store (no Backup object)"
                : backups.source === "status"
                  ? "cluster status (deprecated)"
                  : "none"}
          </WithTooltip>
        </DrawerItem>

        <DrawerTitle>Certificates</DrawerTitle>
        <Table scrollable={false} sortSyncWithUrl={false} className={styles.certificates}>
          <TableHead flat sticky={false}>
            <TableCell className={styles.role}>Role</TableCell>
            <TableCell className={styles.secret}>Secret</TableCell>
            <TableCell className={styles.expires}>Expires</TableCell>
            <TableCell className={styles.state}>State</TableCell>
          </TableHead>
          {certificates.map((certificate) => (
            <TableRow key={certificate.role} nowrap>
              <TableCell className={styles.role}>
                <WithTooltip>{certificate.role}</WithTooltip>
              </TableCell>
              <TableCell className={styles.secret}>
                <SecretRef name={certificate.secretName} namespace={namespace} />
              </TableCell>
              <TableCell className={styles.expires}>
                {certificate.expiresAt ? <LocaleDate date={certificate.expiresAt} /> : notAvailable}
              </TableCell>
              <TableCell className={styles.state}>
                <Badge small className={CERTIFICATE_CLASS[certificate.state]} label={certificate.state} />
              </TableCell>
            </TableRow>
          ))}
        </Table>

        <DrawerTitle>Services and secrets</DrawerTitle>
        <DrawerItem name="Poolers" hidden={poolers.length === 0}>
          <div className={styles.list}>
            {poolers.map((pooler) => (
              <span key={pooler.getName()} className={styles.topologyRow}>
                <StoreLink store={poolerStore} name={pooler.getName()} namespace={namespace} />
                <span className={styles.topologyInstances}>
                  {poolerTypeWords(pooler)}, {classifyPooler(pooler).state.toLowerCase()}
                </span>
              </span>
            ))}
          </div>
        </DrawerItem>
        <DrawerItem name="Read-write service">
          <ServiceRef name={status?.writeService ?? `${name}-rw`} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Read-only service">
          <ServiceRef name={readService} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Any instance service">
          <ServiceRef name={anyService} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Application secret">
          <SecretRef name={applicationSecret} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Superuser secret" hidden={!superuserSecret}>
          <SecretRef name={superuserSecret} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Server CA secret" hidden={!status?.certificates?.serverCASecret}>
          <SecretRef name={status?.certificates?.serverCASecret} namespace={namespace} />
        </DrawerItem>
        <DrawerItem name="Client CA secret" hidden={!status?.certificates?.clientCASecret}>
          <SecretRef name={status?.certificates?.clientCASecret} namespace={namespace} />
        </DrawerItem>

        {status?.pluginStatus && status.pluginStatus.length > 0 ? (
          <>
            <DrawerTitle>Plugins</DrawerTitle>
            <Table scrollable={false} sortSyncWithUrl={false} className={styles.plugins}>
              <TableHead flat sticky={false}>
                <TableCell className={styles.name}>Name</TableCell>
                <TableCell className={styles.version}>Version</TableCell>
                <TableCell className={styles.capabilities}>Capabilities</TableCell>
                <TableCell className={styles.status}>Status</TableCell>
              </TableHead>
              {status.pluginStatus.map((plugin) => (
                <TableRow key={plugin.name} nowrap>
                  <TableCell className={styles.name}>
                    <WithTooltip>{plugin.name}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.version}>
                    <WithTooltip>{plugin.version ?? notAvailable}</WithTooltip>
                  </TableCell>
                  <TableCell className={styles.capabilities}>
                    <WithTooltip>
                      {[
                        ...(plugin.capabilities ?? []),
                        ...(plugin.operatorCapabilities ?? []),
                        ...(plugin.walCapabilities ?? []),
                        ...(plugin.backupCapabilities ?? []),
                      ].join(", ") || notAvailable}
                    </WithTooltip>
                  </TableCell>
                  <TableCell className={styles.status}>
                    <WithTooltip>{plugin.status ?? notAvailable}</WithTooltip>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </>
        ) : null}
      </>
    );
  }),
);
