# SPEC-0037: Pooler pause and resume, maintenance window, destroy an instance

- **Status:** Done
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

- **No "keep the volumes" on destroy.** On CloudNativePG 1.30 the operator gives a new instance the first
  free serial (`generateNodeSerial`), so the destroyed instance comes back under the same name, and needs
  a volume of the same name. A kept volume (detached as `kubectl cnpg destroy --keep-pvc` does: owner
  reference dropped, `cnpg.io/pvcStatus: detached`) is that volume: the operator binds the new instance to
  it, runs its join job and never marks it ready, and the cluster stays in "Creating a new replica" until
  the kept volume is deleted (and the completed join pod that holds it). Reproduced on the lab with the
  extension and with the official plugin `kubectl-cnpg` 1.30.1 itself. Destroy therefore always deletes
  the volumes of the instance (and one detached from it earlier, as the plugin does). Worth an upstream
  issue; not opened.
- **Destroy, as the plugin does.** Volumes found by `cnpg.io/instanceName` with a role `PG_DATA`,
  `PG_WAL` or `PG_TABLESPACE`, owned by the cluster; then the pod, refused when the cluster does not own
  it; then the jobs of the instance (background propagation). Everything is read again right before the
  writes; a plan that changed is not sent. A failure stops the sequence and says which writes were sent.
  Refused on the current or the target primary, during a switchover or failover, and while a backup runs
  on that instance. The dialog says the instance comes back under the first free name.
- **Maintenance window.** Opening sends both settings (`inProgress: true`, `reusePVC` as chosen, on by
  default as the API's own default; the plugin's `--reusePVC` flag defaults to off); closing sends
  `inProgress: false` only and keeps the choice. The texts follow the upstream documentation of 1.30
  ("Kubernetes upgrade and maintenance"), including its advice to prefer `spec.enablePDB`. The Overview
  tile shows "maintenance window open"; the drawer row closes it.
- **Pooler pause.** The pause dialog reads the clients connected right now from the exporter of the
  pooler's pods while it is open. The drawer row shows the declared value against `status.phase`
  (pausing and resuming while the operator has not reported yet). A pause does not roll the pods
  (checked on the lab). The E2E creates its own pooler in `cnpg-e2e-actions` (the pooler of `e2e-main`
  is a read-only fixture) and deletes it.
- **Pooler drawer (SPEC-0012), fixed on the way.** Its live figures polled the pods the session held
  before reloading them: a pod deleted while nothing watched the namespace got one round of 404s. The
  first round now waits for a fresh list of the namespace's pods.
- **E2E fixture names.** The pre-review case derived the standby of `e2e-actions` as "-1 or -2"; it now
  reads `status.instanceNames`, since a destroyed instance may come back under any free name.
