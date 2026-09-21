# SPEC-0023: Restart and reload

- **Status:** Implemented
- **Milestone:** `M6` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-20

## Goal

The user restarts a whole cluster, or one instance of it, knowing before the
click what that means for this cluster: which pods go, in which order, and
what happens to the primary. And the user asks for a reload, told honestly
that nothing will report its completion.

## Upstream reference

- `kubectl cnpg restart <cluster>` (v1.30.0): a merge patch of the
  annotation `kubectl.kubernetes.io/restartedAt` on the `Cluster`, RFC 3339
  to the second. The operator rolls every pod whose own copy of the
  annotation differs: the standbys first, one at a time, by deleting the pod
  and recreating it on its volumes (phase "Upgrading cluster"); fenced
  instances are skipped. Then the primary, by the cluster's own settings:
  `primaryUpdateStrategy: supervised` stops at "Waiting for user action"
  until the user issues a switchover; `primaryUpdateMethod: restart` deletes
  the primary pod ("Primary instance is being restarted without a
  switchover"); `primaryUpdateMethod: switchover`, with more than one
  instance, switches over to a standby and then rolls the old primary; a
  single instance is simply deleted and recreated.
- `kubectl cnpg restart <cluster> <instance>`: for a standby, a delete of
  the pod; for the current primary, a merge patch with the resource version
  on the status subresource setting the phase "Primary instance is being
  restarted in-place" with the reason "Requested by the user". The instance
  manager restarts PostgreSQL inside the same pod and writes the healthy
  phase back itself; it refuses while a switchover is in flight. This case
  needs `patch` on `clusters/status`, which the upstream permission table
  does not list for restart.
- `kubectl cnpg reload <cluster>`: a merge patch of the annotation
  `cnpg.io/reloadedAt`, RFC 3339 with six fractional digits. Nothing reads
  the value: changing the object wakes the operator and the instance
  managers, which reconcile (configuration, secrets, certificates) and reload
  PostgreSQL when its configuration changed. There is no phase, condition or
  event that says it happened.
- The annotation patches go through the full validation of the cluster: a
  restart can be refused for a problem of the spec that has nothing to do
  with it, and fails when the operator's webhook does not answer.

## Scope

Included: "Restart" and "Reload" on a `Cluster`; "Restart" on the row of an
instance in the Instances table of the drawer (standby: pod delete; primary:
in place).

Excluded: choosing the order or the method of a rollout (they are the
cluster's spec: the dialog quotes them); restarting a pooler (the host's own
deployment restart covers it).

## Design

### Standard or ad hoc view, and why

Actions under SPEC-0020. The dialog of the cluster restart is where the
value is: it turns four spec fields into the sequence that will happen.

### Pure module (`src/renderer/components/restart-reload.ts`)

- `canRestartCluster`: disabled when hibernated ("There is no instance to
  restart"); when a switchover or failover is in flight; by W3 (`patch` on
  `clusters`).
- `restartPlan(cluster facts)`: the ordered steps the dialog lists, from
  `spec.instances`, the instance names and roles, the fenced set,
  `primaryUpdateStrategy` and `primaryUpdateMethod`: each standby in turn
  ("deleted and recreated on its volumes"), the fenced ones marked
  "skipped while fenced", then one of the four endings above, each with its
  consequence in words: a switchover to a standby the operator chooses; a
  write outage while the primary pod is recreated; a stop at "Waiting for
  user action" that the user ends with a switchover (door to SPEC-0022); the
  outage of a single instance.
- `canRestartInstance(cluster, instance)`: a standby needs its pod to exist
  with the cluster's labels (`cnpg.io/cluster`, `cnpg.io/podRole: instance`)
  and W3 (`delete` on `pods`); the primary needs the healthy phase and
  `currentPrimary == targetPrimary` and W3 (`patch` on `clusters/status`);
  a fenced instance is refused ("PostgreSQL is stopped on purpose: lift the
  fence instead").
- `canReload`: disabled when hibernated; by W3.
- Bodies: `restartAnnotationPatch(now)` (seconds, UTC),
  `reloadAnnotationPatch(now)` (six digits, UTC), `primaryRestartPatch`
  (phase, reason, resource version, no conditions).

### Dialogs

- Restart of the cluster: subject and context, the plan as a numbered
  sequence, the one write. Warning when a rollout is already running (the
  phase is quoted): the new value restarts the pods that were already
  done. Typed name (W5).
- Restart of a standby: the write is `delete Pod`; the note says the
  operator recreates it on the same volumes. Warning when synchronous
  replication is set, `dataDurability` is not `preferred` and this standby
  is needed to reach `number`: writes wait until it is back. One click.
- Restart of the primary in place: the write is the status patch; the note
  says PostgreSQL restarts inside the same pod, connections drop, no
  switchover happens. Typed name (W5).
- Reload: the write, and one honest note: the operator and the instance
  managers reconcile now, PostgreSQL reloads if its configuration changed,
  and nothing reports completion; ConfigMaps and Secrets labelled
  `cnpg.io/reload` are already reloaded without this. One click.

### After

Restart: "Restart of `<cluster>` requested" with the door to the Timeline;
the drawer shows the phases as the operator writes them. Reload: "Reload of
`<cluster>` requested". No spinner waits for a signal that does not exist.

### Safety

A pod is deleted only after its labels say it is an instance of this
cluster: a name alone is never trusted. The status write carries two
constants. The annotation values are timestamps the extension formats
itself.

## Tests (non-regression list)

- Unit: `restart-reload.test.ts`: every guard reason; the plan for a single
  instance, for each `primaryUpdateMethod`, for `supervised`, with a fenced
  standby, with the primary fenced; the synchronous warning on and off; the
  three bodies (formats, UTC, no conditions, resource version); the foreign
  pod of the same name refused.
- E2E, on `e2e-actions`: Reload, and `kubectl` reads a `cnpg.io/reloadedAt`
  later than the start of the case; restart of the standby from its row, and
  the pod comes back with a new UID and the cluster returns to two ready
  instances; restart of the primary in place, and the pod keeps its UID while
  `pg_postmaster_start_time()` moves and the phase reason reads "Primary
  instance restarted in-place"; Restart of the cluster, and `kubectl` reads
  the annotation on the cluster and then on both pods, with the cluster
  healthy again within the timeout.
- Pre-review: the four dialogs on both themes.

## Notes and deviations

- Approved on 2026-09-20 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M6 at the
  milestone review.
- Implemented on 2026-09-21.
- The E2E case of the primary restarted in place does not assert the phase
  reason "Primary instance restarted in-place": the instance manager writes
  it and the operator clears it at its next reconciliation, a few seconds
  later (observed on 1.30.0). The case asserts what stays: the same pod UID,
  the same restart count of the `postgres` container, and a
  `pg_postmaster_start_time()` that moved.
- The restart annotation is written in UTC (`...Z`). The upstream tooling
  writes the client's local zone; the operator compares the value with the
  pods' copy as a string, so only a difference matters, and UTC keeps the
  value independent of the machine Freelens runs on.
- `primaryRestartPatch` is `primaryRestartBody` of the status subresource
  module of SPEC-0020 (W7), with its unit cases there. The write goes through
  `writeWithConflictRetry` (SPEC-0022); when the object changed under it the
  action reports that nothing was written instead of reopening: its dialog
  has no choice to make again.
- The guard of a cluster restart does not refuse a rollout that is already
  running: the dialog warns that the new value restarts again what was already
  done. The guard of a standby does not refuse while the pods are loading;
  the delete itself reads the pod again and checks its labels, and refuses
  with "Nothing was deleted" when they are not the cluster's.
- "Restart" is a column of the Instances table next to "Promote" (SPEC-0022).
  The readers of the host stores the cluster actions share (`liveCluster`,
  `instancePods`, `podsKnown`, `loadPods`) moved to `menus/cluster-live.ts`.
- The synchronous warning of a standby restart counts the other standbys that
  can acknowledge a write right now (ready, healthy, not fenced, labelled as
  instances of this cluster) against `number`.
