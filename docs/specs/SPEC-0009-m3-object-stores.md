# SPEC-0009: Object Stores (Barman Cloud plugin), list and detail (read-only)

- **Status:** Implemented
- **Milestone:** `M3` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`, Barman Cloud plugin `v0.15.0`
  (drift watch of 2026-09-19: both still the latest)
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator sees where the backups and the WAL of every PostgreSQL cluster
go, which clusters write to each object store, and how far back each of them
can be recovered according to the plugin itself.

## Upstream reference

- The `ObjectStore` kind of `barmancloud.cnpg.io/v1` (SPEC-0001 R8): the
  bucket (`configuration.destinationPath`, `endpointURL`), the credentials by
  reference, WAL and data compression and encryption, the retention policy.
- Observed on the E2E cluster (plugin 0.15.0): `status.serverRecoveryWindow`
  is a map from the server name to `firstRecoverabilityPoint`,
  `lastSuccessfulBackupTime` and `lastFailedBackupTime`. It is the plugin's
  own account of the recovery window, per cluster that writes to the store.
- A cluster points at a store through `spec.plugins[].parameters`
  (`barmanObjectName`, and `serverName` when it differs from the cluster
  name). Functional reference only.

## Scope

Included: the typed model of `ObjectStore`, the "Object Stores" list in the
Backups group, its drawer, the referring clusters, and the doors that M2 left
as plain text (the object store of the Backup drawer and of the Cluster
drawer become links). The backup facts of the health model (H3) take the
first recoverability point from the store when the cluster uses the plugin.

Excluded: editing a store, testing its credentials, browsing the bucket.

## Design

### Standard or ad hoc view, and why

Standard: a store is a Kubernetes object, and "which stores exist, who
writes to them, how far back do they go" fits a list and a drawer.

### Model and pure module

`src/renderer/api/barmancloud/object-store-v1.ts`: `ObjectStore`, `ObjectStoreApi`,
`ObjectStoreStore`, with the typed `spec.configuration` and
`status.serverRecoveryWindow`. `src/renderer/components/object-stores.ts`
(pure, tested):

- `storeProvider(store)`: `S3`, `Azure Blob`, `Google Cloud Storage` from
  the scheme of `destinationPath` and the credentials block; `S3 compatible`
  when an `endpointURL` is set;
- `clustersOfStore(store, clusters)`: the clusters of the same namespace whose
  plugin entry names the store, with the server name they write under
  (`parameters.serverName`, else the cluster name) and whether the store is
  their WAL archiver;
- `recoveryWindows(store, clusters, now)`: one entry per server of
  `status.serverRecoveryWindow`, joined to its cluster when there is one
  (a server without a cluster is an orphan worth seeing: backups of a
  deleted cluster still in the bucket), with a state: `Protected` (a
  successful backup and no newer failure), `Failing` (the last failure is
  newer than the last success, or there is no success), `Empty`;
- `classifyStore(store, clusters)`: `In use`, `Unused`, `Failing` (some
  server failing), with the host class and the sentence for the Status
  column.

### List (`src/renderer/pages/object-stores-page-v1.tsx`)

`Name | Namespace | Provider | Destination | Clusters | Retention | Oldest
recovery point | Condition | Status | Age`. Clusters is a count with the
names in the tooltip; Oldest recovery point is the earliest
`firstRecoverabilityPoint` among its servers as a relative time. `tableId`
`cnpgObjectStoresTable`, menu id `cnpg-backups-objectstores`, third leaf of
the Backups group.

### Drawer (`src/renderer/details/object-store-details-v1.tsx`)

1. **Store**: condition and status, provider, destination path, endpoint,
   endpoint CA secret (link), retention policy, server name override when set.
2. **Credentials**: which secret and which keys are referenced (links to the
   secrets, never a value), or "inherited from the platform" for IAM role,
   Azure AD and GKE.
3. **WAL and data**: compression, encryption, parallelism, tags.
4. **Recovery windows**: nested table, one row per server: server, cluster
   (link, or "no cluster" for an orphan), first recoverability point, last
   successful backup, last failed backup, state.
5. **Clusters**: the referring clusters with their role for the store (WAL
   archiver or backups only), links to their drawers; a door to the Backups
   list filtered by cluster for each.

### Doors

The object store row of the Backup drawer and the plugin row of the Cluster
drawer become links to the store's drawer (`StoreLink`). H3 changes: when
the cluster writes to a store whose status has its server, "First
recoverability point" comes from the store and says so (source "object
store"); the earliest completed `Backup` stays the fallback.

### Non-happy states

The plugin's CRD absent: the page says that the Barman Cloud plugin is not
installed (it is optional) instead of naming the operator. A store without
status: `Unused` or `In use` by reference only, recovery windows hidden.

### Safety

Reads only. Secrets are linked by name; no value is read.

## Tests (non-regression list)

- Unit: `object-stores.test.ts` (provider detection, referring clusters with
  and without a server name override, orphan servers, the three window
  states, the store classification), H3 with the store as the source.
- E2E: the list shows `e2e-store` In use by `e2e-main` and `e2e-store-broken`
  Failing; the drawer of `e2e-store` shows the recovery window of `e2e-main`
  with a first recoverability point and links to the cluster and to the
  credentials secret; the Backup drawer links to the store.
- Manual verification: the M3 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M3 at the
  milestone review.
- Implementation notes: the backup facts gained a source, "object store": when
  a cluster has no `Backup` object left, the last successful and the last
  failed backup come from the recovery window of its server (the backups are
  in the bucket even when their objects were deleted), before the deprecated
  status fields. The first recoverability point says where it comes from in
  the Cluster drawer. The list, the drawer and the Overview all pass the
  stores to the same function, so they cannot disagree.
- The times of the recovery windows table are relative, with the exact time
  in the tooltip: four dates do not fit one drawer row. The exact first
  recoverability point is in the Cluster drawer, and the E2E suite compares it
  with what the plugin wrote in the status of the store.
- The CRD-absent panel takes a hint, so the Object Stores page says that the
  Barman Cloud plugin is optional instead of naming the operator.
- The E2E case of the psql terminal now closes its dock tabs: they covered
  half of every view that followed.
- Merged with #26 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `ab98c0e`. The manual verification above is part of the M3
  milestone review: the status moves to Verified when its result is recorded
  here.
