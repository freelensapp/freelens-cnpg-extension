# SPEC-0029: Tablespaces and volume snapshots in the Create Cluster form

- **Status:** Implemented
- **Milestone:** `M7` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-24

## Goal

The Create Cluster form of SPEC-0025 also declares the tablespaces of the
cluster, configures backups taken as volume snapshots, and bootstraps a
cluster from the volume snapshots of an earlier backup; the drawer of a
cluster shows its tablespaces and their state; and the E2E cluster carries a
CSI driver with snapshot support, so every one of these paths is proven
against a real snapshot, not against YAML the API server merely accepts.

## Upstream reference

- `Cluster.spec.tablespaces[]` (`name`, `storage`, `owner.name`,
  `temporary`) and `Cluster.status.tablespacesStatus[]` (`name`, `owner`,
  `state` `reconciled` or `pending` or `error`, `error`) at v1.30.0. A
  tablespace becomes one PVC per instance (`<cluster>-<n>-tbs-<name>`) and
  a `CREATE TABLESPACE` the instance manager runs on the primary.
- `Cluster.spec.backup.volumeSnapshot` (`className`, `walClassName`,
  `tablespaceClassName`, `online` default `true`,
  `onlineConfiguration.waitForArchive` default `true`,
  `onlineConfiguration.immediateCheckpoint` default `false`,
  `snapshotOwnerReference` default `none`, `labels`, `annotations`): the
  stanza that makes the `volumeSnapshot` method available to a `Backup` and
  a `ScheduledBackup` (SPEC-0020, SPEC-0021, SPEC-0026 already offer the
  method when the stanza is there). A hot snapshot runs `pg_backup_start`
  and `pg_backup_stop` on the target and keeps the WAL of its window with a
  temporary replication slot; a cold snapshot fences the target for the
  duration of the snapshot, and is refused on a cluster that already has a
  fenced instance (appendix A of the documentation, "Hot and cold
  backups").
- `Cluster.spec.bootstrap.recovery.volumeSnapshots` (`storage`,
  `walStorage`, `tablespaceStorage` as `TypedLocalObjectReference`s of kind
  `VolumeSnapshot` in `snapshot.storage.k8s.io`, or `PersistentVolumeClaim`)
  with the optional `recovery.source` that names the `externalClusters`
  entry holding the WAL archive of the source: the documentation's "Recovery
  from VolumeSnapshot objects" shows both the shape with a WAL archive and
  the shape with the snapshots alone, and warns that the replicas of a
  cluster recovered from a snapshot may be synchronised with
  `pg_basebackup`.
- The labels the operator puts on the snapshots it takes: `cnpg.io/pvcRole`
  (`PG_DATA`, `PG_WAL`, `PG_TABLESPACE`), `cnpg.io/tablespaceName`,
  `cnpg.io/backupName`, `cnpg.io/cluster`, `cnpg.io/backupDate`; and the
  annotation that says whether the backup was hot, so the picker can tell a
  hot snapshot from a cold one.
- The validating webhook rules listed under "Rules the form enforces".
- The creation form of the other graphical interface for CloudNativePG
  declares tablespaces and volume snapshots in its cluster form: scope
  reference only.

## Scope

Included: a "Tablespaces" section of the Create Cluster form; a "Volume
snapshots" block in its "Backup options"; a third source of the recovery
bootstrap, "the volume snapshots of a backup", with the optional WAL
archive of the source; the `VolumeSnapshot` and `VolumeSnapshotClass`
readers the pickers need (list only, no page, no store of their own); the
"Tablespaces" rows of the cluster drawer and the "Volume snapshot backups"
row of its backups section; the CSI hostpath driver, the snapshot
controller, a storage class and a snapshot class in the E2E cluster; a
fixture cluster on that storage class with a tablespace and cold volume
snapshot backups, and the E2E cases of the three paths.

Excluded, and where it goes: a snapshot class per tablespace
(`tablespaceClassName`: the operator defaults it to the data class, and the
YAML pane can be copied to add it); labels and annotations on the
snapshots; recovery from a `PersistentVolumeClaim` (the same field accepts
it, the form offers snapshots); editing the tablespaces of an existing
cluster (the host's YAML editor: the operator refuses to remove one anyway,
see the rules); hot snapshots explicitly targeted at the primary as a
distinct option (the backup target of SPEC-0025 already covers the target).

## Design

### Standard or ad hoc view, and why

The same dialog as SPEC-0025, with three more places where a fact the
operator will act on is asked by name, refused with a reason, and shown as
the exact YAML: nothing here calls for a page.

### The Tablespaces section

Collapsed, right after "Storage". A list of rows, each with: **name** (a
PostgreSQL identifier: letters, digits, `_` and `$`, starting with a letter
or `_`, 63 characters at most, never beginning with `pg_`, unique among the
rows ignoring case, and never colliding with another row once the operator
turns it into a volume name, where every character that is not a letter or
a digit becomes a dash); **size** (a quantity above zero, as the data
volume); **storage class** (the same picker as the data volume, "the
default storage class" sends nothing); **owner** (an identifier, optional:
the effective value is the owner of the application database, else
`postgres`, shown and never sent); **temporary** (a checkbox: the
tablespace joins `temp_tablespaces`). An "Add tablespace" button appends a
row, a row has its own remove button, the errors of a row sit at its
fields and the section title says how many rows there are.

The section's hint says what the operator refuses later, so the user
decides now: a tablespace cannot be removed once created, its volume can
grow and never shrink, and the section itself cannot be deleted once the
cluster has one.

The write summary notes, when there are rows: "N tablespace(s): the
operator creates one volume per instance and per tablespace
(`<name>-<n>-tbs-<tablespace>`) and runs `CREATE TABLESPACE` on the
primary".

### The Volume snapshots block

Inside "Backup options", after the backup target. A checkbox, **Take
backups as volume snapshots**, that is dimmed with the reason when the
`VolumeSnapshot` CRD is not in the Kubernetes cluster (the same read as
SPEC-0026: a `404` on the CRD is an answer, anything else leaves the
checkbox enabled and the hint says the CRD could not be checked). When
checked: **snapshot class** (a picker over the `VolumeSnapshotClass`
objects of the Kubernetes cluster, F7 applies: a typed name is accepted;
"the default snapshot class of the CSI driver" sends nothing, and the hint
says the class must belong to the driver of the storage class, which the
form cannot check); **WAL snapshot class** (offered only with a WAL volume,
optional, the effective value is the snapshot class); **hot or cold** (a
radio: *hot*, the default, "PostgreSQL stays open, the WAL of the snapshot
window is kept with a temporary slot"; *cold*, "the target is fenced for
the duration of the snapshot: on a cluster of one instance the database is
unavailable meanwhile, and the operator refuses a cold snapshot while an
instance is fenced"); with *hot*, two checkboxes with their effective
values, **wait for the WAL archive** (default on: `pg_backup_stop` waits
for the last segment to be archived) and **immediate checkpoint** (default
off); **owner of the snapshots** (a choice: none, the cluster, the backup;
effective `none`, sent only when chosen).

Only what differs from the operator's defaults is sent (F8): the block
with nothing chosen sends `backup.volumeSnapshot: {}` with the class when
one is picked, `online: false` for cold, `onlineConfiguration` only with a
changed flag, `snapshotOwnerReference` only when chosen.

The write summary notes: "Backups by volume snapshot are available: the
Back up now action and the schedules can pick the volumeSnapshot method,
and the plugin method stays available when an object store is set". The
summary warns, for hot snapshots without an object store: "A hot snapshot
without WAL archiving: the snapshot is consistent on its own, but nothing
can be replayed past it and the recovery of it cannot reach a later point
in time"; and for cold snapshots on one instance: "Cold snapshots fence the
only instance: the database is unavailable for the duration of every
backup".

### Recovery from volume snapshots

The "Recover from" radio of the bootstrap gains a third choice, *the
volume snapshots of a backup*. With it: **data snapshot** (a picker over
the `VolumeSnapshot` objects of the namespace, the ones labelled
`PG_DATA` by the operator listed first with their backup name and date,
hot or cold from the annotation, a snapshot not ready to use dimmed with
the reason, any other snapshot offered with "not a data snapshot of the
operator" as its reason and never blocked, a typed name accepted);
**WAL snapshot** (offered only when the WAL volume of the new cluster is
enabled, optional, the `PG_WAL` snapshots first; the rule below says why
the WAL volume is required for it); **tablespace snapshots** (one picker
per tablespace row of the form, optional, the `PG_TABLESPACE` snapshots of
that tablespace name first; the hint says that a tablespace of the
snapshot that has no row here makes the recovery fail on the missing
volume); **the WAL archive of the source** (a collapsed block with the
object store picker and the server name of SPEC-0025's object store
recovery: optional; sent as `recovery.source` plus the `externalClusters`
entry when given). The target time of SPEC-0025 stays and requires the WAL
archive: a point in time is reached by replaying WAL, and the snapshots
carry none past their window.

The write summary says "recovery from the volume snapshot `<name>`
(hot|cold, backup `<backup>` of `<cluster>`)", the note that the data
snapshot is restored as the volume of the first instance and that with a
hot snapshot the WAL archive of the source is what finishes the recovery,
and the warning of the documentation when instances is more than one: "the
replicas of a cluster recovered from a snapshot may be synchronised with
`pg_basebackup`, a full copy that is slow on a large database". A hot data
snapshot picked without the WAL archive of the source warns: "A hot
snapshot needs the WAL of its window to finish the recovery: give the
object store the source archived to, or the cluster may not start".

### The drawer

Storage section: one "Tablespaces" table when the spec declares any, with
the name, the size and class, the owner (the effective one when the spec
gives none), "temporary" when set, and the state badge from
`status.tablespacesStatus` (`reconciled` success, `pending` info, `error`
error with the message as tooltip; "not reported yet" when the status has
no entry). Backups and archiving section: a "Volume snapshot backups" row,
hidden without the stanza: the class (or "the driver's default"), "hot" or
"cold", and the owner reference when it is not `none`.

### Rules the form enforces

- A tablespace name is a PostgreSQL identifier of 63 characters at most,
  does not begin with `pg_`, is unique ignoring case, and its sanitised
  volume name is unique (`duplicate tablespace name`, `tablespace names
  beginning 'pg_' are reserved for Postgres`, `tablespace names must be
  valid Postgres identifiers`, `tablespace name results in duplicate volume
  name`).
- The size of a tablespace is a quantity above zero, as the data volume
  (`validateTablespaceStorageSize`).
- A WAL snapshot requires a WAL volume (`A WAL storage configuration is
  required when recovering using a DataSource for WALs`).
- A snapshot source is a `VolumeSnapshot` (the form never sends another
  kind, `Only VolumeSnapshots and PersistentVolumeClaims are supported`).
- Recovery from snapshots and recovery from a `Backup` are exclusive, and
  no `backupID` target goes with snapshots (`Recovery from dataSource is
  not compatible with other types of recovery`): the radio makes them
  exclusive and the form never sends a `backupID`.
- A target time with snapshots requires the WAL archive of the source
  (the operator would start the cluster and fail to reach the target).
- A cold snapshot with `waitForArchive` or `immediateCheckpoint` is
  meaningless: the two checkboxes are offered with *hot* only, and never
  sent with *cold*.

### Non-happy states

- No `VolumeSnapshot` CRD: the checkbox is dimmed with the reason and the
  snapshot choice of the recovery says the same; the rest of the form is
  untouched.
- No snapshot class listed (none exists, or the list is forbidden): the
  picker becomes a text field with the reason, as every picker (F7).
- No snapshot in the namespace: the pickers say so and accept a name.
- The webhook refuses, or does not answer: as SPEC-0025.

### Safety

One `create` of one `Cluster`, as SPEC-0025. The form reads snapshots and
snapshot classes and never writes, deletes or relabels one.

### DESIGN.md conformance

Sections 3, 5, 6, 7, 13 and 14 apply; no new deviation.

### The E2E environment

SPEC-0002 gains, in `e2e/scripts/lib.sh` and `cluster-up.sh`, the CSI
hostpath driver and the external snapshotter the CloudNativePG project
itself uses in its kind clusters, at the versions its testing tools pin:
the three snapshot CRDs, the snapshot controller, the RBAC of the
provisioner, attacher, resizer, health monitor and snapshotter sidecars,
the `hostpath.csi.k8s.io` driver as one StatefulSet, the storage class
`csi-hostpath-sc` (annotated with its default snapshot class) and the
snapshot class `csi-hostpath-snapclass`. The driver is installed before
the operator, because the operator reads the snapshot CRDs at start; on a
cluster that reuses an operator started without them, `cluster-up.sh`
restarts the operator once. The volumes of that driver live on the node
the driver runs on, so every cluster on that storage class has one
instance.

A fixture cluster `e2e-snapshots` in the namespace of the write cases:
one instance on `csi-hostpath-sc`, a tablespace `analytics` on the same
class, WAL archiving to `actions-store`, cold volume snapshot backups
with the class of the driver. The second phase of the bring-up writes a
marker table in that tablespace, then applies the backup
`e2e-snapshot-ok` (method `volumeSnapshot`) and waits for it to complete:
that wait is the proof the snapshot infrastructure works, before any UI
case runs.

## Tests (non-regression list)

- Unit: `cluster-create.test.ts`: every rule above; the body with
  tablespaces, with the snapshot block (defaults not sent, cold, the
  flags, the owner), with the snapshot recovery (with and without the WAL
  archive, with a WAL snapshot, with tablespace snapshots); the notes and
  warnings of the summary; the effective values. `volume-snapshot-v1`
  helpers: role, tablespace, backup, hot or cold, readiness read from the
  labels, annotations and status of a snapshot.
- Integration: unchanged.
- E2E: (1) from the form, a cluster with a tablespace `reports` on the
  default storage class: the YAML pane carries `spec.tablespaces`, the
  object is read back, the operator reports the tablespace `reconciled`
  and the drawer shows it, then the cluster is deleted; (2) Back up now on
  `e2e-snapshots` with the volume snapshot method: the backup completes,
  the drawer of the backup lists the data and the tablespace snapshots;
  (3) from the form, a cluster on `csi-hostpath-sc` with the tablespace
  `analytics` recovered from the snapshots of `e2e-snapshot-ok` (data and
  tablespace): the YAML pane carries `bootstrap.recovery.volumeSnapshots`,
  the object is read back, the cluster becomes healthy, and the marker
  table written before the fixture backup is there, in the tablespace;
  then the cluster is deleted. Plus the refusals at the field: a
  tablespace named `pg_x`, two rows named `Data` and `data`, a target time
  with snapshots and no WAL archive.
- Pre-review: the form with the Tablespaces section opened and one row,
  the Volume snapshots block checked, the snapshot recovery with the
  pickers of the write namespace, on both themes; the drawer of
  `e2e-snapshots`.
- Manual verification: none beyond the milestone review.

## Notes and deviations

- On a real backup (v1.30.0, the E2E cluster), the operator writes the role
  of the volume (`cnpg.io/pvcRole`) and hot or cold (`cnpg.io/onlineBackup`)
  as annotations of the snapshot, copied from the PVC, and the backup name,
  the cluster, the tablespace name and the date as labels: the reader looks
  in both places for each.
- The snapshots and the snapshot classes are read through a `KubeApi` the
  extension builds itself (`autoRegister: false`), because the host has no
  page or store for the kinds and the form only lists them; the reader is a
  file of its own under `src/renderer/api/snapshot/`.
- The picker choices of the shared machinery gained an optional label, so a
  snapshot is offered with its backup, its cluster, its day and hot or cold
  while the value stays its name; the other pickers are unchanged.
- The CSI hostpath driver names the previous plugin image in the manifest of
  its own release; the bring-up sets the tag to the release, as the
  CloudNativePG tooling does. The driver goes in before cert-manager and the
  operator; on a reused cluster whose operator started without the snapshot
  CRDs, the bring-up restarts the operator once.
