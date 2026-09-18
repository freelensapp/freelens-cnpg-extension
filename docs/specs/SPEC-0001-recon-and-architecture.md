# SPEC-0001: CloudNativePG recon digest and data access architecture

- **Status:** Approved (2026-09-18, lead maintainer)
- **Milestone:** `M1` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0` (operator), Barman Cloud
  plugin `v0.15.0`
- **Author / date:** freelensapp core team, 2026-09-18

## Goal

Fix the facts about CloudNativePG that every other spec builds on, and
decide how the extension reaches the cluster and the instances, so that the
views of M1 and M2 can be specified against a stable contract.

## Upstream reference

- Operator source and docs at tag `v1.30.0` of
  `cloudnative-pg/cloudnative-pg` (Apache-2.0): `api/v1/*_types.go`,
  `pkg/management/url/url.go`, `pkg/management/postgres/webserver/`,
  `pkg/postgres/status.go`, `config/manager/default-monitoring.yaml`,
  `pkg/utils/labels_annotations.go`, `internal/cmd/plugin/{status,psql}`,
  `docs/src/{monitoring,backup,supported_releases,labels_annotations}.md`.
- Barman Cloud plugin `v0.15.0`: `web/docs/{installation,usage}.md`.
- `kubectl cnpg status` and `kubectl cnpg psql`: behavior read from the
  plugin source, reproduced functionally, not copied.

Reminder: facts, identifiers and behavior below were read from those
sources; no code was or will be copied ([ARCHITECTURE.md](../development/ARCHITECTURE.md)).

## Scope

Included: the recon digest (R1 to R9), the architecture decisions (A1 to
A10), the health model (H1 to H5) and the spike list. Excluded: any view
(SPEC-0003 onwards), the test environment (SPEC-0002).

## Recon digest

### R1. API surface

- Group `postgresql.cnpg.io`, version `v1`, kinds: `Cluster`, `Backup`,
  `ScheduledBackup`, `Pooler`, `Database`, `DatabaseRole`, `Publication`,
  `Subscription`, `ImageCatalog`, `ClusterImageCatalog`, `FailoverQuorum`.
- Group `barmancloud.cnpg.io`, version `v1`, kind `ObjectStore` (plugin
  name `barman-cloud.cloudnative-pg.io`, referenced from
  `Cluster.spec.plugins[]` with `isWALArchiver: true` and
  `parameters.barmanObjectName`).
- CloudNativePG 1.30.x supports Kubernetes 1.34, 1.35 and 1.36 (tested but
  unsupported down to 1.30) and PostgreSQL 14 to 18.

### R2. `Cluster.status`

- 51 fields. The ones the views read: `phase`, `phaseReason`, `instances`,
  `readyInstances`, `instancesStatus` (map from `healthy | replicating |
  failed` to instance names), `instanceNames`, `instancesReportedState`
  (per instance: `isPrimary`, `timeLineID`, `ip`), `currentPrimary`,
  `targetPrimary`, `currentPrimaryTimestamp`,
  `currentPrimaryFailingSinceTimestamp`, `targetPrimaryTimestamp`,
  `timelineID`, `topology` (`instances` map, `nodesUsed`,
  `successfullyExtracted`), `writeService`, `readService`, `image`,
  `pgDataImageInfo` (`image`, `majorVersion`, `extensions`),
  `targetPgDataImageInfo`, `systemID`, `conditions`, `certificates`,
  `pluginStatus[]`, `poolerIntegrations`, `managedRolesStatus`,
  `tablespacesStatus`, `healthyPVC`, `danglingPVC`, `resizingPVC`,
  `initializingPVC`, `unusablePVC`, `pvcCount`, `jobCount`,
  `switchReplicaClusterStatus.inProgress`, `onlineUpdateEnabled`,
  `availableArchitectures`, `cloudNativePGOperatorHash`.
- **Deprecated and empty with plugin backups:** `firstRecoverabilityPoint`,
  `firstRecoverabilityPointByMethod`, `lastSuccessfulBackup`,
  `lastSuccessfulBackupByMethod`, `lastFailedBackup`. See H3.
- `status.phase` is one of 22 known strings: "Cluster in healthy state",
  "Setting up primary", "Creating a new replica", "Switchover in
  progress", "Failing over", "Upgrading cluster", "Upgrading Postgres major
  version", "Cluster upgrade delayed", "Waiting for user action", "Primary
  instance is being restarted in-place", "Primary instance is being
  restarted without a switchover", "Online upgrade in progress", "Applying
  configuration", "Promoting to primary cluster", "Waiting for the
  instances to become active", "Cluster cannot proceed to reconciliation
  due to an unknown plugin being required", "Cluster cannot proceed to
  reconciliation due to an error while interacting with plugins", "Cluster
  has incomplete or invalid image catalog", "Cluster is unrecoverable and
  needs manual intervention", "Cluster cannot execute instance online
  upgrade due to missing architecture binary", "Unable to create required
  cluster objects", "Invalid cluster definition".
- Condition types: `Ready` (reasons `ClusterIsReady`,
  `ClusterIsNotReady`, `DetachedVolume`), `ContinuousArchiving`
  (`ContinuousArchivingSuccess`, `ContinuousArchivingFailing`),
  `LastBackupSucceeded` (`LastBackupSucceeded`, `LastBackupFailed`,
  `BackupStarted`), `ConsistentSystemID`, `Initialized`
  (`BootstrapCompleted`, `BootstrapPending`). Status `True | False |
  Unknown`.
- `status.certificates`: flat fields `serverCASecret`, `serverTLSSecret`,
  `replicationTLSSecret`, `clientCASecret`, `serverAltDNSNames`, plus
  `expirations`, a map from **Secret name** to a string in the Go
  `time.String()` layout `2006-01-02 15:04:05.999999999 -0700 MST` (not
  RFC 3339). Four secrets are probed: server CA, server TLS, client CA,
  replication TLS; missing secrets are skipped.

### R3. `Backup` and `ScheduledBackup`

- `Backup.status.phase`: `pending`, `started`, `running`, `finalizing`,
  `completed`, `failed`, `walArchivingFailing`, `invalid backup
  definition`.
- `Backup.status` fields the views read: `phase`, `method`, `online`,
  `startedAt`, `stoppedAt`, `reconciliationStartedAt`,
  `reconciliationTerminatedAt`, `backupId`, `backupName`, `beginWal`,
  `endWal`, `beginLSN`, `endLSN`, `error`, `commandError`, `instanceID`
  (`podName`, `ContainerID`, `sessionID`), `snapshotBackupStatus.elements`,
  `destinationPath`, `serverName`, `majorVersion`, `pluginMetadata`.
- `spec.method` enum `barmanObjectStore | volumeSnapshot | plugin`, CRD
  default `barmanObjectStore`, **deprecated since 1.26**; `plugin` is the
  current path, `volumeSnapshot` is not deprecated.
- `ScheduledBackup.status`: `lastCheckTime`, `lastScheduleTime`,
  `nextScheduleTime`, `error`. No phase. `spec.schedule` is a cron
  expression **with a seconds field**; `spec.suspend`, `spec.immediate`,
  `spec.backupOwnerReference`, `spec.target`, `spec.method`,
  `spec.pluginConfiguration`, `spec.online`.

### R4. Instance pods, labels and annotations

- Container `postgres` (init container `bootstrap-controller`); named
  ports `postgresql` 5432, `metrics` 9187, `status` 8000.
- Labels: `cnpg.io/cluster` (cluster name), `cnpg.io/instanceName`,
  `cnpg.io/instanceRole` (`primary | replica | unhealthy`; the legacy `role`
  label is still written), `cnpg.io/podRole` (`instance | pooler`),
  `cnpg.io/poolerName`, `cnpg.io/pvcRole`, `cnpg.io/backupName`, plus
  `app.kubernetes.io/{name=postgresql, instance, component=database,
  managed-by=cloudnative-pg}`. The role label is set by the reconciler
  after pod creation, so a brand new pod can carry none.
- Annotations: `cnpg.io/fencedInstances` (JSON array of instance names,
  `["*"]` for all), `cnpg.io/hibernation` (`on | off`),
  `cnpg.io/clusterManifest`, `cnpg.io/pgControldata`, `cnpg.io/nodeSerial`,
  `cnpg.io/reloadedAt`, `kubectl.kubernetes.io/restartedAt`,
  `cnpg.io/reconciliationLoop`, `cnpg.io/operatorVersion`.

### R5. Instance manager status endpoint

- Port 8000 on every instance pod, bound to all interfaces. `GET
  /pg/status` is **unauthenticated by design** so that it can be reached
  through the API server's `pods/proxy`; `/healthz`, `/readyz`,
  `/startupz`, `/failsafe` likewise. The action endpoints
  (`/pg/mode/backup`, `/pg/controldata`, `/pg/archive/partial`,
  `/update`) require the operator's client certificate and are out of
  reach and out of scope. There is no switchover endpoint: switchover and
  promotion go through the `Cluster` object.
- Scheme: pods created by 1.30 serve HTTPS (TLS 1.3 with the PostgreSQL
  server certificate, client certificate requested but not required);
  older pods may still serve HTTP. The scheme is detected per pod from the
  presence of `--status-port-tls` in the `postgres` container command,
  exactly as `kubectl cnpg status` does. The API server proxy does the TLS
  to the pod.
- `kubectl cnpg status` reads it as
  `/api/v1/namespaces/<ns>/pods/<scheme>:<pod>:8000/proxy/pg/status`.
  Required RBAC: `pods/proxy` (get).
- The JSON (`PostgresqlStatus`) carries: `currentLsn`, `receivedLsn`,
  `replayLsn` (LSN strings), `systemID`, `isPrimary`, `replayPaused`,
  `pendingRestart`, `pendingRestartForDecrease`, `isWalReceiverActive`,
  `isPgRewindRunning`, `mightBeUnavailable`, `isArchivingWAL`, `node`,
  `pod`, `loadedConfigurationHash`, `lastArchivedWAL`,
  `lastArchivedWALTime`, `lastFailedWAL`, `lastFailedWALTime`,
  `currentWAL`, `readyWalFiles`, `timeLineID`, `replicationInfo[]`
  (primary only: `applicationName`, `state`, `receivedLsn` (the sent LSN,
  note the JSON name), `writeLsn`, `flushLsn`, `replayLsn`, `writeLag`,
  `flushLag`, `replayLag` as PostgreSQL interval strings, `syncState`,
  `syncPriority`), `replicationSlotsInfo[]` (`slotName`, `plugin`,
  `slotType`, `database`, `restartLsn`, `walStatus`, `safeWalSize`,
  `active`), `pgStatBasebackupsInfo[]`, `executableHash`,
  `instanceManagerVersion`, `instanceArch`, `isInstanceManagerUpgrading`,
  `sessionID`. WAL and archiver fields are filled on the primary only.

### R6. Metrics endpoint

- Port 9187, path `/metrics`, Prometheus text format, prefix `cnpg_`,
  queries from the `cnpg-default-monitoring` ConfigMap, results cached
  for `.spec.monitoring.metricsQueriesTTL` (default 30 s).
- Sessions: `cnpg_backends_total{datname,usename,application_name,state}`,
  `cnpg_backends_max_tx_duration_seconds`, `cnpg_backends_waiting_total`.
- Replication lag: `cnpg_pg_replication_lag` (seconds, on a standby),
  `cnpg_pg_stat_replication_{write,flush,replay}_lag_seconds` and
  `cnpg_pg_stat_replication_{sent,write,flush,replay}_diff_bytes` (on the
  primary, per standby), `cnpg_pg_replication_slots_pg_wal_lsn_diff` (bytes
  per slot), `cnpg_pg_replication_streaming_replicas`,
  `cnpg_pg_replication_is_wal_receiver_up`.
- Sizes: `cnpg_pg_database_size_bytes{datname}`, `cnpg_pg_database_xid_age`.
- WAL archiving: `cnpg_pg_stat_archiver_{archived_count, failed_count,
  seconds_since_last_archival, seconds_since_last_failure,
  last_archived_time, last_failed_time}`,
  `cnpg_collector_pg_wal_archive_status{value="ready"|"done"}`.
- WAL volume: `cnpg_collector_pg_wal{value=count|size|min|max|keep|
  slots_max|volume_size|volume_max}`.
- Instance facts: `cnpg_collector_up{cluster}`,
  `cnpg_collector_postgres_version{full}`, `cnpg_collector_fencing_on`,
  `cnpg_collector_manual_switchover_required`,
  `cnpg_collector_sync_replicas{value=observed|min|max|expected}`,
  `cnpg_collector_nodes_used`, `cnpg_collector_replica_mode`.
- **Deprecated** (zero with plugin backups):
  `cnpg_collector_last_available_backup_timestamp`,
  `cnpg_collector_last_failed_backup_timestamp`,
  `cnpg_collector_first_recoverability_point`.
- Not in the default set: `pg_stat_activity` (per query detail),
  `pg_stat_user_tables`. Sessions by state are already covered by
  `cnpg_backends_total`.
- TLS: opt-in per cluster (`.spec.monitoring.tls.enabled`, default false);
  when on, the same PostgreSQL server certificate serves it, with no
  client authentication. Through the pod proxy the scheme is selected the
  same way as for the status port.

### R7. `kubectl cnpg psql`

Composes and executes `kubectl exec [--context <ctx>] -t -i -n <ns> -c
postgres <pod> -- psql -U postgres [args]`. No `-d` and no `-h`: the
container environment sets `PGHOST=/controller/run` and `PGPORT=5432`, so
psql connects over the local socket with peer authentication. The pod is
the first one carrying the `primary` role label (`replica` with
`--replica`); the plugin does not read `status.currentPrimary`.

### R8. Barman Cloud plugin

Installed in the operator namespace, requires cert-manager and
CloudNativePG >= 1.26; the release asset is a single `manifest.yaml`. An
`ObjectStore` (`barmancloud.cnpg.io/v1`) names the bucket
(`configuration.destinationPath`, `endpointURL`, credentials); its
`serverName` must stay empty (the `serverName` plugin parameter in the
Cluster replaces it). Backups then use `method: plugin` with
`pluginConfiguration.name: barman-cloud.cloudnative-pg.io`.

### R9. Versions pinned for this milestone

CloudNativePG operator `v1.30.0` (release manifest
`releases/cnpg-1.30.0.yaml`), Barman Cloud plugin `v0.15.0`, Kubernetes
`1.34` in kind, Freelens `1.10.3`.

## Architecture decisions

- **A1. Renderer-first.** Everything in 0.1 runs in the renderer: CRD
  stores through `KubeApi` + `KubeObjectStore`, host stores for pods,
  PVCs, services, secrets and events, and the live data through the host's
  Kubernetes JSON API client (`KubeJsonApi`, the protected `request` of
  every `KubeApi`, exposed by a small subclass of ours) addressing the pod
  proxy path. The main process keeps only the scaffold's preferences
  store. Proven by spike S1; fallback is a main-process client with
  `@kubernetes/client-node` (freelens-kafka-extension pattern) behind the
  extension's IPC.
- **A2. No database credentials, ever.** The extension never reads the
  application or superuser secrets' values, never opens a database
  connection, never runs user-supplied SQL. Query-level detail, if it ever
  comes, uses fixed strings over `exec` (M2 spike S2, not in 0.1).
- **A3. Scheme detection for the pod proxy.** Per pod, `https` when the
  `postgres` container command contains `--status-port-tls`, `http`
  otherwise; the metrics port follows `.spec.monitoring.tls.enabled`.
  Every failure names the mechanism and the RBAC it needs (`pods/proxy`).
- **A4. Contracts as typed modules with parsers.** `PostgresqlStatus`, the
  metrics subset above and the CRD types are TypeScript interfaces written
  from the schemas; dedicated, unit-tested parsers handle the Go
  `time.String()` layout, LSN comparison (`X/Y` hexadecimal pairs, never
  lexicographic), PostgreSQL interval strings and the Prometheus text
  format subset the extension reads.
- **A5. Health model in pure functions** (H1 to H5), shared by the list,
  the drawer and the overview so that the three never disagree.
- **A6. psql from the host terminal.** The action composes the same
  command line as the plugin (R7) and hands it to a Freelens terminal tab
  (`createTerminalTab` + `terminalStore.sendCommand`, the
  freelens-kubeswift-extension pattern), with strict single-quoting of
  every interpolated value. The pod is `status.currentPrimary` when set,
  else the first pod with the `primary` role label; "on a replica" offers
  the replica instances by name. The tooltip states the superuser
  connection.
- **A7. Naming.** Sidebar root "CloudNativePG"; the `Cluster` leaf is
  titled "PostgreSQL Clusters" (host collision); qualified `tableId`s
  (`cnpgClustersTable`, `cnpgBackupsTable`, ...).
- **A8. Deprecations are shown, never generated.** `barmanObjectStore`
  backups and deprecated status fields are rendered with a "deprecated"
  badge; no form will ever default to them.
- **A9. Types from the release manifest.** CRD types are written from the
  schemas in `releases/cnpg-1.30.0.yaml`; the E2E cluster applies the same
  manifest from its release URL at cluster creation; nothing from the
  operator repository is vendored.
- **A10. Freelens 1.10.3 and the v1 extension API**, with the CSS injection
  idiom and host globals of the scaffold; migration to the v2 API is a
  milestone of its own when the host ships it.

## Health model

- **H1. Cluster state** (closed set): `Healthy` when phase is "Cluster in
  healthy state", `Ready` is True and `readyInstances == instances`;
  `Progressing` for the setup, replica creation, switchover, failover,
  upgrade, restart, configuration and promotion phases; `Degraded` when
  `Ready` is True but `readyInstances < instances`, or a
  `ContinuousArchiving` or `LastBackupSucceeded` condition is False, or
  some instance is fenced; `Failed` for the unrecoverable, invalid,
  plugin-error and image-catalog phases, or `Ready` False outside a
  progressing phase; `Hibernated` when the hibernation annotation is
  `on`; `Unknown` for an unknown phase string or no status.
- **H2. WAL archiving state**: from the `ContinuousArchiving` condition
  (reason and message), refined on the primary by `lastArchivedWALTime`,
  `lastFailedWALTime` and `readyWalFiles` from `/pg/status` when the live
  view is open.
- **H3. Backup facts from `Backup` objects.** For a cluster, over the
  `Backup` objects whose `spec.cluster.name` matches: last successful
  backup = the latest `stoppedAt` among phase `completed`; last failed
  backup = the latest among phase `failed`; first recoverability point =
  the earliest `stoppedAt` among `completed` (an approximation of the
  retention window, labelled as such). Fallback to the deprecated
  `Cluster.status` fields when the cluster has no `Backup` objects at
  all. The `LastBackupSucceeded` condition is shown alongside.
- **H4. Certificates**: parse `status.certificates.expirations`, map each
  Secret name to its role through the four `*Secret` fields, classify as
  ok, expiring (under 30 days), expired, unknown (unparseable).
- **H5. Instances**: roles from `status.instancesReportedState` and the
  pod labels, health from `status.instancesStatus`, fencing from the
  annotation, topology from `status.topology.instances`.

## Spikes

- **S1** (SPEC-0002): GET `/pg/status` and `/metrics` through the Freelens
  proxy on the pod proxy path, for an `https` and an `http` instance; the
  result decides A1's fallback.
- **S2** (M2): `exec` from the main process with `@kubernetes/client-node`
  on macOS, Linux and Windows; only if a feature needs query-level detail.

## Tests (non-regression list)

- Unit (SPEC-0003): the health model H1 to H5 over hand-written fixtures
  covering every phase string and condition combination; the parsers of
  A4 (Go time layout with and without nanoseconds and zone names, LSN
  ordering, interval strings, metrics text with labels and NaN).
- E2E (SPEC-0002): S1 recorded as a case that reads `/pg/status` of the
  three-instance fixture through the extension and compares `isPrimary`
  and `currentLsn` with `kubectl cnpg status`.

## Notes and deviations

- **Spike S1 passed (2026-09-18, SPEC-0002 suite, Freelens 1.10.3, operator
  1.30.0):** from the cluster frame, `GET /api-kube/api/v1/namespaces/
  cnpg-e2e/pods/https:<pod>:8000/proxy/pg/status` returned the instance
  manager JSON of the primary (`isPrimary: true`, `systemID` equal to
  `Cluster.status.systemID`, a valid `currentLsn`) and of a replica
  (`isPrimary: false`); `/metrics` answered on the plaintext instance
  (`http:` scheme, port 9187) and on the TLS-enabled one (`https:`
  scheme). No credential, no exec, no main-process code. A1 stands:
  renderer-first, with the pod proxy through the host's Kubernetes JSON
  API client.
