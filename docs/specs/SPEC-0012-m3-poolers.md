# SPEC-0012: Poolers, list, detail and live PgBouncer figures (read-only)

- **Status:** Approved
- **Milestone:** `M3` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator sees every PgBouncer pooler, which cluster and which service
type it fronts, whether it is active or paused, and, in its drawer, what the
pooler is doing right now: clients, servers, clients waiting for a
connection, how long they wait.

## Upstream reference

- `Pooler` of `postgresql.cnpg.io/v1`: `spec.cluster.name`, `spec.type`
  (`rw`, `ro`, `r`), `spec.instances`, `spec.pgbouncer` (`poolMode` session or
  transaction, `parameters`, `paused`, `image` or `imageCatalogRef`, custom
  `pg_hba`, TLS secrets); `status.phase` (`active`, `paused`, `inactive`,
  `failed`) with `phaseReason` and `error`, `status.instances`,
  `status.image`, `status.secrets`. Printer columns: Cluster, Type, Phase.
- Observed on the E2E cluster: the deployment, the service and the pods of a
  pooler carry the label `cnpg.io/poolerName`; every pooler pod exposes the
  PgBouncer exporter on port 9127 (`/metrics`, plain HTTP unless
  `spec.monitoring.tls.enabled`), prefix `cnpg_pgbouncer_`: `lists_*`
  (used and free clients and servers, pools, databases), `pools_*` per
  database and user (`cl_active`, `cl_waiting`, `sv_active`, `sv_idle`,
  `sv_used`, `maxwait`, `maxwait_us`), `stats_*` per database (average query
  and transaction counts, query and wait times, bytes). Reachable through the
  API server pod proxy like the instance endpoints. Functional reference
  only.

## Scope

Included: the typed model, the "Poolers" list in a "Pooling" sidebar group,
the drawer with its live section, the poolers of a cluster in the Cluster
drawer and on the Live View (a row of pooler chips under the topology, each a
door), the third and last read endpoint of the pod proxy client
(`getPoolerMetrics`). Excluded: pausing and resuming (M6), editing
parameters, per query PgBouncer statistics beyond the default exporter.

## Design

### Standard or ad hoc view, and why

Standard list and drawer for the object; the live figures are a section of
the drawer, not a page: a pooler has a handful of numbers, and they belong
next to its configuration, which is what explains them (a pool size of 5
explains 3 clients waiting).

### Pure modules

`src/renderer/components/poolers.ts`: `classifyPooler(pooler)` (`Active`
success with ready over declared instances, `Paused` warning, `Inactive`
info, `Failed` error with `phaseReason` or `error`, `Progressing` while
ready instances lag the declared ones, `Unknown`), `poolerServiceHost`
(`<name>.<namespace>.svc`), `poolersOfCluster`.
`src/renderer/components/live/pooler-model.ts`: from the samples of every
pooler pod to `{ clients: { active, waiting, free }, servers: { active,
idle, used, free }, pools: [{ database, user, clActive, clWaiting, svActive,
svIdle, maxWaitMs, mode }], longestWaitMs, level }`, summed over the pods,
the PgBouncer admin pool left out of the user figures; warning when any
client waits, error when the longest wait passes 5 seconds (named
constants).

### List

`Name | Namespace | Cluster | Type | Pool mode | Instances | Image |
Condition | Status | Age`. Cluster is a link; Type reads `rw (primary)`, `ro
(replicas)`, `r (any)`; Instances is ready over declared. `tableId`
`cnpgPoolersTable`; menu ids `cnpg-pooling`, `cnpg-pooling-poolers`.

### Drawer (`src/renderer/details/pooler-details-v1.tsx`)

1. **Pooler**: condition and status, cluster (link), type in words, service
   host (selectable: it is what an application puts in its connection
   string), pool mode, instances, image or catalog reference, paused.
2. **Right now** (live, polled every 15 s while the drawer is open, the
   interval shown, stops when hidden): clients active, waiting and free;
   servers active, idle, used; longest wait; the pools table. Failure states
   as the live view (the `pods/proxy` sentence included).
3. **PgBouncer parameters**: key and value table; custom `pg_hba` lines in a
   preformatted block.
4. **Pods, service and secrets**: links, from the label and from
   `status.secrets`.

### Non-happy states

As every list and as the live view for the live section; a paused pooler
says that clients queue until it is resumed.

### Safety

Reads only. The pod proxy client gains exactly one more `GET` path
(`/metrics` on 9127): it still cannot express anything else. No secret
value is read.

## Tests (non-regression list)

- Unit: `poolers.test.ts`, `pooler-model.test.ts` (a recorded answer of the
  exporter, the admin pool left out, sums over two pods, the wait levels),
  the pod proxy client test extended to the third endpoint.
- E2E: the list shows `e2e-main-pooler` Active, `rw (primary)`, session,
  1/1; the drawer shows the service host, the live section with its figures
  and the pool of the demo client; the Cluster drawer and the Live View of
  `e2e-main` lead to it.
- Manual verification: the M3 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M3 at the
  milestone review.
