# SPEC-0020: Write actions, the ground rules, and the on-demand backup

- **Status:** Approved
- **Milestone:** `M6` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-20

## Goal

The extension starts to write. This spec fixes, once and for all the actions
of M6, how a write is offered, confirmed, sent, reported and tested, and it
ships the first one: a backup of a cluster requested by hand, from where the
user already is.

## Upstream reference

- `kubectl cnpg backup` (v1.30.0): one `create` of a `Backup` in the
  namespace of the cluster, labelled `cnpg.io/cluster`, named
  `<cluster>-<YYYYMMDDHHMMSS>` by default. The plugin checks only that the
  cluster exists; everything else is decided by the admission webhook and by
  the operator.
- Operator side: a backup requested on a hibernated cluster fails
  (`ClusterIsHibernated`); method `plugin` on a cluster with no entry in
  `.spec.plugins` fails (`ClusterHasNoBackupExecutorPlugin`); the other
  methods need their section of `.spec.backup`. With the method left out the
  CRD default is the deprecated in-tree `barmanObjectStore`, which fails on a
  cluster that only uses a plugin: the method is never left out.
- Backups of one cluster run one at a time, oldest first: the others stay
  `pending` and are retried every 10 seconds. Nothing is rejected because a
  backup is already running.
- The target is `.spec.target` of the backup, else `.spec.backup.target` of
  the cluster, else `prefer-standby`: a ready standby when there is one, the
  primary otherwise.
- The spec of a `Backup` is immutable once created.
- Admission: the webhooks of the operator cover `clusters`, `backups` and
  `scheduledbackups` (create and update) with `failurePolicy: Fail`, and they
  do not cover `clusters/status`. Every update of a `Cluster`, an annotation
  included, runs the full validation of the cluster.

## Scope

Included: the ground rules W1 to W12 below, binding for SPEC-0021 to
SPEC-0024; the shared machinery they need (guard type, dialog, typed name
confirmation, access review, failure sentences, timestamp formats, the write
client for the status subresource); the "Back up now" action of a `Cluster`;
the dedicated E2E fixture cluster every write case of M6 runs against;
DESIGN.md section 13 brought in line with what the spikes found.

Excluded: options of a volume snapshot backup beyond the method itself
(online, immediate checkpoint, wait for archive: the cluster's own defaults
apply); plugin parameters on the backup (the cluster's plugin configuration
resolves the object store); deleting a backup (the host's own delete stays
what it is); creation forms (M7).

## Design

### Standard or ad hoc view, and why

Neither a list nor a page: an action appears where the user already is, in
the menu of the object it is about, and its dialog is the view. The dialog
is ad hoc on purpose. A generic "Are you sure?" is the worst possible view
for a write on a database: the dialog of each action states the facts of
this cluster that decide what the write will do to it.

### Ground rules

- **W1, surfaces.** One `kubeObjectMenuItems` registration per action: the
  host renders it in the row menu of the list and in the toolbar of the
  drawer. An action about one instance lives in the row of that instance in
  the Instances table of the Cluster drawer. When the drawer already shows
  the fact an action reverses (Hibernation, Fenced instances), the row of
  that fact carries the reversing control too. Actions never appear on
  overview tiles, in list cells or on the ad hoc pages in M6.
- **W2, guards.** A guard is a pure function over the facts of the live
  object and returns either `enabled` or `disabled` with a reason: the type
  makes a disabled control without a reason a compile error. The reason is
  the tooltip of the control and its native `title`. The guard runs at
  render and again on the click, against the object as the store holds it at
  that moment, because the host's `disabled` on a `MenuItem` is styling and
  does not stop the click. An object that is being deleted offers no action.
- **W3, access.** Each action asks the API server, once per namespace and
  per minute, whether the user may perform its writes
  (`SelfSubjectAccessReview`: a review is evaluated and not stored). A
  denial disables the action with a reason that names the verb and the
  resource. A review that fails or is itself forbidden leaves the action
  enabled: a read that fails never blocks a write the user may be allowed to
  make.
- **W4, the dialog.** `ConfirmDialog.open({ ok })`. The message names the
  kind and `namespace/name` of the object, the Kubernetes cluster as Freelens
  names it with its kubeconfig context, then one numbered line per API call
  in the order they are made (verb, object, field or annotation, old value
  to new value), then what the write means for this cluster (notes) and what
  it costs (warnings). The facts come from the same snapshot the guard saw on
  the click. A write that would change nothing is not sent and not listed.
- **W5, typed name.** An action that interrupts the primary or takes
  instances down (switchover, restart of the cluster, restart of the primary,
  fencing, hibernation) keeps its OK button disabled until the user has typed
  the name of the cluster. The actions that bring things back (lift a fence,
  resume) and the ones that interrupt nothing (backup, reload, suspend,
  resume of a schedule, restart of a standby) confirm with one click.
- **W6, patch types and conflicts.** Every patch is a JSON merge patch with
  an explicit body. A patch carries `metadata.resourceVersion` when the value
  it writes was computed from the value it replaces (the list of fenced
  instances) and whenever it targets the status subresource. On `409` the
  action reads the object again, runs the guard again and rebuilds the facts:
  when the lines of W4 are still the same it retries (three attempts), and
  when they are not it reopens the dialog with the new facts and says that
  the cluster changed in the meantime, so the user never confirms one write
  and sends another.
- **W7, the status subresource.** Two writes of M6 go to `clusters/status`,
  as the upstream tooling does (SPEC-0022, SPEC-0023). They live in one
  module that can express exactly those two requests and nothing else, like
  the pod proxy client of SPEC-0006. The patch leaves `status.conditions`
  out: a merge patch replaces arrays whole, and the operator recomputes
  `Ready` from the phase by itself.
- **W8, no optimistic UI.** Nothing on screen changes because the user
  clicked. While the write is in flight the OK button is in the host's
  `waiting` state. On success a notification says what was written and that
  the operator does the rest, with a door to where it can be followed (the
  Timeline, the drawer of the new object). The words are "requested", never
  "done".
- **W9, failures.** The message of the API server is shown as it came,
  because the webhook names the offending field. Around it: on `403` the verb
  and the resource the account lacks; on `404` that the object is gone; when
  the admission webhook does not answer, that the operator may be down, with
  a door to the Operator page; when an action of two calls stops after the
  first, the state it left and how to finish. A failure is never swallowed
  and never retried silently, except for the conflict of W6.
- **W10, what is never written.** `spec.replica` and anything of the
  promotion of a replica cluster; `cnpg.io/validation`; `cnpg.io/podPatch`;
  the labels `cnpg.io/scheduled-backup` and `cnpg.io/immediateBackup`, which
  belong to the operator; any deprecated form as a default.
- **W11, replica clusters.** On a cluster that follows another one
  (`.spec.replica.enabled`, or `.spec.replica.primary` naming another
  cluster) the actions about the primary are disabled with that reason in
  M6: there the same write only moves the designated primary, and saying so
  properly is a view of its own.
- **W12, tests.** Every guard branch, every dialog fact and every request
  body is a unit case. Every action has an E2E case that performs it in the
  real Freelens and reads the result back from the cluster with `kubectl`.
  The pre-review pass screenshots every dialog on both themes and asserts
  the reason of every disabled action of the fixtures.

### Shared machinery

- `src/renderer/components/write-actions.ts` (pure): `ActionGuard`,
  `ActionWrite`, `ActionDialogFacts`, `isReplicaCluster`, the two timestamp
  formats of the upstream tooling (`rfc3339Seconds`, and `rfc3339Micro` with
  exactly six fractional digits, both in UTC), `apiFailureFacts(error)` and
  the sentences of W9, `sameWrites(a, b)` for W6.
- `src/renderer/components/access-review.ts`: the review of W3 with its
  one minute cache, over an injected `fetch`.
- `src/renderer/api/writes/cluster-status-writes.ts`: the module of W7.
- `src/renderer/menus/action-menu-item.tsx`: the shell every action is
  built on (render guard, click guard on the live object, plan, dialog);
  `src/renderer/components/action-dialog.tsx`: the message of W4 and the
  typed name of W5. The OK button follows an `okButtonProps` that is a MobX
  observable, because the host reads it on its own render only; the model of
  a dialog lives outside React so that a reopen keeps the values; a reopen
  waits 250 ms, because the host's dialog animation leaves a dialog reopened
  inside its leave window invisible and still intercepting clicks.

### Back up now

- **Entry.** "Back up now" (icon `backup`) on the `Cluster` kind.
- **Guard.** Disabled when the cluster is hibernated ("The operator fails a
  backup requested on a hibernated cluster"); when the cluster declares no
  way to take one ("The cluster declares no backup plugin and no backup
  section: the operator would fail the backup"); when `backups` cannot be
  created (W3). A cluster without a ready instance is not a reason: the
  backup waits, and the dialog says so.
- **Methods offered**, from the cluster alone: one per enabled entry of
  `.spec.plugins` (the WAL archiver first); `volumeSnapshot` when
  `.spec.backup.volumeSnapshot` is there; the in-tree `barmanObjectStore`
  when `.spec.backup.barmanObjectStore` is there, labelled deprecated and
  never preselected while another method exists. With one method the field
  is a sentence, not a select.
- **Form.** Method; target ("The cluster's default", which the dialog
  resolves in words, "Primary", "Prefer a standby"); name, preset to
  `<cluster>-<YYYYMMDDHHMMSS>` in UTC, validated as a DNS subdomain and
  refused when it has the form `<schedule>-<14 digits>` of a schedule of
  this cluster (the operator would skip that run of the schedule).
- **Notes.** Which instance the operator will pick as things stand; how many
  backups of this cluster are not finished yet, because this one waits its
  turn behind them; that the spec of a backup cannot be edited afterwards.
- **Write.** `create Backup <namespace>/<name>` with the label
  `cnpg.io/cluster`, `spec.cluster.name`, `spec.method`, `spec.target` when
  chosen, `spec.pluginConfiguration.name` for a plugin method. `409` because
  the name exists reopens the dialog with the values intact and the name
  flagged.
- **After.** "Backup `<name>` requested" with a door to its drawer; the
  Backups list, the history strip and the Timeline already show it as it
  moves through `pending`, `started` and `completed` or `failed` (SPEC-0005,
  SPEC-0017).

### E2E fixture for the writes

A dedicated cluster `e2e-actions` (two instances, the working object store,
a weekly schedule of its own) receives every write of the M6 suite, so the
clusters the read-only cases assert stay as their fixtures left them. The
write cases run last and in a fixed order that ends with the hibernation.

### Non-happy states

Covered by W2, W3 and W9: a refused action says why where it is, a failed
write says what the API server said.

### Themes

Host components only (`ConfirmDialog`, `MenuItem`, `Icon`, `Input`,
`Select`, `Notifications`) plus one SCSS module for the dialog body, on the
theme variables: both themes are asserted by the pre-review pass.

### Safety

This spec is the safety design of M6. What the action of this spec writes:
one `Backup` object, never anything on the cluster. What it reads in
addition to M1 to M5: one access review per namespace and minute.

## Spikes (2026-09-20, kind, operator 1.30.0)

- S1: a JSON patch whose `test` fails, or that removes a key that is not
  there, answers `422` with a generic sentence that says nothing to the
  user, the same code the webhook uses for a real validation error. A merge
  patch with a stale `metadata.resourceVersion` answers `409` with a clear
  one. Hence W6, and DESIGN.md section 13 changes with this spec (it asked
  for JSON patches on annotations). `null` in a merge patch removes an
  annotation.
- S2: the switchover through a merge patch on `clusters/status`, conditions
  left out, completed in 19 seconds and the operator put `Ready` back
  itself.
- S3: with one instance fenced, and with all of them fenced, the phase stays
  "Cluster in healthy state": fencing is read from the annotation and from
  the pods, never from the phase.
- S4: the in-place restart of the primary through the status subresource
  kept the pod (same UID), restarted PostgreSQL and went back to healthy in
  18 seconds with the reason "Primary instance restarted in-place".
- S6: `SelfSubjectAccessReview` answers for the `status` subresource of
  `clusters` as for any resource.

## Tests (non-regression list)

- Unit: `write-actions.test.ts` (guard type helpers, both timestamp formats
  including the six digits, failure sentences for 403, 404, 409, 422 and a
  webhook that does not answer, `sameWrites`, replica cluster detection);
  `access-review.test.ts` (allowed, denied, failed, cache and its expiry, the
  subresource in the request); `cluster-status-writes.test.ts` (path, content
  type, body without conditions, resource version); `backup-now.test.ts`
  (every guard reason, methods offered for each shape of cluster, the
  deprecated method never preselected, default name, name validation and the
  schedule collision, the resolved target sentence, the queue note, the body
  of the create).
- Integration: the scaffold's activation case, unchanged.
- E2E: "Back up now" from the row menu of `e2e-actions`: the dialog names the
  cluster and the context and lists one create; after OK `kubectl` finds the
  `Backup` with the method, the plugin and the label, and it reaches
  `completed`; the entry of `e2e-hibernated` is disabled with its reason.
- Pre-review: the dialog on both themes; the disabled entry with its reason.
- Manual verification: none beyond the M6 milestone review.

## Notes and deviations

- Approved on 2026-09-20 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M6 at the
  milestone review.
