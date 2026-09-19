# SPEC-0017: Cluster timeline (ad hoc, read-only)

- **Status:** Implemented
- **Milestone:** `M5` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

"What happened to this cluster, and in which order?" answered on one
screen: the Kubernetes events of the cluster and of everything it owns,
next to the facts that outlive the events (backups, the change of primary,
the conditions), and what is scheduled to come.

## Upstream reference

- Kubernetes `Event` objects (core `v1`) of the namespace, whose
  `involvedObject` is the `Cluster`, one of its pods, PVCs or jobs (label
  `cnpg.io/cluster`), one of its `Backup`, `ScheduledBackup` or `Pooler`
  objects. Events are kept by the API server for a limited time (one hour
  by default): the page says so.
- Durable facts with a timestamp: `Backup.status.startedAt`/`stoppedAt`
  and phase; `Cluster.status.currentPrimaryTimestamp` and
  `currentPrimaryFailingSinceTimestamp`; the `lastTransitionTime` of the
  cluster conditions; the primary lease `acquireTime` (SPEC-0019).
- What is to come: `ScheduledBackup.status.nextScheduleTime`, the
  certificate expirations of `Cluster.status.certificates`.

## Scope

Included: a "Timeline" page in the Clusters group, addressed by cluster like
the Live View; a door from the Cluster drawer and from the cluster menu;
the pure model. Excluded: storing events beyond what the API server keeps,
the logs (SPEC-0018), any action.

## Design

### Standard or ad hoc view, and why

Ad hoc: a list sorted by one column cannot put events, backups and status
facts of different kinds on one time axis.

### Pure module (`src/renderer/components/timeline.ts`)

`buildTimeline({ cluster, events, backups, schedules, poolers, pods, lease,
now })` returns entries `{ time, category, level, title, detail, object }`
sorted newest first, with:

- categories `Event`, `Backup`, `Primary`, `Condition`, `Scheduled`;
- levels from the host classes: a `Warning` event and a failed backup are
  `warning`/`error`, the rest `info`/`success`;
- repeated events collapsed by the API server keep their count ("x12") and
  use the last timestamp;
- the entries to come (`Scheduled`) sit above a "now" marker, nearest
  first;
- day groups with the entries of each day.

`timelineFilters`: by category and "only what needs attention".

### Page

Header: the cluster picker (URL parameter, as the Live View), the filter
chips, and the sentence about how long events are kept. Body: the day
groups, each entry a row with time, a category badge, the title, the detail
on a second line, and a link to the object when it is still there. Events
are watched, not polled: the host store of events keeps the page current.

### Non-happy states

No cluster selected: the picker and a hint. No entry: what the page would
show and why it may be empty (events expired, no backup yet). Forbidden on
events: the durable facts stay and the page says events could not be read.

### Safety

Reads only.

## Tests (non-regression list)

- Unit: `timeline.test.ts` (selection of the events of a cluster, levels,
  collapsing, ordering across categories, the now marker, day groups,
  filters, empty inputs).
- E2E: the timeline of `e2e-main` shows its completed backup, its failed
  backup as an error, the next scheduled backup above the now marker and
  the primary entry; the filter on Backup hides the rest; the door of the
  Cluster drawer lands on the same cluster.
- Manual verification: the M5 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M5 at the
  milestone review.
- Implementation notes: an event belongs to the cluster when it is about the
  cluster, one of its backups, schedules or poolers, an object that carries
  the `cnpg.io/cluster` label, or one of the instance names of the status;
  for an object that is already gone the name decides, unless another cluster
  of the namespace has a longer matching name (`pg` against `pg-2`). The
  creation of the cluster and the acquisition of the primary lease are entries
  too. The certificates make one entry, the first to expire, not one each:
  four entries three months away pushed what happened off the first screen.
  The now marker sits above the day of the newest past entry. Nothing is
  polled: every source is a store the host watches.
- The E2E cluster gets one warning event about `e2e-main` at every bring-up
  (`cluster-up.sh`), because the API server forgets events after an hour; the
  case asserts it only when it is still there.
- Seen live on the E2E cluster: events of pods and jobs, the completed backup,
  the primary and its lease, the conditions, the next backups above the now
  marker; on `e2e-single` the failed backup and the failing archiving
  condition as errors. Covered by unit tests only: the name rule for objects
  that are gone, a primary that is failing, certificates close to expiry.
- Merged with #45 on 2026-09-19; the unit, integration and E2E workflows ran
  green on the pull request, after one correction of the E2E case: on a
  cluster that was just created a schedule that never ran has no next time in
  its status yet, so the case asserts the schedule that runs at once. The
  manual verification above is part of the M5 milestone review: the status
  moves to Verified when its result is recorded here.
