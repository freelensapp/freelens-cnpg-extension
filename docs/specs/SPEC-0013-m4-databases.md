# SPEC-0013: Databases, list and detail (read-only)

- **Status:** Implemented
- **Milestone:** `M4` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator sees every database declared for a cluster, whether PostgreSQL
has it as declared, and when it has not, what exactly failed and why, down
to the single extension or schema. The same reading of "applied or not" is
shared by the four declarative kinds of this milestone.

## Upstream reference

- `Database` of `postgresql.cnpg.io/v1` (CRD schema and "PostgreSQL Database
  management", v1.30.0): `spec.cluster.name`, `spec.name` (immutable),
  `spec.owner`, `spec.ensure` (`present`, `absent`),
  `spec.databaseReclaimPolicy` (`retain`, `delete`), the `CREATE DATABASE`
  parameters (encoding, locale family, template, tablespace, connection
  limit, allow connections, is template) and four lists of managed objects:
  `extensions`, `schemas`, `fdws`, `servers`, each entry with its own
  `ensure`.
- Status: `applied`, `message`, `observedGeneration`, and one
  `{ name, applied, message }` entry per managed object.
- How the status is written (instance manager of the primary, v1.30.0),
  the same for `Database`, `Publication` and `Subscription`, and for
  `DatabaseRole` with the additions of SPEC-0014:
  - reconciled: `applied: true`, empty message, `observedGeneration` equal
    to `metadata.generation`;
  - failed: `applied: false` and the error in `message`; the observed
    generation is left where it was;
  - on a replica cluster: `applied` left unset with the message "waiting
    for the cluster to become primary";
  - a managed object that fails makes the whole database fail with a
    generic message, and the detail is in the entry of that object;
  - two objects of the same kind and namespace that target the same
    PostgreSQL name on the same cluster: the second is failed with a
    message that names the first;
  - nothing writes a status while no primary runs (hibernated cluster,
    cluster not there).
- Reserved names (`postgres`, `template0`, `template1`) are rejected at
  admission. Functional reference only; the sentences shown are ours.

## Scope

Included: the typed model; the shared reconciliation model; a new
"Databases" sidebar group; the "Databases" list and its drawer with the
managed objects and the figures of the database read from the primary; a
"Declarative objects" section in the Cluster drawer. Excluded: any action
(creation is an M7 row), any SQL, the databases that exist in PostgreSQL
without a `Database` object (the extension does not query the catalog).

## Design

### Standard or ad hoc view, and why

Standard list and drawer. The drawer adds a "Right now" block because the
size and the connections of a database are what an operator looks for next
to its declaration, and the exporter of the primary already has them.

### Pure module (`src/renderer/components/declarative.ts`)

`classifyDeclarative(object, cluster | undefined, words)` for the four
kinds, closed set of states:

| State | Class | When | Sentence |
| --- | --- | --- | --- |
| `Applied` | success | `applied: true` and the observed generation is current | "Applied to PostgreSQL" |
| `Updating` | info | `applied: true` with an older observed generation | "A change waits to be applied (generation G, applied O)" |
| `Failed` | error | `applied: false` | the message, first line, with the two known conflicts told in words |
| `Waiting` | info | `applied` unset with a message | "Waiting for the cluster to become primary: a replica cluster is read-only" (or the message as written) |
| `Pending` | info | no status, cluster there | "Not applied yet", or "Waiting for a running primary: the cluster is hibernated" when it is |
| `Orphan` | warning | no status and the cluster is not there | "The Cluster X is not there: nothing applies this object" |
| `Deleting` | warning | `metadata.deletionTimestamp` set | what the reclaim policy does: "stays in PostgreSQL" or "is dropped first" |

`Failed` wins over a missing cluster when the operator already said why.
`databaseHealth(database, cluster)` adds two readings on top:

- `Absent` (info): `ensure: absent` and applied, "Absent as declared: the
  database is not in PostgreSQL";
- a failed database with failed managed objects names them: `Extension
  "x" failed: <message>` and how many more.

`managedObjects(database)`: one row per declared extension, schema, FDW and
server, joined by name with its status entry: kind, name, detail (version
and schema, owner, handler, the FDW of a server), ensure, applied (yes, no,
not reported), message. `reclaimWords(policy, what)`: the policy as a
sentence ("Deleting this object leaves the database in PostgreSQL").
`conflictingObjects(object, all)`: the other objects of the same kind,
namespace, cluster and PostgreSQL name, so the drawer links the rival.

### List

Sidebar: a "Databases" group with Databases, Database Roles, Publications,
Subscriptions. List: `Name | Namespace | Cluster | Database | Owner |
Objects | Reclaim | Condition | Status | Age`; "Database" is the PostgreSQL
name, "Objects" the count of managed objects with a warning mark when one
failed, the health words are searchable. `tableId`: `cnpgDatabasesTable`.

### Drawer

- **Reconciliation**: condition, status sentence, generation (declared and
  applied), the rival object as a link on a conflict.
- **Database**: cluster (link), PostgreSQL name, owner, ensure, reclaim
  policy in words, connection limit (`-1` as "Unlimited"), allow
  connections, template flag, tablespace, and only the creation parameters
  that are set (encoding, locale provider and the locale family, template),
  with a note that PostgreSQL cannot change them after creation.
- **Right now**: size, connections by state, transaction ID age, from the
  metrics of the current primary through the pod proxy, every 30 seconds
  while the drawer is open and the window visible; the typed failures of
  SPEC-0006 as one sentence; hidden for `ensure: absent`.
- **Managed objects**: nested table `Kind | Name | Detail | Ensure |
  Applied | Message`; hidden when none is declared.

Cluster drawer, new section **Declarative objects**: one row per kind that
has objects for the cluster, "N applied, M failed, K waiting" with a link
to the list filtered by the cluster name.

### Non-happy states

As every list: loading, empty (explains the kind), forbidden, CRD absent.
The "Right now" block never blocks the drawer.

### Safety

Reads only. No SQL: the figures come from the exporter the cluster already
runs.

## Tests (non-regression list)

- Unit: `declarative.test.ts` (every state, precedence, conflicts, managed
  object join), the metrics reading of a database.
- E2E fixtures on `e2e-main`: a database with one extension and one schema
  (Applied), one with an owner that does not exist (Failed), one with an
  extension that does not exist (Failed, names the extension), a second
  object for the same database (Failed, links the rival), one on the
  hibernated cluster (Pending), one for a cluster that is not there
  (Orphan). Cases: the list shows the six conditions; the drawer of the
  applied one shows the objects and a size; the conflict links its rival;
  the Cluster drawer counts them.
- Manual verification: the M4 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M4 at the
  milestone review.
- Implementation notes: the conflict message of operator 1.30.0 reads
  `"<name>" is already managed by object "<other>"`, shorter than the one in
  the upstream documentation; both are recognised, and the drawer finds the
  rival among the objects, not in the message. "Same target" is shown on both
  sides of a conflict, the applied one included, so the owner of the database
  sees that another object is being ignored. An extension without a version
  reads "default version". The polling loop of the Pooler drawer became the
  shared `SamplesPoller`; `PrimaryMetricsPoller` asks the current primary of a
  cluster every 30 seconds and follows a switchover. The host adds its own
  rows from the printer columns of the CRD above the sections of the drawer.
- Seen live on the E2E cluster (operator 1.30.0): Applied, Absent, Failed on
  the owner, Failed on one extension with the reason in its entry, Failed on
  a conflict, Pending on the hibernated cluster, Orphan; the size of a
  database from the exporter of the primary. Covered by unit tests only:
  Updating, Waiting on a replica cluster, Deleting.
- Merged with #36 on 2026-09-19; the unit, integration and E2E workflows ran
  green on the pull request. The manual verification above is part of the M4
  milestone review: the status moves to Verified when its result is recorded
  here.
