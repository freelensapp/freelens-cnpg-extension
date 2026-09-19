# SPEC-0015: Publications and Subscriptions, list and detail (read-only)

- **Status:** Verified
- **Milestone:** `M4` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator reads a logical replication as one thing: which publication of
which cluster feeds which subscription of which other cluster, whether both
ends are applied, whether the replication slot is being consumed right now,
and whether the pair survives a failover of the publisher.

## Upstream reference

- `Publication` (CRD schema and "Logical Replication", v1.30.0):
  `spec.cluster.name`, `spec.dbname`, `spec.name` (all immutable),
  `spec.target` with either `allTables` or `objects` (each a `table` with
  `schema`, `name`, `only`, `columns`, or a `tablesInSchema`),
  `spec.parameters` (the `WITH` clause), `spec.publicationReclaimPolicy`.
- `Subscription`: `spec.cluster.name`, `spec.dbname`, `spec.name`,
  `spec.externalClusterName` (an entry of `externalClusters` of the
  subscriber cluster), `spec.publicationName`, `spec.publicationDBName`
  (defaults to the database of the external cluster entry),
  `spec.parameters`, `spec.subscriptionReclaimPolicy`.
- Status of both: `applied`, `message`, `observedGeneration`, with the
  semantics of SPEC-0013.
- PostgreSQL facts: a subscription consumes a logical replication slot on
  the publisher, named after the subscription unless the `slot_name`
  parameter says otherwise; schema, sequences and large objects are not
  replicated. The exporter of an instance reports every slot with its
  database, type, whether it is active and the WAL it retains
  (`cnpg_pg_replication_slots_*`).
- Failover of the publisher: the slot survives only when the cluster
  synchronizes the logical decoding slots
  (`spec.replicationSlots.highAvailability.synchronizeLogicalDecoding`).
  Functional reference only; the sentences shown are ours.

## Scope

Included: the typed models, the two lists and drawers, the resolution of
the pair, the slot read from the publisher. Excluded: any action, any SQL
(table counts, subscription state in the catalog), publishers outside this
Kubernetes cluster beyond naming their host.

## Design

### Standard or ad hoc view, and why

Standard lists and drawers, plus one small ad hoc element shared by the two
drawers: the **replication path**, publisher on the left and subscriber on
the right with the direction between them, because the two objects are one
flow and neither drawer alone tells it.

### Pure module (`src/renderer/components/logical-replication.ts`)

- `publicationTarget(publication)`: the words ("All tables", "2 tables, 1
  schema") and the rows (table with schema, only, columns; schema).
- `resolvePublisher(subscription, clusters)`: the subscriber cluster, its
  external cluster entry, the host, user and database, and the `Cluster`
  the host points to when it is a service of a cluster of this Kubernetes
  cluster (`<cluster>-rw|-ro|-r`, optionally with namespace and `svc`
  suffixes; the namespace defaults to the subscriber's). Outcomes:
  `resolved`, `external` (a host that is no cluster here, which is fine),
  `undefined` (no entry with that name: the operator fails it too).
- `publicationOfSubscription(...)` and `subscriptionsOfPublication(...)`:
  the pair by cluster, namespace, database and publication name.
- `slotName(subscription)`, `subscriptionNotes(subscription)` (`enabled`,
  `create_slot`, `connect` set to false change what to expect).
- `failoverSafety(publisher)`: nothing to say for one instance; otherwise
  whether the logical slots follow a failover, as a sentence.
- `slotReading(samples, database, slot)`: active or not, WAL retained.

### Lists and drawers

Publications: `Name | Namespace | Cluster | Database | Publication |
Target | Subscriptions | Condition | Status | Age`. Subscriptions: `Name |
Namespace | Cluster | Database | Subscription | Publisher | Publication |
Condition | Status | Age`. `tableId`: `cnpgPublicationsTable`,
`cnpgSubscriptionsTable`.

Subscription drawer: **Reconciliation**; **Replication path** (publisher
cluster, database and publication as links when resolved, the host when
external, a plain statement when undefined; the subscriber side); **Right
now** (the slot on the publisher's primary: active, WAL retained, read
every 30 seconds; only when the publisher is resolved); **Publisher
failover** (the `failoverSafety` sentence); **Subscription** (cluster,
database, name, parameters, reclaim policy in words, the notes). A fixed
reminder says what logical replication does not carry.

Publication drawer: **Reconciliation**; **Publication** (cluster, database,
name, target in words, parameters, reclaim policy); **Published objects**
(nested table, hidden for all tables); **Subscriptions** (the ones found
here, as links with their condition, and the logical slots of the database
on the primary, active or not).

### Non-happy states

As every list. A publisher that cannot be read shows the typed failure in
one sentence and nothing else changes.

### Safety

Reads only. The extension never reads the password of an external cluster
entry; it shows the host, the user and the database.

## Tests (non-regression list)

- Unit: `logical-replication.test.ts` (targets, host parsing in every
  form, the pair both ways, slot name and notes, failover sentence, slot
  reading).
- E2E fixtures: on `e2e-main` a publication of one table and one of all
  tables, one of a table that does not exist (Failed); on `e2e-single` an
  external cluster entry for `e2e-main`, the same table, a subscription to
  the one-table publication (Applied, slot active) and one that names an
  external cluster that is not declared (Failed). Cases: both lists show
  their conditions; the subscription drawer links the publisher and its
  publication and shows an active slot; the publication drawer lists its
  subscription; the failover sentence says the slot is not synchronized.
- Manual verification: the M4 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M4 at the
  milestone review.
- Implementation notes: the pairing functions return every match
  (`publicationsOfSubscription`), the drawer links the first. A service host
  is recognised as `<cluster>-rw|-ro|-r` with an optional namespace and an
  optional `svc` suffix with any cluster domain; anything else is an external
  publisher and is shown by its host. The Subscriptions column of the
  Publications list links the subscription when there is exactly one and
  counts them otherwise. The Publication drawer shows one replication path per
  subscription found here, then every logical slot of its database on the
  primary, so a subscriber outside this Kubernetes cluster still shows up as a
  slot without an owner. The subscription notes also cover `copy_data`.
  The drawers of a publisher or subscriber in another namespace read the
  clusters wherever the user can see them.
- Seen live on the E2E cluster (operator 1.30.0): both kinds Applied and
  Failed (a table that is not there, an external cluster that is not
  declared), the resolved pair both ways, the slot of the subscription active
  with the WAL kept for it, the failover sentence for a three-instance
  publisher without slot synchronization, 1000 rows counted on the
  subscriber. Covered by unit tests only: an external publisher, a custom
  `slot_name`, the notes, a publisher with synchronized slots, a missing slot.
- Merged with #38 on 2026-09-19; the unit, integration and E2E workflows ran
  green on the pull request. Two findings of that run were about the suite,
  not the views: closing a drawer aborts the reference loads it had just
  started and the kubectl proxy of the host logs each abort at error level,
  which the error collector took for a failure of the extension on the slower
  runner; and the first key typed into the dock terminal can get lost there.
  Both are handled in the helpers. The manual verification above is part of
  the M4 milestone review: the status moves to Verified when its result is
  recorded here.
- At the closure of M4 the links inside the replication path became plain
  inline links (`StoreLink` with `inline`): the host's truncating tooltip box
  is a block and did not sit on the text line.
- M4 milestone review: 2026-09-19, lead maintainer, on the screenshots of the
  pre-review pass on both themes (gallery on an ephemeral branch, deleted
  after the review). Verdict: approved, no blocking finding. Status moved to
  Verified. Still open for a later look: the states that only unit tests
  cover, listed above.
