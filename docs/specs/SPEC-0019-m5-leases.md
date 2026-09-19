# SPEC-0019: Primary lease and operator lease (read-only)

- **Status:** Implemented
- **Milestone:** `M5` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

The lease that makes the election of a primary safe is visible where the
primary is: who holds it, since when, whether it is being renewed, how many
times it changed hands, and what its timings mean for a failover.

## Upstream reference

- "Safe primary election" (failover, v1.30.0): a `Lease`
  (`coordination.k8s.io/v1`) named after the `Cluster`, in its namespace,
  owned by it and labelled `cnpg.io/cluster`. An instance must hold it
  before it promotes; the primary releases it on a clean shutdown (the
  released lease has an empty holder and the short
  `releasedLeaseDurationSeconds`), otherwise it expires after
  `leaseDurationSeconds`. The timings are `.spec.primaryLease`
  (`leaseDurationSeconds` 15, `renewDeadlineSeconds` 10,
  `retryPeriodSeconds` 2, `releasedLeaseDurationSeconds` 1 by default).
  The lease prevents a premature promotion; the primary isolation check is
  what stops an isolated primary, and both are on by default.
- The operator's own leader election lease is covered by SPEC-0016.

## Scope

Included: the `leaseFacts` model (shared with SPEC-0016); a "Primary lease"
block in the Replication section of the Cluster drawer; the lease as an
entry of the timeline (SPEC-0017). Excluded: any action on a lease.

## Design

### Standard or ad hoc view, and why

Rows in the existing drawer: a lease is five facts and one sentence.

### Pure module (`src/renderer/components/leases.ts`)

`leaseFacts(lease, now)`: holder, acquired, renewed, duration, transitions,
`current` (renewed within twice the duration). `primaryLeaseHealth(lease,
cluster, now)`:

- `Held` (success): the holder is the current primary and the lease is
  current;
- `Released` (info): no holder, as after a clean shutdown or on a
  hibernated cluster;
- `Stale` (warning): a holder that stopped renewing: "after N seconds
  without renewal another instance may promote";
- `Mismatch` (warning): the holder is not the instance the cluster reports
  as primary (a switchover or a failover in progress);
- `Missing` (info): no lease object (an operator older than the feature,
  or no permission).

`leaseTimingWords(cluster)`: the timings in effect as one sentence.

### Cluster drawer

Replication section: "Primary lease" badge with the state sentence, holder
as a link to its pod, held since, last renewal (relative, ticking),
transitions, timings.

### Non-happy states

Forbidden on leases: the row says so and nothing else changes.

### Safety

Reads only.

## Tests (non-regression list)

- Unit: `leases.test.ts` (every state at its edges, the released lease of
  a hibernated cluster as observed, timings with and without overrides).
- E2E: the drawer of `e2e-main` shows the lease Held by its primary with a
  link to the pod; the drawer of `e2e-hibernated` shows it Released.
- Manual verification: the M5 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M5 at the
  milestone review.
- Implementation notes: the lease is read from the host's own store of
  leases, reached through the API manager by its API base, so the extension
  registers no API for a kind the host already has and the holder pod links
  to the host's panel. The watch of the namespace keeps "Last renewal"
  ticking. The timing sentence says "(the defaults)" when the cluster declares
  no `primaryLease`.
- Seen live on the E2E cluster (operator 1.30.0): Held by the primary of
  `e2e-main`, Released on the hibernated cluster (empty holder, one second
  duration). Covered by unit tests only: Stale, Mismatch, Missing, tuned
  timings.
- Merged with #43 on 2026-09-19; the unit, integration and E2E workflows ran
  green on the pull request. The manual verification above is part of the M5
  milestone review: the status moves to Verified when its result is recorded
  here.
