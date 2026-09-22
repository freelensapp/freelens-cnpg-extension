# SPEC-0024: Fencing and hibernation

- **Status:** Verified
- **Milestone:** `M6` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-20

## Goal

The user stops PostgreSQL on an instance, or on all of them, and puts a
whole cluster to sleep and wakes it, with the consequences for everything
attached to the cluster listed before the click, and with the way back one
click away from where the state is shown.

## Upstream reference

- Fencing (v1.30.0): the annotation `cnpg.io/fencedInstances` on the
  `Cluster` holds a JSON array of instance names, sorted, or exactly `["*"]`
  for all of them. Fencing `*` replaces the named entries; lifting `*`
  clears the list; lifting one named instance while `*` is set is refused by
  the upstream tooling; an empty list removes the annotation. The instance
  manager of a fenced pod shuts PostgreSQL down and keeps the pod, which
  turns not ready. While the primary is fenced the operator deliberately
  triggers no failover, and rollouts skip fenced instances.
- The webhook does not validate this annotation: a value that does not parse
  is accepted and silently means that nobody is fenced. The upstream patch
  carries no resource version, although the whole set lives in one string.
- The operator fences an instance itself for the duration of a cold volume
  snapshot backup, and refuses to start one while another instance is
  fenced.
- The phase does not change while instances are fenced (spike S3 of
  SPEC-0020): the state is the annotation and the readiness of the pods.
- Hibernation: the annotation `cnpg.io/hibernation` with the value `on` or
  `off`; the webhook refuses any other value. It does not start until the
  phase is healthy (condition `cnpg.io/hibernation`, reason
  `WaitingForHealthy`); then the operator deletes the primary pod first and
  the others one at a time (`DeletingPods`, `WaitingPodsDeletion`), keeps
  every volume and ends with the condition true, reason `Hibernated`. The
  phase stays the healthy one throughout. With `off`, or without the
  annotation, the condition is removed and the pods are recreated on their
  volumes.
- A backup requested on a hibernated cluster fails; schedules are not
  suspended by the hibernation and keep producing failed backups. The
  declarative databases, roles, publications and subscriptions of the
  cluster are reconciled by the instance manager of its primary (SPEC-0013):
  without a primary nothing reconciles them.

## Scope

Included: "Fence" and "Lift the fence" on the row of an instance; "Fence all
instances" and "Lift all fences" on the `Cluster`; the lifting control on the
"Fenced instances" row of the drawer; "Hibernate" and "Resume" on the
`Cluster`, the resuming control on the "Hibernation" row of the drawer; the
progress of a hibernation in that row, from the condition.

Excluded: suspending the schedules of the cluster as part of the hibernation
(one write per dialog in M6: the dialog lists them with the door to
SPEC-0021); what reads from a fenced standby (read-only poolers and
services) as a computed consequence; the maintenance window of the nodes (a
later milestone decides).

## Design

### Standard or ad hoc view, and why

Actions under SPEC-0020, with dialogs whose body is computed from what is
attached to this cluster.

### Fencing, pure module (`src/renderer/components/fencing.ts`)

- `parseFenced(annotation)`: the set, or `unparseable`. An unparseable value
  is shown as an error in the "Fenced instances" row ("The annotation does
  not parse: the operator treats every instance as not fenced") and leaves
  one action available, "Lift all fences", which removes it.
- `fenceOn(set, instance | "*")` and `fenceOff(set, instance | "*")`: the
  next set, or `unchanged`, in the semantics above; the serialized value is
  compact, sorted JSON; an empty set is `null` in the merge patch, which
  removes the key (spike S1).
- Guards. Fence an instance: the name is in `status.instanceNames`; not
  already fenced; not hibernated; W3. Lift one: refused while `*` is set
  ("The whole cluster is fenced: lift all fences instead"). Lift, any form:
  refused while a backup of this cluster with method `volumeSnapshot` and
  `online: false` is running ("The operator fenced it for a cold snapshot
  backup and lifts it itself"). Fence all: not hibernated; W3.
- The patch carries `metadata.resourceVersion` (W6): the new value was
  computed from the old one.

### Fencing, dialogs

The write, with the old and the new value of the annotation. Notes: the pod
stays, PostgreSQL stops, the pod turns not ready. Warnings, by what is being
fenced: the primary (or all): "Writes stop and no failover happens while the
primary is fenced: that is what fencing is for"; a standby needed for the
synchronous `number` with a `dataDurability` other than `preferred`: writes
wait. Typed name for fencing (W5), one click for lifting.

### Hibernation, pure module (`src/renderer/components/hibernation.ts`)

- `hibernationState(cluster)`: `off`; `requested` (annotation `on`, no
  condition yet); `waiting` (`WaitingForHealthy`); `in progress`
  (`DeletingPods`, `WaitingPodsDeletion`, with the pod being waited for);
  `hibernated`; `resuming` (annotation `off` or absent while fewer ready
  instances than declared and the condition gone). The "Hibernation" row of
  the drawer shows this state, not the bare annotation, and the Health badge
  of SPEC-0003 keeps deriving "Hibernated" from it.
- `canHibernate`: not already `on`; W3. A phase that is not the healthy one
  is a warning, not a refusal: the request is accepted and parks in
  `WaitingForHealthy`, and the dialog says so with the phase quoted.
- `canResume`: the annotation is `on`; W3.
- `hibernationConsequences(cluster, related)`: from the stores the
  extension already loads: the pods that will be deleted, the primary first;
  the volumes that are kept, with their sizes; the poolers that lose their
  backend; the schedules that are not suspended and will produce failed
  backups (with the door to each); the declarative objects that stop being
  reconciled (counts per kind); the subscriptions, here or on other clusters
  of this Kubernetes, whose publisher or subscriber this cluster is
  (SPEC-0015), which stall.
- Bodies: `cnpg.io/hibernation: "on"`, and `"off"` to resume (the explicit
  value, as the upstream tooling writes it).

### Hibernation, dialogs

Hibernate: subject and context, the write, the consequences as short lists
under their own headings, each omitted when empty; typed name (W5). Resume:
the write, the pods that will come back on which volumes; one click.

### After

"Hibernation of `<cluster>` requested" and "Resume of `<cluster>`
requested", "Fencing of `<instance>` requested", "Fence of `<instance>`
lifted: requested". The row of the state in the drawer is where it can be
followed, and the Timeline.

### Safety

Two annotations, written with values the extension builds itself: `on`,
`off`, or JSON from an encoder over names taken from
`status.instanceNames`. A fenced set is never written from a stale read
(W6).

## Tests (non-regression list)

- Unit: `fencing.test.ts`: parsing (absent, empty list, names, star,
  unparseable, not an array, non strings); every transition of `fenceOn` and
  `fenceOff` including star replacing names, the refused named lift under
  star, unchanged cases, the removal of the key; sorting; every guard reason
  including the cold snapshot backup; the warnings. `hibernation.test.ts`:
  every state from annotation and condition; both guards; each consequence
  list present and empty; the bodies.
- E2E, on `e2e-actions`: fence the standby from its row (typed name), and
  `kubectl` reads the annotation with exactly that name and the pod not
  ready, the drawer row lists it; lift it from the drawer row, and the
  annotation is gone and the pod ready; Hibernate (typed name), and `kubectl`
  reads the annotation `on`, then no pod of the cluster and the condition
  `Hibernated`, with the volumes still there; Resume from the drawer row, and
  two ready instances again. On the fixtures: "Resume" is offered on
  `e2e-hibernated` and "Lift the fence" on the instance of `e2e-fenced`
  (opened and closed without writing).
- Pre-review: the dialogs on both themes, the hibernation dialog with its
  consequence lists filled by the demo objects.
- Manual verification: hibernate and resume of the demo cluster under load,
  during the M6 milestone review.

## Notes and deviations

- Approved on 2026-09-20 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M6 at the
  milestone review.
- Implemented on 2026-09-21.
- The menu of the cluster renders one of "Fence all instances" and "Lift all
  fences", and one of "Hibernate" and "Resume", like Suspend and Resume of
  SPEC-0021: the way back while anything is fenced (or the value does not
  parse, which only "Lift all fences" can remove), the way in otherwise. With
  some instances fenced by name, fencing the rest is one click per row. This
  keeps the toolbar of the drawer, which renders every registration, at two
  icons for this spec instead of four.
- The actions of one instance (Restart, Fence or Lift the fence, Promote)
  share one "Actions" column of the Instances table: with a column each the
  table had eleven and every header was truncated at the width of the drawer.
  Promote comes last, so the other two line up on the row of the primary,
  which has no Promote.
- The control of the "Fenced instances" row is "Lift all fences". Under the
  star the row of an instance offers "Lift the fence" refused, with the reason
  that points there.
- The fenced set is parsed by `parseFenced`, stricter than the reader of the
  health model (SPEC-0003), which keeps treating a malformed value as nobody
  fenced, as the operator does. The drawer shows the value that does not
  parse as an error; the Health badge does not change.
- On a conflict the fencing write is retried by `writeWithConflictRetry`
  (SPEC-0022). The line quotes the old value, so a fenced set that changed in
  between always reopens the dialog: a set is never written from a stale read.
  The merge patch carries `null` to remove the key; the host's type for a
  patch knows only values, so the call casts it.
- `resuming` is reported only while the annotation says `off`: a cluster
  that never slept and lost an instance is not resuming. A cluster whose
  annotation was removed by hand while it slept shows no row until it is back,
  as before this spec.
- A phase that is not the healthy one warns in the dialog of a hibernation and
  does not refuse it, as the spec asks; the state then reads "Waiting".
- The consequences read the stores the extension already has, loaded for the
  namespace of the cluster before the dialog opens; the subscriptions of other
  clusters are the ones of the namespaces the user has selected, resolved to
  this cluster with the resolver of SPEC-0015.
- The E2E case spells the value the hibernation annotation replaces from what
  `kubectl` reads, because a cluster that was resumed once carries the
  explicit `off`.
- M6 milestone review: 2026-09-22, lead maintainer, on the screenshots of the
  pre-review pass on both themes (gallery on an ephemeral branch, deleted
  after the review). Verdict: approved, no blocking finding. Status moved to
  Verified.
- Manual verification under load: 2026-09-22, the same run as the
  verification of SPEC-0022. The hibernation case put `e2e-actions` to sleep
  and woke it from the drawer while the load ran: the client saw 65 refused
  inserts between 18:29:26 and 18:29:52 UTC (the fence of a standby, the
  sleep and the wake), the cluster came back healthy with both instances on
  the volumes they had, and every acknowledged insert was in the table
  afterwards.
