# SPEC-0021: Scheduled backups, suspend, resume and run now

- **Status:** Implemented
- **Milestone:** `M6` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-20

## Goal

A schedule can be paused and resumed from its own menu, and a backup with
the settings of a schedule can be requested at once, without waiting for the
next run and without pretending the schedule ran.

## Upstream reference

- `.spec.suspend` of a `ScheduledBackup` (v1.30.0): while true the
  controller returns at once, creates nothing and does not advance the
  status, so `status.nextScheduleTime` simply goes stale. On resume the next
  time is computed from `status.lastCheckTime`: when it is already in the
  past the controller creates one backup for that missed run right away and
  then goes back to the cadence. It does not replay every missed run.
- `.spec.immediate` is read on the first reconciliation of the object only:
  setting it later does nothing. There is no upstream way to trigger a run
  of an existing schedule.
- A backup of a schedule is named `<schedule>-<YYYYMMDDHHMMSS>`, labelled
  `cnpg.io/scheduled-backup` and `cnpg.io/immediateBackup`, and copies
  `cluster`, `target`, `method`, `online`, `onlineConfiguration` and
  `pluginConfiguration` from the schedule. The controller finds the backups
  of a schedule by that label and postpones the schedule while one of them is
  not finished; it skips a run whose name is already taken by a backup it did
  not create.
- The kubectl plugin has no command for schedules.

## Scope

Included: "Suspend" and "Resume" on a `ScheduledBackup`; "Run now", which
creates an ordinary `Backup` with the settings of the schedule; the mark of
such a backup in the history strip of the schedule.

Excluded: editing the cron expression or any other field (M7, with the cron
editor); suspending the schedules of a cluster as a part of its hibernation
(SPEC-0024 warns and gives the door here).

## Design

### Standard or ad hoc view, and why

Actions in the menu of the object, under the rules of SPEC-0020.

### Pure module (`src/renderer/components/scheduled-backup-actions.ts`)

- `canSuspend`, `canResume`: exactly one of the two entries is rendered,
  by `.spec.suspend`. Disabled only by W3 (`patch` on `scheduledbackups`).
- `resumeFacts(schedule, now)`: when `status.nextScheduleTime` is in the
  past the dialog warns that the operator will create one backup right
  away; otherwise it says when the next one is due.
- `canRunNow(schedule, cluster)`: disabled when the cluster of the schedule
  is not in the namespace, when it is hibernated (same reason as SPEC-0020),
  or by W3 (`create` on `backups`). A suspended schedule can be run by hand:
  the dialog says that the schedule stays suspended.
- `runNowBackup(schedule, now)`: the body. Name
  `<schedule>-manual-<YYYYMMDDHHMMSS>` in UTC, which can never collide with
  a run of the schedule; label `cnpg.io/cluster` only; annotation
  `cnpg-extension.freelens.app/scheduled-backup: <schedule>`; the six fields
  the controller copies, copied. No owner reference, and the dialog says
  what that means when the schedule declares one: unlike the backups of the
  schedule, this one stays when the schedule (or the cluster, by
  `backupOwnerReference`) is deleted.

### Surfaces

- Menu of the `ScheduledBackup` kind: "Suspend" (icon `pause`) or "Resume"
  (icon `play_arrow`), and "Run now" (icon `backup`). One click
  confirmations (W5).
- History strip of the schedule (SPEC-0005): a backup carrying the
  annotation of this schedule appears on the same axis with a hollow mark
  and "requested by hand" in its tooltip. It is not counted in the success
  ratio of the schedule, because the schedule did not run it.

### Writes

- Suspend: merge patch `spec.suspend: true`. Resume: `spec.suspend: false`
  (the explicit value, so the object says what was decided).
- Run now: `create Backup`, as above. A name that exists (two clicks in one
  second) reopens the dialog with the next second.

### Non-happy states, themes

As SPEC-0020. A suspended schedule already shows as such in the list and the
drawer (SPEC-0005).

### Safety

Writes: one field of one `ScheduledBackup`, or one new `Backup`. Never the
operator's labels (W10), so a backup requested by hand can never delay or
replace a run of the schedule.

## Tests (non-regression list)

- Unit: `scheduled-backup-actions.test.ts`: which entry renders for each
  value of `suspend` (absent, false, true); the resume warning on a past and
  on a future next time, and with no status at all; every reason of
  `canRunNow`; the body of the backup (name form and that it does not match
  the pattern of a run, the label, the annotation, each copied field present
  and absent, no operator label, no owner reference); the ownership sentence
  for `none`, `self` and `cluster`. `backup-history.test.ts`: a backup
  requested by hand is on the strip, marked, and out of the ratio.
- E2E, on the schedule of `e2e-actions`: Suspend, and `kubectl` reads
  `spec.suspend` true and the entry has become Resume; Resume, and it reads
  false; Run now, and `kubectl` finds the backup with the annotation, without
  the operator's labels, reaching `completed`, while
  `status.lastScheduleTime` of the schedule did not move.
- Pre-review: the three dialogs on both themes.

## Notes and deviations

- Approved on 2026-09-20 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M6 at the
  milestone review.
- Implemented on 2026-09-21.
- The history strip has no success ratio to keep a backup requested by hand
  out of: the figures it has are "Last successful" and "Longest gap". Both,
  and the choice of the window and the recoverability band with them, are
  computed from the runs of the schedule only. A backup requested by hand is
  a mark on the axis, never merged with a run, and it is not listed in the
  table of the generated backups, which stays the list of what the schedule
  generated. On the strip of the Cluster it is a backup like any other: there
  it does protect the cluster. Under the strip "Requested by hand: N" is the
  legend of the hollow marks, so what they are does not depend on a tooltip.
- `canSuspend` and `canResume` refuse on the click the write that would change
  nothing (W4): between the render and the click somebody else may have
  written the same value. At render exactly one entry exists, read from the
  object as the store holds it, so after the write the entry turns into its
  opposite in the row menu and in the toolbar of the drawer without a reload.
- "Run now" is not refused while the clusters of the namespace are still
  loading: a read that has not finished never blocks a write (the principle
  of W3), and the guard runs again on the click. The list of the schedules
  does not load the clusters by itself, so the entry asks for them.
- The name of the backup and the body are computed from one instant, taken
  when the dialog opens: the name the user reads is the name that is sent. On
  `AlreadyExists` the dialog reopens with the name of the current second.
- A schedule that declares no method gets no method in the body either, so
  the backup takes the default of the API exactly as a run of the schedule
  would; the dialog says so and warns that this default is the deprecated
  in-tree method. Forcing a method here would make "with the settings of the
  schedule" untrue.
- On the fixture of the write cases the schedule has never run, so
  `status.nextScheduleTime` is absent and the dialog of a resume says that no
  next run is reported yet. The warning about the backup taken right away is
  covered by the unit cases: making it happen in the E2E suite would need a
  schedule left suspended across one of its runs.
