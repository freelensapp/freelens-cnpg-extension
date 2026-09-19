# SPEC-0011: Failover Quorums, list and detail (read-only)

- **Status:** Implemented
- **Milestone:** `M3` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

For a cluster with quorum based failover, an operator sees at a glance
whether a failover could be decided safely right now: which standbys are
potentially synchronous, how many must confirm, and whether enough of them
are there.

## Upstream reference

- `FailoverQuorum` of `postgresql.cnpg.io/v1`: one object per cluster with
  `spec.postgresql.synchronous.failoverQuorum: true`, named after the
  cluster, status only: `method` (`any`, `first`), `primary` (the instance
  that wrote it last), `standbyNames` (the potentially synchronous
  instances), `standbyNumber` (how many must confirm). It is written by the
  instance manager of the primary and reset by the operator.
- The check the operator performs before promoting a replica (upstream
  documentation, "Failover Quorum", v1.30.0): with R the promotable replicas
  (part of the cluster, able to report their state, potentially
  synchronous), W the replicas that must acknowledge a commit and N the
  potentially synchronous replicas, a promotion is safe when `R + W > N`;
  otherwise the operator promotes nothing and waits. While the PostgreSQL
  configuration changes the object is reset, which prevents any failover
  until the primary writes it again. Functional reference only; the
  sentences shown to the user are ours.

## Scope

Included: the typed model, the "Failover Quorums" list in the Clusters
group, its drawer, a "Failover quorum" row in the Replication section of the
Cluster drawer. Excluded: any action, any prediction beyond the rule above.

## Design

### Standard or ad hoc view, and why

Standard list and drawer; the quorum arithmetic is a pure function shown as
one sentence, not a chart: there is one number to understand.

### Pure module (`src/renderer/components/failover-quorum.ts`)

- `quorumFacts(quorum, cluster?)`: N (the named standbys), W
  (`standbyNumber`), and R as the extension can see it: the named standbys
  the cluster status reports healthy. It is an estimate for the reader; the
  operator's own check at failover time is the authority, and the drawer
  says so. Whether the object is current (its `primary` equals the cluster's
  current primary), and the state:
  - `Safe`: `R + W > N`, "a failover could be decided safely: R of N
    potentially synchronous standbys are healthy and W must confirm";
  - `At risk`: `R + W <= N`, "the operator would promote nothing: ...";
  - `Stale`: written by an instance that is no longer the primary;
  - `Reset`: no standby names: the operator reset it while the configuration
    changes, and no failover happens until the primary writes it again;
  - `Orphan`: its cluster is not there.

### List and drawer

List: `Name | Namespace | Cluster | Method | Must confirm | Standbys |
Condition | Status | Age`. Drawer: **Quorum** (condition, status sentence,
method, must confirm, written by) and **Standbys** (nested table: instance
as a link to its pod, healthy per the cluster status). Cluster drawer,
Replication section: "Failover quorum" row with the condition badge and a
link to the object, hidden when the cluster has none.

### Non-happy states

As every list; the empty list explains that the kind exists only for
clusters with `failoverQuorum` enabled.

### Safety

Reads only.

## Tests (non-regression list)

- Unit: `failover-quorum.test.ts` (the rule at its edges, stale, reset, a
  quorum without its cluster).
- E2E: `e2e-main` runs with `synchronous: { method: any, number: 1,
  failoverQuorum: true }`; the list shows its quorum Safe with two standbys
  and one that must confirm; the drawer links the standbys; the Cluster
  drawer links the quorum; the live view labels its edges `quorum`.
- Manual verification: the M3 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M3 at the
  milestone review.
- Implementation notes: on 1.30.0 `status.method` is written in upper case
  (`ANY`), so the views compare it case insensitively and show it as written.
  The drawer has a "How to read it" row that states the check and says that
  the operator's own check is the authority. A fenced standby does not count
  as healthy.
- Observed on the local E2E cluster (operator 1.30.0): when the failover
  quorum was turned on for a cluster that was already running, the instance
  manager wrote the synchronous settings to `custom.conf` and then failed
  every reconciliation on `SHOW cnpg.synchronous_standby_names_metadata`
  (unrecognized configuration parameter), before ever reloading the
  configuration, so the `FailoverQuorum` stayed empty and replication stayed
  asynchronous. One `pg_reload_conf()` on the primary unblocked it. A cluster
  created with the setting does not go through this. `cluster-up.sh` waits for
  the quorum and, only if it stays empty, reloads once and says so in its log.
  The views need nothing special: an empty quorum is the `Reset` state.
