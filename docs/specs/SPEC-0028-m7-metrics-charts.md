# SPEC-0028: Metrics charts on the Live View (ad hoc, read-only)

- **Status:** Verified
- **Milestone:** `M7` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-22

## Goal

The Live View shows the numbers of a cluster right now (SPEC-0006). This
spec adds their trends: the same figures drawn as time series since the page
opened, so that an operator watching a cluster sees a change happening (a
lag that grows, a cache hit ratio that drops, archiving that stops, a
database that swells) instead of catching one number at a time. No new data
path: the reads of SPEC-0006 feed the charts.

## Upstream reference

- The metrics of the default monitoring queries of the operator
  (`cnpg-default-monitoring`, cached by the exporter for
  `.spec.monitoring.metricsQueriesTTL`, 30 seconds by default), recorded in
  SPEC-0001 (Q2). The charts read: `cnpg_backends_total{state}`,
  `cnpg_pg_stat_database_xact_commit`, `_xact_rollback`, `_blks_hit`,
  `_blks_read`, `_deadlocks`, `_temp_bytes` (labelled `datname`),
  `cnpg_pg_database_size_bytes{datname}`,
  `cnpg_pg_stat_archiver_archived_count` and `_failed_count`,
  `cnpg_collector_pg_wal{value=size|count}`,
  `cnpg_pg_stat_bgwriter_checkpoints_timed` and `_checkpoints_req` on
  PostgreSQL 16 and older, `cnpg_pg_stat_checkpointer_checkpoints_timed` and
  `_checkpoints_req` on 17 and newer (the query is versioned upstream, the
  metric names differ by their prefix only).
- The replay lag of every standby as the primary reports it
  (`pg_stat_replication` through the instance manager status endpoint,
  SPEC-0006), read every five seconds.
- The Grafana dashboard the CloudNativePG project publishes is the
  functional reference of which trends operators look at first:
  transactions, cache hit, sessions, replication lag, WAL, database size,
  checkpoints and contention. Reference of scope only; nothing is copied.

## Scope

Included: a "Trends" section of the Live View with nine charts over the
figures the page already polls; a memory of samples long enough for an hour
of watching; rates computed from the counters of PostgreSQL, with counter
resets handled; a range control; exact values in tooltips; the pure module
that turns readings into datasets; unit, E2E and pre-review coverage.

Excluded, and where it goes: history from before the page opened (the
extension has no time series database; a Prometheus data source is a spec of
its own after v1, and the section says so where the range control ends);
charts in the Cluster drawer (too narrow; the drawer keeps its "Right now"
figures) and on the Overview; PgBouncer trends of a Pooler (SPEC-0012 keeps
its live figures); custom metrics of the user's own queries; thresholds and
alerts (the tiles carry the warning levels of SPEC-0006, the charts do not
repeat them).

## Design

### Standard or ad hoc view, and why

Ad hoc: a trend is the one thing a number cannot carry. The tiles of
SPEC-0006 answer "what is it now"; the charts answer "which way is it going
while I watch", the question an operator asks during a migration, a batch
run, a switchover or an incident. A list has no way to say it.

### Placement

A section titled "Trends" on the Live View page (`live-page.tsx`), full
width, under the tiles and above nothing: the page ends with it. It renders
only while the picked cluster has a primary that answers; on a hibernated
cluster and while the pod proxy is refused the section is absent and the
panel of SPEC-0006 that explains why stands alone.

The section header carries the range control and a sentence with the time
the page started sampling ("since 10:42, sampled every 5 s and every 30 s")
and, when the range asked for is longer than what was sampled, the words
"showing what was sampled so far".

### The cards, their source and their unit

A grid of cards, three columns, then two, then one as the window narrows.
Every card has a title, the last value in the host's figure style, the chart
and its legend. The data source of every card is the primary of the cluster,
unless said otherwise. "Per interval" means the difference between two
consecutive metric samples of the exporter, 30 seconds apart by default;
"per second" is that difference divided by the seconds between the samples.

| Card | What is drawn | Source | Kind |
| --- | --- | --- | --- |
| Sessions | backends by state, stacked: active, idle, idle in transaction, other; the cluster total is the sum over the instances that answer | `cnpg_backends_total` of every instance | stacked bars |
| Replay lag | one line per standby, seconds, as the primary reports it | status endpoint of the primary (every 5 s) | lines |
| Transactions | commits and rollbacks per second, summed over the databases of the primary | `cnpg_pg_stat_database_xact_commit`, `_xact_rollback` | bars |
| Cache hit ratio | `blks_hit / (blks_hit + blks_read)` of the interval, in percent, over all databases; no point when the interval read no block | `cnpg_pg_stat_database_blks_hit`, `_blks_read` | line |
| WAL archiving | WAL files archived and failed per interval | `cnpg_pg_stat_archiver_archived_count`, `_failed_count` | bars |
| WAL on disk | size of `pg_wal` in bytes, with the file count in the tooltip | `cnpg_collector_pg_wal{value=size}`, `{value=count}` | line |
| Database sizes | one line per database, bytes; templates excluded | `cnpg_pg_database_size_bytes{datname}` | lines |
| Checkpoints | timed and requested per interval | `cnpg_pg_stat_bgwriter_*` or `cnpg_pg_stat_checkpointer_*` by what the instance exports | bars |
| Contention | deadlocks per interval and temporary file bytes per interval, over all databases | `cnpg_pg_stat_database_deadlocks`, `_temp_bytes` | bars, two axes |

Rules of the figures:

- A counter that went down between two samples (statistics reset, restart,
  a switchover that changed the primary) produces no point for that
  interval; the chart shows a gap, never a negative or a spike.
- Sums over databases are taken over the samples of the same instance and
  the same round; `template0` and `template1` are excluded everywhere, as
  the tiles do.
- The replay lag series follows a switchover: the primary the status is
  read from changes, the standby names change, a line ends and a new one
  starts, nothing is stitched.
- Every rounded figure has its exact value in the tooltip (bytes, exact
  count, seconds with three decimals); every axis has its unit.

### The memory of samples

The poller of SPEC-0006 keeps a bounded series per figure (`series.ts`,
120 points). This spec raises the memory to an hour of watching: 720 points
for the figures sampled every 5 seconds, 120 for the ones sampled every 30
seconds, and stores the raw counters, not the rates, so a rate is computed
from the two samples it needs at render time and a change of interval never
skews it. The memory dies with the page, as before.

### Range control

The host's `RadioGroup` as buttons: "5 min", "15 min", "1 h" and "since
opened", default "15 min". The charts show the points inside the range and
the x axis spans the range, so a page just opened shows the last minute of
points at the right edge and empty space before them. The control is
keyboard reachable.

### Host components and theming

- Bars and stacked bars use the host's `BarChart` (its time axis, its
  tooltips, its zebra stripes, its colors for text and grid); lines use the
  host's `Chart` with `ChartKind.LINE` and the same axis options, since the
  host has no line chart component of its own.
- Series colors come from the theme tokens read at render (`themeColor`,
  SPEC-0004): commits, archived and timed on `--colorOk`; rollbacks, failed
  and deadlocks on `--colorError`; requested checkpoints and temporary
  bytes on `--colorWarning`; active sessions on `--colorInfo`, idle on
  `--colorVague`, idle in transaction on `--colorWarning`, other on
  `--colorTerminated`. Series that are one per object (standbys, databases)
  take the tokens in a fixed order (`--colorInfo`, `--colorOk`,
  `--colorWarning`, `--colorSuccess`, `--colorTerminated`, `--colorVague`),
  and the legend names each. No color is authored.
- A theme change while the page is open redraws with the new tokens.

### Non-happy states

- Fewer than two samples: the card shows the last value when there is one
  and "waiting for the next sample" under it; nothing is drawn.
- The primary does not answer: the card carries the failure sentence of the
  tile it details (SPEC-0006 non-happy states), the other cards stay.
- An instance without the default queries (`disableDefaultQueries`): the
  cards whose metrics are absent say which metric they need.
- A standby that stopped answering: its line ends; the legend keeps its
  name with "(no data since HH:MM)".
- Hidden window: sampling pauses as in SPEC-0006 and the gap is visible.

### Doors

The cards detail the tiles above them, which carry the doors of SPEC-0006.
Two cards add one: the title of "WAL archiving" leads to the Backups page
filtered on the cluster, the title of "Database sizes" to the Databases page
of the cluster.

### Safety

Reads only, through the pod proxy client of SPEC-0006 with its own limits;
no new request, no new endpoint, no new permission.

### DESIGN.md conformance

Section 12 (ad hoc views): the grid and the source of every card are above;
every mark has its exact value; series colors from the tokens; logic in a
pure module; both themes. Deviation, declared: the cards are not all doors,
because the tiles they detail already are, and a chart that navigates on a
click loses its tooltip.

### Where the code lives

- `src/renderer/components/live/trends.ts` (pure): the sample memory
  (`ingest(readings, time)`), the rate and ratio helpers with reset
  handling, the window cut, the datasets of every card with their tokens,
  the checkpoint metric selection by version.
- `src/renderer/components/live/trend-chart.tsx`: the thin wrapper around
  the host charts, with the axis options and the tooltip formatters.
- `src/renderer/components/live/trends.tsx`: the section, the range control
  and the cards, each a `data-testid="cnpg-trend-<key>"` element carrying
  `data-points` and `data-last` for the suite.
- `live-poller.ts`: the series memory grows as above; the readings of every
  round are handed to the trend memory.

## Tests (non-regression list)

- Unit: `trends.test.ts`: rate over two samples; counter reset gives no
  point; hit ratio with no block read gives no point; sums exclude the
  templates; the cluster total of sessions sums the instances that answered
  and ignores the ones that failed; checkpoint metrics picked from
  `bgwriter` on one instance and `checkpointer` on another; the window cut
  for every range; the datasets carry the expected tokens and labels; a
  standby line ends when it stops answering; the memory is bounded at 720
  and 120 points. `series.test.ts`: the new capacity.
- Integration: unchanged (the extension activates without errors).
- E2E: on the Live View of `e2e-main` the Trends section shows the nine
  cards; every card starts in "waiting for the next sample"; within 90
  seconds the Transactions card has at least two points (the exporter's own
  queries commit transactions every 30 seconds) and its last value is a
  number; after a few inserts through `psql` on the primary the Database
  sizes card names the `app` database; the range control switches to "1 h"
  from the keyboard and the cards keep their points.
- Pre-review: the Trends section on both themes after a minute on the demo
  cluster, and the assertion that no authored color reached an inline style.
- Manual verification: none beyond the M7 milestone review.

## Notes and deviations

- The exporter says when its cache was last refreshed
  (`cnpg_last_update_timestamp`, epoch seconds): the memory keeps one
  snapshot per cache generation and stamps it with that time, so a cached
  reading read twice makes one point and the rates are taken over the real
  interval between two refreshes, never over a poll that returned the same
  numbers. Without the marker (an exporter that does not export it) the
  time of the read is used and a snapshot equal in time is dropped.
- The metrics snapshots are taken after every round of the poller, status
  rounds included: the marker makes the extra rounds free.
- The lines are drawn with the host's `Chart` in its line kind, since the
  host's `BarChart` decides bars or stepped lines by the width of the
  range on its own; the bars use `BarChart` as planned, with its zebra
  stripes and its time axis. The second axis of the contention card is
  appended to the host's axes through its `options` merge.
- The cards say "Waiting for the next sample" below two points, and "Needs
  `<metric>`" when the primary exports none of the series of the card.
- The range control is the host's `RadioGroup` as buttons, reachable and
  operable from the keyboard as DESIGN.md section 12 asks.
- The poller's own memory of the sparklines grew from 120 to 720 points as
  the spec asked (an hour at five seconds).
- M7 milestone review: 2026-09-24, lead maintainer, on the screenshots of the
  pre-review pass on both themes (gallery on an ephemeral branch, deleted
  after the review). Verdict: approved, no blocking finding. Status moved to
  Verified.
