# SPEC-0006: Live database view (read-only)

- **Status:** Verified
- **Milestone:** `M2` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0` (drift watch of 2026-09-19)
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator picks a PostgreSQL cluster and sees what is happening inside it
right now, without credentials and without a terminal: who is primary and
how far behind each standby is, how many sessions are open and what they
are doing, how big the databases are, whether WAL is being archived and how
much is waiting, which replication slots hold WAL back. The data that lives
in no Kubernetes object becomes a page of Freelens.

## Upstream reference

- `kubectl cnpg status <cluster>` (and `--verbose`): the text report this
  view matches and exceeds, built from the same instance manager endpoint.
- The instance manager status endpoint (SPEC-0001 R5) and the metrics
  exporter with the default monitoring queries (R6); the scheme detection
  of A3; spike S1 (passed on 2026-09-18, SPEC-0001 notes), which proved
  both endpoints reachable from the cluster frame through the API server
  pod proxy for `http` and `https` instances.

## Scope

Included: the "Live View" page with its cluster picker, the pod proxy
client, the typed contracts and parsers of SPEC-0001 A4 not yet written
(`PostgresqlStatus`, PostgreSQL interval strings, the Prometheus text
subset), the pure live model, the poller, the replication topology
component, the tiles (sessions, databases, WAL and archiving, replication
slots, base backups, instance manager), in-memory sparklines, the doors
from the Cluster drawer, the Clusters list and the Overview.

Excluded: per-query detail from `pg_stat_activity` (needs `exec`, spike S2,
not in 0.1), any persisted history or long-range chart (M7, "Metrics
charts"), pooler metrics (M3), any action endpoint of the instance manager
(out of reach by design and out of scope for good), user-defined metrics
queries.

## Design

### Standard or ad hoc view, and why

Ad hoc, a page of its own. The subject is not a Kubernetes object: it is
data that exists only inside the instances, it changes every few seconds,
and its core is a relationship (primary to standbys) that a table flattens.
A drawer is too narrow for a topology plus six tiles at desktop density, so
the view is a `clusterPages` entry inside the host's `TabLayout`; the
drawer and the lists lead to it (DESIGN.md section 12, "live data that
lives in no CRD").

### Placement and addressing

Leaf "Live View" in the sidebar group "Clusters", after "PostgreSQL
Clusters". Page id `cnpg-live`, menu id `cnpg-clusters-live`. The selected
cluster is part of the URL (`?cluster=<namespace>/<name>`), so every door
lands on the right cluster and the host's back button works. Without the
parameter the page shows the picker and, below it, one line per cluster
(condition badge, name, namespace) as doors: never an empty page. The
picker is the host `Select`, options grouped by namespace, honoring the
host namespace filter.

Doors to the page: a "Live view" link at the top of the Health section of
the Cluster drawer; a "Live view" entry in the row menu of the PostgreSQL
Clusters list (navigation only, no write); a "live" door on every Overview
tile. All built as host links to the page URL (the M1 lesson: navigation
from extension pages goes through links, not through `navigate`).

### Data access (`src/renderer/api/instance/pod-proxy.ts`)

- One module owns the path
  `/api/v1/namespaces/<ns>/pods/<scheme>:<pod>:<port>/proxy<path>` behind
  the host's cluster proxy prefix, as proven by S1. JSON for `/pg/status`
  (port 8000), text for `/metrics` (port 9187). Only `GET`, only these two
  paths: the module exposes no generic request function.
- Scheme per pod as in A3: `https` for the status port when the `postgres`
  container command carries `--status-port-tls`; the metrics port follows
  `spec.monitoring.tls.enabled`. On a scheme failure the client retries
  once with the other scheme and remembers the answer for the pod.
- Every request has a 5 second timeout (`AbortController`) and ends in a
  typed result, never in a throw that reaches a component:

  | Failure | Detected by | What the card says |
  | --- | --- | --- |
  | `forbidden` | 403 | "Reading live data needs `get` on `pods/proxy` in `<namespace>`" |
  | `unreachable` | 502, 503, 504 | "The instance manager of `<pod>` does not answer (pod not ready, fenced or restarting)" |
  | `scheme` | both schemes failed | "Neither `http` nor `https` worked on port `<port>` of `<pod>`" |
  | `timeout` | abort | "No answer from `<pod>` within 5 s" |
  | `parse` | contract guard | "Unexpected answer from `<pod>`: the instance manager `<version>` may be newer than this extension knows" |

### Contracts and parsers (pure, unit-tested)

- `src/renderer/api/instance/postgresql-status.ts`: the `PostgresqlStatus`
  interface written from R5 and a guard that accepts unknown fields and
  rejects an answer without `pod` and `isPrimary`.
- `src/renderer/components/pg-interval.ts`: PostgreSQL interval strings
  (`00:00:00.012345`, `1 day 02:03:04`, negative values, empty) to
  milliseconds; unparseable gives undefined, never zero.
- `src/renderer/api/instance/prometheus-text.ts`: the text format subset the view
  reads (comments skipped, labels with escaped quotes and backslashes,
  `NaN`, `+Inf`, scientific notation, optional timestamps ignored);
  `select(samples, name, labels?)` to read series.
- `src/renderer/components/live/live-model.ts`: from the per-instance results to the
  view model:
  - **topology**: the primary (the instance that says `isPrimary`, checked
    against `status.currentPrimary`; a disagreement is shown, not hidden),
    one edge per `replicationInfo` entry matched to an instance by
    `applicationName`, with state, sync state and priority, write, flush and
    replay lag as times, and the replay distance in bytes
    (`lsnDistance(primary.currentLsn, standby replayLsn)`); standbys that
    the primary does not list are drawn detached with "not streaming";
  - **sessions**: totals by state from `cnpg_backends_total` summed over
    every instance, split primary versus standbys, top ten by database and
    by user, `cnpg_backends_waiting_total`, the longest transaction from
    `cnpg_backends_max_tx_duration_seconds`;
  - **databases**: `cnpg_pg_database_size_bytes` and
    `cnpg_pg_database_xid_age` from the primary only (every
    instance holds its own copy of the same databases; summing them would
    triple the sizes);
  - **WAL and archiving**: from the primary's status (`currentWAL`,
    `lastArchivedWAL` and time, `lastFailedWAL` and time, `readyWalFiles`,
    `isArchivingWAL`), the archiver counters and
    `cnpg_collector_pg_wal{value}` for the WAL volume; the archiving state
    refines H2: `Failing` when the last failure is newer than the last
    success, whatever the condition still says;
  - **slots**: `replicationSlotsInfo` with the retained WAL from
    `cnpg_pg_replication_slots_pg_wal_lsn_diff`;
  - **flags** per instance: `pendingRestart`, `replayPaused`,
    `isPgRewindRunning`, `mightBeUnavailable`, `isWalReceiverActive`,
    `isInstanceManagerUpgrading`, fenced (annotation), timeline.
- `src/renderer/components/live/series.ts`: a fixed-size ring buffer of samples for
  the sparklines (in memory, per opened page, dropped on unmount).

### Poller (`src/renderer/components/live/live-poller.ts`)

MobX state fed by two loops: `/pg/status` of every instance every 5
seconds, `/metrics` every 30 seconds (or `spec.monitoring.metricsQueriesTTL`
when set: the exporter caches its queries, so asking more often returns the
same numbers). No overlapping requests per pod; after three consecutive
failures of a pod the loop backs off to 30 seconds for that pod; both loops
stop when the page unmounts or the window is hidden and resume on return.
The header shows the two intervals, the time of the last successful read,
a pause toggle and a manual refresh, all reachable from the keyboard
(DESIGN.md section 7).

### The page grid (`src/renderer/pages/live-page.tsx`)

1. **Header**: picker, condition badge of the cluster (same classifier as
   the list), PostgreSQL version, polling facts and controls.
2. **Replication topology** (full width,
   `src/renderer/components/live/topology.tsx`): the primary on the left,
   the standbys on the right, one edge each. A node shows the pod name
   (door to the pod's drawer), role, Kubernetes node, timeline, current or
   replay LSN, and its flags as small badges. An edge shows the sync state
   (`async`, `sync`, `quorum`, `potential`) as its label and the replay lag
   as time with the byte distance beside it; the edge takes
   `--colorOk` while streaming, `--colorWarning` above the lag threshold
   (10 seconds or 64 MiB, constants of the model), `--colorError` when not
   streaming. When the synchronous replicas observed are below the
   configured minimum the row carries the same warning sentence as the
   drawer. DOM and SVG with theme tokens, layout by a pure function
   (`layoutTopology`) so it is testable without a browser. An instance that
   failed to answer is drawn with its failure sentence in place of the
   figures.
3. **Tiles**, a grid that goes from three columns to one as the window
   narrows, each with its own loading skeleton and failure state:
   - **Sessions**: total, a stacked bar by state (active, idle, idle in
     transaction, other) with exact counts in the tooltips, waiting
     sessions, the longest transaction (warning above 5 minutes), a
     sparkline of the total since the page opened, the top ten by database
     and by user as a nested table.
   - **Replication lag**: one line per standby with replay lag now and a
     sparkline since the page opened; the worst one first.
   - **Databases**: nested table sorted by size with a proportional bar,
     humanized size with exact bytes in the tooltip, transaction ID age
     with a warning above 1,000,000,000 and an error above 1,500,000,000
     (the wraparound limit is about 2,100,000,000).
   - **WAL and archiving**: state badge (positive phrasing, "Archiving"),
     current WAL, last archived WAL and when, last failed WAL and when,
     WAL files waiting to be archived (warning above 10), archived and
     failed counters, WAL volume usage when the cluster has one.
   - **Replication slots**: nested table (name, type, active as
     `BadgeBoolean`, restart LSN, retained WAL, WAL status); an inactive
     slot that retains WAL is a warning, since it is how a disk fills.
   - **Base backups in progress**: only while `pgStatBasebackupsInfo` is
     not empty.
   - **Instance manager**: version and architecture per instance, the
     upgrading flag; a version skew between instances is a warning.

Every figure that is rounded has the exact value in a tooltip; every pod,
node and database name that has a Freelens page is a door to it.

### Non-happy states

- No cluster selected: the picker and the doors (above).
- Hibernated cluster: "Hibernated: there are no instances to read", with
  the hibernation facts from the drawer; no polling.
- No instance answers: the topology draws every instance with its failure
  and the tiles say which endpoint they wait for; the header keeps
  polling.
- `forbidden`: one page-level panel (not one per tile) naming the
  permission, since every tile would fail the same way.
- Metrics unreachable but status reachable (or the opposite): the tiles fed
  by the working endpoint stay live, the others say what failed.
- Cluster deleted while open: "This cluster no longer exists" with the door
  to the list.
- CRD absent: the `createAvailableVersionPage` panel, as for every page.

### Themes

Both themes; zero authored colors; sparklines and bars take the semantic
tokens of DESIGN.md section 2.

### Safety

`GET` on `/pg/status` and `/metrics` through `pods/proxy`, nothing else.
No database connection, no credential, no secret read, no SQL, no `exec`.
The action endpoints of the instance manager are never addressed (they
would refuse without the operator's client certificate, and the client
module cannot even express them). Polling stops when nobody is looking.

## Tests (non-regression list)

- Unit: `pg-interval.test.ts`, `prometheus-text.test.ts` (including a
  recorded answer of the fixture cluster, trimmed), `postgresql-status.test.ts`
  (guard, unknown fields tolerated), `live-model.test.ts` (topology with
  sync and async standbys, a detached standby, a primary disagreement,
  sessions summed and split, databases from the primary only, archiving
  refinement, inactive slot warning, thresholds at their edges),
  `pod-proxy.test.ts` (path building, the failure table above, scheme
  retry and memory, timeout), `live-poller.test.ts` with fake timers (no
  overlap, backoff, stop on hidden and on unmount), `series.test.ts`,
  `layoutTopology` cases.
- Integration: the scaffold's activation case, unchanged.
- E2E (appended to `cnpg-e2e.tests.ts`):
  - `e2e-main`: one primary and two standbys streaming, a lag figure on
    both edges, `isPrimary` and `currentLsn` consistent with
    `kubectl cnpg status` (the S1 comparison, now through the page),
    sessions total at least 1, the `app` and `postgres` databases with a
    size, a last archived WAL, the slots of the two standbys active;
  - `e2e-single` (metrics over TLS): tiles filled, archiving `Failing` with
    a last failed WAL;
  - `e2e-hibernated`: the hibernated state, no request issued (asserted on
    the network log);
  - `e2e-fenced`: the instance drawn with its failure sentence, the page
    alive;
  - the doors: drawer link, row menu entry and Overview tile land on the
    page with the right cluster selected.
- Manual verification: (1) a kubeconfig whose user lacks `pods/proxy`
  shows the permission panel (steps in the pre-review pass, SPEC-0008);
  (2) the lived experience against a busy database (pgbench on the demo
  cluster of SPEC-0008): the figures move, nothing flickers, the page stays
  responsive for ten minutes; (3) both themes. Results recorded here.

## Notes and deviations

- Approved on 2026-09-19 by the lead maintainer, with the four points the
  draft left open closed as proposed: a page of its own with the cluster in
  the URL (not a drawer section); in-memory sparklines in 0.1, persisted or
  long-range charts in M7; polling every 5 s for the status and every 30 s
  for the metrics, lag warning at 10 s or 64 MiB, longest transaction
  warning at 5 minutes, waiting WAL files warning above 10, transaction ID
  age warning at 1.0 and error at 1.5 billion, all named constants of the
  model; a "Live view" navigation entry in the row menu of the PostgreSQL
  Clusters list.
- Implementation notes, from what the E2E cluster answered (operator 1.30.0):
  - In the status answer `pod` is a trimmed Pod object (`pod.metadata.name`),
    not a string, `syncPriority` is a number in a string, and an instance
    that never archived reports its archiver times as `-infinity`: the guard
    and `parseStatusTime` follow the answers, not the draft.
  - **A fenced instance answers.** The instance manager replies 200 with
    `mightBeUnavailable: true`, the reason in `mightBeUnavailableMaskedError`,
    and `isPrimary: true` with an empty system ID, because it cannot ask
    PostgreSQL for the role. The draft expected an unreachable instance; the
    model instead reports "PostgreSQL does not answer on this instance", never
    takes such an instance for the primary, and the E2E case asserts that.
  - A plain request against the TLS status port comes back from the API
    server as a bare 400, a TLS request against a plain port as a 503 that
    quotes the TLS handshake error: both are classified `scheme`, and the
    client then tries the other scheme once and remembers what worked.
  - The sessions count the platform's own (`streaming_replica`,
    `cnpg_metrics_exporter`) apart from the users': on an idle cluster every
    session is the platform's, and the longest transaction ignores them
    (replication sessions are long lived by design).
    `cnpg_pg_settings_setting{name="max_connections"}` is in the default
    queries and gives the limit per instance.
- Deviations from the draft: the page id and the menu id are the same
  (`cnpg-clusters-live`), as for every other leaf; the contracts live in
  `src/renderer/api/instance/` and the parsers, the model, the poller and the
  components in `src/renderer/components/live/` (ARCHITECTURE.md); the labels
  of the edges sit on their lines, positioned by the pure layout
  (`labelY`), and the SVG of the lines is stretched over its cell and kept out
  of the flow, since an SVG with a viewBox would otherwise size the grid; the
  replication slots table shows the type in the tooltip, not in a column.
- The cluster travels in the URL through the host's `createPageParam`, and the
  row menu entry navigates with the host's `navigate`: both work from an
  extension page (verified by the E2E case of the three doors).
- Manual verification still open for the M2 milestone review: a kubeconfig
  without `pods/proxy` (the permission panel is covered by unit tests of the
  model and of the client only) and the lived experience against a busy
  database, which needs the demo cluster of SPEC-0008.
- Merged with #20 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `9a3e8b5`. The manual verification above is part of the M2
  milestone review: the status moves to Verified when its result is recorded
  here.
- M2 milestone review: 2026-09-19, lead maintainer, on the screenshots of the
  pre-review pass and of the E2E suite on both themes (gallery on an ephemeral
  branch, deleted after the review). Verdict: approved, no blocking finding.
  Status moved to Verified. Still open for a later look, as the pre-review
  report lists: the psql terminal on Windows and Linux desktops, the live view
  with a kubeconfig without `pods/proxy`, the live view against a busy
  database for ten minutes.
