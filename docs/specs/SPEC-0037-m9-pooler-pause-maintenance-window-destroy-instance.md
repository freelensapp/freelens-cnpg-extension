# SPEC-0037: Pooler pause and resume, maintenance window, destroy an instance

- **Status:** Approved
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

Three operations of `kubectl cnpg` and of the Pooler's spec become actions with their consequences
listed: pause and resume a pooler, open and close the maintenance window of a cluster's nodes, and
destroy a broken replica so that the operator recreates it.

## Upstream reference

- Pooler: `spec.pgbouncer.paused` (PgBouncer `PAUSE`/`RESUME`); `status.phase` (v1.30) `paused`.
- Maintenance window: `Cluster.spec.nodeMaintenanceWindow` `{ inProgress, reusePVC }`;
  `kubectl cnpg maintenance set|unset [--reusePVC]` merge-patches it. `reusePVC` decides whether an
  instance on a drained node waits for the node and its volume, or is recreated elsewhere on a new
  volume (with more than one instance). What the operator does during the window is taken from the
  upstream documentation of the reviewed release when the dialog is written.
- Destroy (`internal/cmd/plugin/destroy/destroy.go`): deletes the PVCs of the instance (or, with
  `--keep-pvc`, detaches them by removing the cluster's labels and owner), then the pod, then the jobs
  labelled with the instance; the operator then creates a new instance.

## Scope

Included: "Pause pooler" and "Resume pooler" on the Pooler; "Open maintenance window" and "Close
maintenance window" on the Cluster, with its state in the drawer and the Overview; "Destroy instance"
on the row of an instance in the cluster drawer. Excluded: the maintenance window of all clusters at
once (`--all-namespaces`), destroying a primary.

## Design

All three follow SPEC-0020 (W1 to W12): the dialog names the CloudNativePG object and the Kubernetes
context and lists every write; access review first; no optimistic UI; the result read back.

- **Pooler pause/resume:** merge patch of `spec.pgbouncer.paused` with its explicit value. The dialog
  says that clients stay connected and wait, how many are connected now (live figures of SPEC-0012),
  and that a paused pooler stays paused until resumed. The pooler's state in lists and drawer follows
  `status.phase`.
- **Maintenance window:** merge patch of `spec.nodeMaintenanceWindow`, "reuse the volumes" a choice
  defaulting to on. The dialog states what the operator does with an instance on a drained node, for the
  choice made. The drawer and the Overview show "Maintenance
  window open" with the choice, and the action to close it.
- **Destroy instance:** offered on a replica only, never on `status.currentPrimary` or the target
  primary; typed confirmation of the instance name; a choice "keep the volumes" (default off). Writes,
  in this order and listed: the PVCs (delete, or remove the cluster's labels and owner reference when
  kept), the pod, the jobs of the instance. Refused while a switchover or a backup on that instance is
  in progress. Read back: the pod and PVCs are gone, a new instance appears.

### Safety

Destroy is the most destructive action of the extension: replica only, typed name, the writes listed,
the consequences (data on the instance's volumes lost unless kept; a full copy from the primary
follows) stated. AGENTS.md "Safety rules" lists the maintenance window already; destroy is added there.

## Tests (non-regression list)

- Unit: the patch bodies; the destroy plan (writes, order, refusals) for primary, replica, kept volumes.
- E2E (cluster `e2e-actions`, pooler of `e2e-main`): pause then resume the pooler, read back
  `spec.pgbouncer.paused` and the phase; open and close the maintenance window, read back the spec;
  destroy the replica of `e2e-actions`, then the operator recreates it and the cluster returns to
  healthy; the action is absent on the primary.

## Notes and deviations

Filled during implementation.
