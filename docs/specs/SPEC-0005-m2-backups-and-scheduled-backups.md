# SPEC-0005: Backups and Scheduled Backups, lists and details (read-only)

- **Status:** Approved
- **Milestone:** `M2` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0` (drift watch of 2026-09-19:
  still the latest operator release; Barman Cloud plugin `v0.15.0` still the
  latest)
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator answers three questions without leaving Freelens: "is every
PostgreSQL cluster protected, and since when", "what happened to this
backup, and what do I need to restore from it", and "what runs next, and is
any schedule silently stopped". Backups and schedules get their own lists
and drawers, and the history of a cluster's backups becomes visible as a
strip in the drawers that own it.

## Upstream reference

- `kubectl get backups` and `kubectl get scheduledbackups` (printer columns:
  Age, Cluster, Method, Phase, Error; Age, Cluster, Last Backup), and the
  backup section of `kubectl cnpg status`.
- `Backup` and `ScheduledBackup` as recorded in SPEC-0001 R3, the Barman
  Cloud plugin contract in R8, the backup facts of the health model in H3.
- Facts checked against the operator sources at `v1.30.0` for this spec
  (semantics only, nothing copied):
  - a `Backup` created by a `ScheduledBackup` carries the label
    `cnpg.io/scheduled-backup: <name>`; ownership depends on
    `spec.backupOwnerReference` (`none`, `self`, `cluster`), so the label is
    the only reliable parent pointer;
  - the phase `walArchivingFailing` means the backup did not start because
    WAL archiving is not working on the instance: it is a failure to act on,
    not a progress state;
  - `finalizing` belongs to volume snapshot backups waiting for
    `readyToUse`;
  - `spec.schedule` is parsed by a six-field cron parser (seconds first)
    that also accepts the descriptors `@yearly`, `@monthly`, `@weekly`,
    `@daily`, `@hourly` and `@every <duration>`.
- Other CloudNativePG user interfaces list backups as plain rows. This spec
  matches that and adds what they lack: the outcome classified with its
  reason, the restore coordinates in one place, the parent schedule and the
  generated backups linked both ways, the schedule in words, and the backup
  history strip. Functional reference only.

## Scope

Included: the `Backups` and `Scheduled Backups` list pages, their detail
drawers, the pure classifiers and the schedule describer with their unit
tests, the backup history strip (pure bucketing module plus a thin
component) mounted in the `Cluster` drawer and in the `ScheduledBackup`
drawer, the sidebar group "Backups", the doors from the M1 views (Cluster
drawer, Overview) to the new pages, two extra E2E fixtures.

Excluded: any write (on-demand backup, suspend, trigger now: M6), the
`ObjectStore` page and drawer (M3: until then the object store is a name
with a tooltip), the creation forms (M7), the WAL archive refinement from
`/pg/status` (SPEC-0006), restore workflows.

## Design

### Standard or ad hoc view, and why

Standard for the two lists and the two drawers: backups and schedules are
Kubernetes objects and "which ones exist, how did each one go" is exactly
what a list with a drawer carries. Ad hoc for one element, the **backup
history strip**: "is this cluster protected over time" is a sequence in
time, and a list sorted by age cannot show a gap, a streak of failures or
the distance to the next run at a glance (DESIGN.md section 12, "sequences
in time"). The strip lives inside drawers, not on a page of its own, so it
costs the user no navigation.

### Sidebar

Group "Backups" under the root, after "Clusters", with the leaves "Backups"
and "Scheduled Backups" (titles from `crd.title`). Menu ids `cnpg-backups`,
`cnpg-backups-backups`, `cnpg-backups-scheduledbackups`; table ids
`cnpgBackupsTable` and `cnpgScheduledBackupsTable` (collision rule of
DESIGN.md section 1). Both pages go through `createAvailableVersionPage`
with their own kind, so the CRD-absent panel names the missing CRD.

### CRD models

Already on main since SPEC-0003 (`backup-v1.ts`, `scheduled-backup-v1.ts`).
This spec adds static helpers only (no instance methods):
`Backup.getParentSchedule(object)` (the `cnpg.io/scheduled-backup` label),
`Backup.getInstancePod(object)` (`status.instanceID.podName`),
`ScheduledBackup.getMethod(object)` (same default rule as `Backup`).

### Classifiers (`src/renderer/components/backup-health.ts`, pure)

- `classifyBackup(backup)`: `{ state, label, className, reason }`.

  | Phase | State | Host class | Reason shown |
  | --- | --- | --- | --- |
  | `completed` | Completed | `success` | "Completed in `<duration>`" |
  | `pending` | Pending | `info` | "Waiting to start" |
  | `started`, `running` | Running | `info` | "Running for `<duration>`" |
  | `finalizing` | Running | `info` | "Finalizing the volume snapshots" |
  | `failed` | Failed | `error` | `status.error`, else `status.commandError` first line, else "Failed" |
  | `walArchivingFailing` | Failed | `error` | "Not started: WAL archiving is not working on the instance" |
  | `invalid backup definition` | Failed | `error` | `status.error`, else "Invalid backup definition" |
  | absent | Pending | `info` | "No status reported yet" |
  | anything else | Unknown | `info` | the raw phase |

  In-progress states use `info`, consistent with `Progressing` in the
  cluster classifier of SPEC-0003.
- `backupDuration(backup)`: `stoppedAt - startedAt` when both parse, else
  the reconciliation pair, else undefined. All timestamps go through
  `parseGoTime` (RFC 3339 here, but one parser for every upstream time).
- `backupTimeline(backup)`: the timeline from `pluginMetadata.timeline`,
  else from the first eight hex digits of `beginWal`.
- `walDuringBackup(backup)`: `lsnDistance(beginLSN, endLSN)` in bytes.
- `classifySchedule(schedule, now)`:

  | Condition | State | Host class | Reason shown |
  | --- | --- | --- | --- |
  | `status.error` set | Failed | `error` | the error |
  | `spec.suspend` true | Suspended | `warning` | "Suspended: no backup will be taken" |
  | `nextScheduleTime` in the past by more than the check tolerance (5 minutes) | Overdue | `warning` | "The next run was due `<duration>` ago" |
  | `lastCheckTime` absent | Pending | `info` | "Not checked by the operator yet" |
  | otherwise | Active | `success` | "Next run `<relative time>`", or "Waiting for the first run" |

  Suspended is `warning`, not neutral, on purpose: a suspended schedule is
  the most common way a cluster silently stops being protected.
- `describeSchedule(expression)` (`src/renderer/components/cron-text.ts`):
  the six-field expression in words ("Every day at 03:00:00"), descriptors
  included (`@every 6h` reads "Every 6 hours"); returns undefined for
  anything it cannot describe, and the views then show the raw expression
  alone. The raw expression is always visible: the words are an aid, never
  a replacement. Implementation: the `cronstrue` package (MIT, no
  dependencies, six-field aware) behind this function, plus the descriptor
  handling it lacks; the wrapper keeps the package replaceable without
  touching the views.

### Backups list (`src/renderer/pages/backups-page-v1.tsx`)

| Column | Content | Sort |
| --- | --- | --- |
| Name | name | name |
| Namespace | `NamespaceSelectBadge` | namespace |
| Cluster | `spec.cluster.name`, `MaybeLink` to the Cluster drawer when the cluster exists | cluster |
| Method | `plugin`, `volumeSnapshot` or `barmanObjectStore`; the last with the "deprecated" badge and a tooltip naming the plugin as the replacement (also when the method is only the CRD default) | method |
| Schedule | parent `ScheduledBackup` from the label, `MaybeLink` to its drawer; "N/A" for an on-demand backup | schedule |
| Instance | pod that took the backup (`LinkToPod` idiom when the pod exists), role not shown (it may have changed since) | pod |
| Started | `ReactiveDuration` since `startedAt`, tooltip with the exact time | time |
| Duration | `backupDuration` humanized, exact seconds in the tooltip | duration |
| Condition | `Badge` with `classifyBackup(...).label` | state |
| Status | `classifyBackup(...).reason` truncated with tooltip | reason |
| Age | `KubeObjectAge` | creation |

Default sort: Age, newest first. `searchFilters` extended with the cluster
name, the parent schedule and the method, so the doors from the other views
(`?search=<cluster>`) land on the right rows.

### Scheduled Backups list (`src/renderer/pages/scheduled-backups-page-v1.tsx`)

| Column | Content | Sort |
| --- | --- | --- |
| Name | name | name |
| Namespace | `NamespaceSelectBadge` | namespace |
| Cluster | as above | cluster |
| Schedule | the raw expression, tooltip with `describeSchedule` and a note that the first field is seconds | expression |
| Method | as above | method |
| Last run | `ReactiveDuration` since `lastScheduleTime`, "N/A" before the first run | time |
| Next run | relative time to `nextScheduleTime` ("in 5h"), exact time in the tooltip; "N/A" when suspended | time |
| Active | `BadgeBoolean` of `!spec.suspend` (positive phrasing) | suspend |
| Condition | `Badge` with `classifySchedule(...).label` | state |
| Status | `classifySchedule(...).reason` | reason |
| Age | `KubeObjectAge` | creation |

### Backup drawer (`src/renderer/details/backup-details-v1.tsx`)

1. **Outcome**: condition badge and reason, phase, method (with the
   deprecated badge), online or offline, target (`primary`,
   `prefer-standby`), the error and the command error in a read-only Monaco
   block when longer than one line.
2. **Source**: cluster (link to its drawer), instance pod (link when it
   exists), PostgreSQL major version, parent schedule (link) or "On
   demand".
3. **Timing**: started, stopped (`LocaleDate`), duration, reconciliation
   started and terminated.
4. **Restore coordinates**: backup id, backup name, timeline, begin and end
   WAL, begin and end LSN, WAL written during the backup (humanized, exact
   bytes in the tooltip). This is the section an operator copies from when
   writing a recovery `Cluster`: every value is selectable text. Hidden as a
   whole when the backup never started.
5. **Destination**: for `plugin`, the plugin name and version and the object
   store name (from `pluginConfiguration.parameters`, else from the
   cluster's `spec.plugins`), as text until M3 brings the `ObjectStore`
   drawer; for `barmanObjectStore`, destination path and server name under
   a "deprecated" badge; for `volumeSnapshot`, a nested table of
   `snapshotBackupStatus.elements` (name, type, tablespace).
6. **Plugin metadata**: nested key and value table of
   `status.pluginMetadata`, hidden when empty.

### Scheduled Backup drawer (`src/renderer/details/scheduled-backup-details-v1.tsx`)

1. **Schedule**: condition badge and reason, the expression, its
   description in words, Active (`BadgeBoolean`), immediate, last check,
   last run, next run (`LocaleDate` plus relative time).
2. **Backup template**: cluster (link), method (deprecated badge), target,
   online, plugin configuration, backup owner reference with a one-line
   explanation of the three values (what gets deleted with what).
3. **Generated backups**: the backup history strip over the backups that
   carry this schedule's label, then a nested table of the latest ten
   (name as link to the Backup drawer, condition, started, duration) and a
   door "All backups of this schedule" to the filtered list.

### Backup history strip (`backup-history.ts` pure, `backup-history.tsx` thin)

- Pure part: `buildHistory(backups, schedules, now, windowDays)` returns the
  marks (one per backup: time, state, name), the recoverability window
  (first recoverability point of H3 to now, only while archiving is not
  failing), the next scheduled run (earliest `nextScheduleTime` among the
  active schedules of the cluster) and the longest gap between successful
  backups in the window. Window: 7 days by default, 30 when the cluster has
  fewer than two backups in the last 7. Marks closer than the strip can
  resolve are merged into a counted mark (pure, tested).
- Component: a single horizontal DOM strip, time left to right, "now" at
  the right edge with the next run beyond it as a hollow mark; marks
  colored by the tokens of DESIGN.md section 2 (`--colorSuccess`,
  `--colorError`, `--colorInfo` for running); the recoverability window as
  a tinted band (`color-mix` on `--colorOk`); below it one line of exact
  facts: last successful, longest gap, next run. Every mark is a door to
  the Backup drawer (a merged mark opens the filtered list); every mark has
  a tooltip with name, outcome and exact time; marks are focusable and
  operable from the keyboard.
- Mounted in the Cluster drawer section "Backups and archiving" (SPEC-0003
  section 6, above the facts) and in the Scheduled Backup drawer section 3.
- Empty state: "No backups in the last 30 days" with, when no schedule
  exists for the cluster, "and no scheduled backup is defined" in warning.

### Doors from the M1 views

- Cluster drawer, "Backups and archiving": the strip, the cluster's
  schedules as links to their drawers (the DESIGN.md section 3 promise),
  and "All backups of this cluster" to the filtered Backups list.
- Overview (SPEC-0004): the "Backups overdue" counter opens the Backups
  list; the last backup line of a tile opens the Backups list filtered by
  that cluster; the next scheduled backup line opens the schedule's drawer.
  SPEC-0004 is amended in the same PR.

### Non-happy states

Loading and empty lists by the layout; render errors by `withErrorPage`;
CRD-absent panel per page; a backup without status renders Pending with "No
status reported yet" and hides the empty sections; a backup whose cluster
or pod no longer exists shows the names as plain text; the strip has its
own empty state (above) and never blanks the drawer.

### Themes

Both themes checked by the pre-review pass screenshots; no colors authored.

### Safety

Reads only. The destination section shows paths and names, never
credentials: the object store secrets are not read. No write is offered
anywhere (the row menus keep only the host's entries).

## Tests (non-regression list)

- Unit: `backup-health.test.ts` (every phase of R3 plus absent and unknown,
  reason precedence of `error` over `commandError`, durations with missing
  ends, timeline from metadata and from the WAL name, schedule states
  including overdue tolerance and suspended with a stale next run),
  `cron-text.test.ts` (six-field expressions, descriptors, garbage returns
  undefined, a five-field expression is not described as if valid),
  `backup-history.test.ts` (window choice, merging, recoverability band
  suppressed when archiving fails, next run among several schedules with a
  suspended one, longest gap), helper cases in `backup-v1.test.ts` and
  `scheduled-backup-v1.test.ts`.
- Integration: the scaffold's activation case, unchanged.
- E2E (appended to `cnpg-e2e.tests.ts`), with two fixtures added to
  `50-scheduledbackups.yaml`: `e2e-immediate` (`immediate: true` on
  `e2e-main`, so the operator creates a labelled backup at once) and
  `e2e-suspended` (`suspend: true`):
  - the Backups page lists `e2e-backup-ok` Completed and
    `e2e-backup-failed` Failed with the upstream error as Status, plus one
    backup whose Schedule column reads `e2e-immediate`;
  - the `e2e-backup-ok` drawer shows the restore coordinates (backup id,
    begin and end WAL and LSN, timeline 1), the instance pod link resolving
    and the plugin version;
  - the Scheduled Backups page lists `e2e-nightly` Active with a next run,
    `e2e-suspended` Suspended, `e2e-immediate` with a last run;
  - the `e2e-immediate` drawer lists its generated backup and the link
    opens that Backup drawer;
  - the `e2e-main` Cluster drawer shows the strip with at least two
    successful marks and the next run, and "All backups of this cluster"
    lands on a list filtered to `e2e-main`.
- Manual verification: both themes on a real Freelens, and the judgment
  call on the strip ("does it tell the protection story at a glance")
  during the milestone review.

## Notes and deviations

- Approved on 2026-09-19 by the lead maintainer, with the three points the
  draft left open closed as proposed: the backup history strip ships in M2
  inside the drawers (not deferred to the events timeline of M5);
  `cronstrue` is a bundled dependency (MIT, zero dependencies, about 22 kB
  minified for the English locale) behind `describeSchedule`; a suspended
  schedule is classified `warning`.
- Implementation notes: a five field `spec.schedule` is valid upstream (the
  day of week is optional, the first field is still the seconds), so
  `describeSchedule` reads it that way instead of refusing it: `0 0 3 * *` is
  03:00 every day, not midnight on day 3 of the month as a crontab line
  would say. `@every` intervals are described after truncation to whole
  seconds, one at least, as the operator's parser does. On the E2E cluster a
  schedule that has not run yet reports `lastCheckTime` only, with no
  `nextScheduleTime`: the classifier says "Waiting for the first run" and
  the Next run column shows "N/A" until the operator reports a time.
- The strip's component is `backup-history-strip.tsx`, not
  `backup-history.tsx`: two modules called `backup-history` with different
  extensions would shadow each other on import.
- The host's `MonacoEditor` only accepts `yaml` and `json`, so the full error
  of a failed backup (when longer than one line) is a preformatted block,
  selectable and wrapped, instead of an editor.
- The words of a schedule always carry "in the operator's time zone, normally
  UTC": the operator evaluates the expression with its own clock while every
  date in the views is in the user's time zone (on the E2E cluster the
  schedule `0 30 4 * * *` reports its next run at 04:30 UTC, shown as 06:30
  at UTC+2).
- Verified on the E2E cluster: the parent label is there on the generated
  backups; `nextScheduleTime` appears only after the first run; a suspended
  schedule created suspended has no status at all (the classifier checks the
  suspension before the missing check time). On a long-lived local cluster
  `e2e-nightly` does fire (and catches up after the machine slept), so the
  E2E cases assert what holds in both situations and never that it has no
  run.
- The Instance column of the Backups list and the pod row of the drawer link
  through the host details URL (`StoreLink`), the mechanism M1 found to work
  for every kind, rather than through `LinkToPod`.
