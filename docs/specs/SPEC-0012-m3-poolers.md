# SPEC-0012: Poolers, list, detail and live PgBouncer figures (read-only)

- **Status:** Verified
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
- Implementation notes: the drawer has its own lean poller
  (`live/pooler-poller.ts`, one loop, fifteen seconds, nothing while the
  window is hidden or after the drawer closed) instead of the live view's,
  which is built around instances with two endpoints. The pod proxy client
  gained `getPoolerMetrics` and nothing else; its test asserts the three
  paths it can express.
- The `Paused` row became "Accepting clients": a pooler that is not paused
  read `False` in red, against the positive phrasing of DESIGN.md section 2.
- The exporter reports the longest wait as whole seconds plus a microsecond
  remainder (`pools_maxwait`, `pools_maxwait_us`): the model adds them.
- The demo gained a second, small `pgbench` through the pooler. It reconnects
  for every transaction (`--connect`): the pooler pools by session, and with
  long sessions the three clients in excess of the pool of five waited
  forever (observed: `cl_waiting 3`, `maxwait` growing), which shows a
  misconfiguration, not a pooler. On the E2E cluster of the CI nobody
  connects through the pooler, so the E2E case asserts the live section
  whatever it holds.
- The poolers that take their PgBouncer image from a catalog are now listed
  in the drawer of the catalog (SPEC-0010).
- Merged with #30 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `fdcc986`. The manual verification above is part of the M3
  milestone review: the status moves to Verified when its result is recorded
  here.
- After the first pre-review pass of the milestone: the pool of the operator's
  `auth_query` user (`cnpg_pooler_pgbouncer`) showed among the user pools; it
  is the platform's own, like PgBouncer's admin pool, and is left out of the
  figures with it.
- M3 milestone review: 2026-09-19, lead maintainer, on the screenshots of the
  pre-review pass on both themes (gallery on an ephemeral branch, deleted
  after the review). Verdict: approved, no blocking finding. Status moved to
  Verified. Still open for a later look: the states that only unit tests
  cover (a pooler with clients waiting on a screenshot, a catalog follower
  rolling out or asking for a missing major, a quorum at risk, stale or
  reset) and the CRD-absent panel of the optional Barman Cloud plugin.
