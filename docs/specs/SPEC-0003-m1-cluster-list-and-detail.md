# SPEC-0003: PostgreSQL Clusters list and detail (read-only)

- **Status:** Draft
- **Milestone:** `M1` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-18

## Goal

An operator opens Freelens, selects a Kubernetes cluster, and sees every
CloudNativePG `Cluster` with its health at a glance in a list; a click opens a
drawer that tells the whole story of that PostgreSQL cluster: instances and
roles, replication, storage, certificates, backups, conditions and the
Kubernetes objects around it, with links to each of them.

## Upstream reference

- `kubectl cnpg status <cluster>` (the reference for what a CloudNativePG
  operator expects to read about a cluster) and `kubectl get clusters` (the
  printer columns: Age, Instances, Ready, Status, Primary).
- `Cluster.status` as recorded in SPEC-0001, R2; labels and annotations, R4.
- Other CloudNativePG user interfaces show a traffic-light health, the
  instance roles and a synchronous replication warning; this spec matches
  that and adds what they lack: backup facts derived from the `Backup`
  objects, certificate expiry, replication slots and topology in the same
  drawer. Functional reference only, no code copied.

## Scope

Included: the `Clusters` list page, the `Cluster` detail drawer, the health
model module and its unit tests, the parsers of SPEC-0001 A4 that the drawer
needs (Go time layout, LSN), the reference loader for pods, PVCs, services
and secrets, the sidebar root and group. Excluded: the Overview page
(SPEC-0004), backups list and detail (SPEC-0005), the live view (SPEC-0006),
psql (SPEC-0007), any action.

## Design

### Standard or ad hoc view, and why

Standard. A list of Kubernetes objects with a drawer is the right vocabulary
for "which PostgreSQL clusters exist and how is each one", and it is what the
Overview (SPEC-0004) drills down into. What makes it more than a `kubectl
get` is the health classifier and the drawer content.

### Sidebar

Root "CloudNativePG" with an original monochrome icon; group "Clusters" with
the leaf "PostgreSQL Clusters" (host collision rule, DESIGN.md section 4).
Menu ids `cnpg`, `cnpg-clusters`, `cnpg-clusters-clusters`; `tableId`
`cnpgClustersTable`.

### CRD model

`src/renderer/api/cnpg/cluster-v1.ts`: `Cluster` KubeObject with typed
`ClusterSpec` and `ClusterStatus` interfaces written from the schema (full
status surface of SPEC-0001 R2; spec limited to what the views read:
`instances`, `imageName`, `imageCatalogRef`, `postgresql.parameters`,
`storage`, `walStorage`, `backup`, `plugins`, `monitoring`, `bootstrap`,
`replica`, `enableSuperuserAccess`, `primaryUpdateStrategy`,
`primaryUpdateMethod`, `minSyncReplicas`, `maxSyncReplicas`,
`postgresql.synchronous`, `resources`, `affinity`, `certificates`,
`externalClusters`, `managed`), plus static helpers (no instance methods):
`Cluster.getHibernation(object)`, `Cluster.getFencedInstances(object)`,
`Cluster.getCondition(object, type)`, `Cluster.getPrimary(object)`.
`ClusterApi` and `ClusterStore` exported as usual.

### Health model (`src/renderer/components/cluster-health.ts`, pure)

Implements SPEC-0001 H1 to H5 over the `Cluster` object and, when given,
the cluster's `Backup` objects:

- `classifyCluster(cluster)`: `{ state, label, className, reason }` with
  `state` in `Healthy | Progressing | Degraded | Failed | Hibernated |
  Unknown`, `className` in the host's `success | warning | error | info`,
  `reason` the sentence the Status column and the tooltip show (the phase
  string, or the failing condition's message).
- `archivingState(cluster)`: `{ state: Archiving | Failing | Unknown,
  message }` from `ContinuousArchiving`.
- `backupFacts(cluster, backups)`: `{ lastSuccessful, lastFailed,
  firstRecoverabilityPoint, source: "backups" | "status" | "none" }` (H3).
- `certificateFacts(cluster, now)`: one entry per known role with
  `{ role, secretName, expiresAt, state: ok | expiring | expired | unknown }`
  (H4), using `parseGoTime` from `src/renderer/components/go-time.ts`.
- `instanceFacts(cluster)`: per instance `{ name, role: primary | replica |
  unknown, health: healthy | replicating | failed | unknown, fenced, node,
  ip, timeline }` (H5).
- `compareLsn(a, b)` in `src/renderer/components/lsn.ts`.

Every function has unit tests over hand-written fixtures covering all 22
phase strings, every condition combination, hibernation and fencing, the
deprecated status fallback of H3, the Go time layout with and without
fractional seconds and with named and numeric zones, and LSN ordering.

### List page (`src/renderer/pages/clusters-page-v1.tsx`)

Columns, in the grammar of DESIGN.md section 1:

| Column | Content | Sort |
| --- | --- | --- |
| Name | name | name |
| Namespace | `NamespaceSelectBadge` | namespace |
| Instances | `readyInstances/instances` as text, plus one `StatusBrick` per instance (primary marked) | ready instances |
| Primary | `status.currentPrimary`; when `targetPrimary` differs, an inline warning icon with tooltip "switching to <target>" | primary |
| PostgreSQL | major version from `status.pgDataImageInfo.majorVersion`, tooltip with the image | major |
| Archiving | `BadgeBoolean` from `archivingState` (positive phrasing "Archiving") | archiving |
| Last backup | `ReactiveDuration` of `backupFacts.lastSuccessful` from the cluster's backups, tooltip with the exact time and the source; "N/A" when none | time |
| Condition | `Badge` with `classifyCluster(cluster).label` in its class | state |
| Status | `classifyCluster(cluster).reason` truncated with tooltip | reason |
| Age | `KubeObjectAge` | creation |

The list reads the `Backup` store to feed "Last backup"; the store is
registered by this spec (SPEC-0005 adds its own page on top).

### Drawer (`src/renderer/details/cluster-details-v1.tsx`)

Sections, in order, each a self-guarding component:

1. **Health**: condition badge and reason, phase, hibernation and fencing
   facts, the five conditions as a nested table (type, status, reason, age,
   message).
2. **Instances**: nested table with name (`LinkToPod`), role, health, node
   (`LinkToNode`), IP, timeline, fenced; below it the primary timestamps
   (`LocaleDate`) and the target primary when a switchover is in flight.
3. **Replication**: sync configuration from spec (`minSyncReplicas`,
   `maxSyncReplicas` or `postgresql.synchronous`), a warning when the
   observed synchronous replicas are below the minimum, the topology as a
   list of node to instances, `status.timelineID`.
4. **PostgreSQL**: image, major version, extensions of
   `pgDataImageInfo`, system id, the `postgresql.parameters` count with a
   read-only Monaco block of the parameters.
5. **Storage**: size and class of `storage` and `walStorage`, the PVC lists
   (healthy, dangling, resizing, initializing, unusable) as `LinkToPvc`
   rows.
6. **Backups and archiving**: archiving state and message, plugin and
   object store references from `spec.plugins` (`LinkToObject` to the
   `ObjectStore` when its store exists, else text), the backup facts with
   their source, a "deprecated" badge when the in-tree `barmanObjectStore`
   is configured.
7. **Certificates**: nested table role, secret (`LinkToSecret`), expires
   (`LocaleDate`), state badge.
8. **Services and secrets**: `writeService`, `readService`, the `-r`
   service, the application secret, the superuser secret when
   `enableSuperuserAccess` is true (name only, never the value), the CA
   secrets; all as links when the objects exist.
9. **Plugins**: `status.pluginStatus` as a nested table (name, version,
   capabilities, status).

The host's metadata block and printer-column rows stay (DESIGN.md section
3). References resolve through a reference loader
(`src/renderer/components/reference-loader.ts`) that asks the pod, PVC,
service and secret stores for the cluster's namespace, retries and watches.

### Non-happy states

Loading and empty list by the layout; render errors by `withErrorPage`; the
CRD-absent panel (`createAvailableVersionPage` idiom of the scaffold,
tri-state) when `clusters.postgresql.cnpg.io` is missing, naming the
operator; a cluster without status (just created) renders `Unknown` with
"No status reported yet" and empty sections hidden.

### Themes

Both themes verified by the pre-review pass screenshots and the milestone
review; no colors authored (DESIGN.md section 5).

### Safety

Reads only. No secret values are ever fetched: the drawer links to secrets
by name through the host's own secret page.

## Tests (non-regression list)

- Unit: `src/renderer/components/cluster-health.test.ts` (classifier over
  all phases and condition combinations, archiving, backup facts with the
  three sources, certificates, instances), `go-time.test.ts`,
  `lsn.test.ts`, `src/renderer/api/cnpg/cluster-v1.test.ts` (static
  helpers).
- Integration: the scaffold's activation case, unchanged.
- E2E (appended to `cnpg-e2e.tests.ts`): the Clusters page lists the four
  fixtures with `e2e-main` Healthy 3/3 and Archiving, `e2e-single` Degraded
  with archiving failing, `e2e-hibernated` Hibernated, `e2e-fenced`
  Degraded with the fenced instance; the `e2e-main` drawer shows three
  instances with one primary, the two nodes in the topology, four
  certificates with future expiry, the completed backup as last backup
  with source "backups", and every service, secret and PVC link resolving.
- Manual verification: both themes on a real Freelens (milestone review).

## Notes and deviations

Filled during implementation when reality diverges from the plan.
