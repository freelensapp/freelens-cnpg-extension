# SPEC-0022: Switchover, with the candidates in front of the user

- **Status:** Implemented
- **Milestone:** `M6` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-20

## Goal

The user moves the primary of a cluster to a standby of their choice, and
chooses it knowing what each standby looks like right now: ready or not, how
far behind, synchronous or not, on which node.

## Upstream reference

- `kubectl cnpg promote <cluster> <instance>` (v1.30.0): a merge patch with
  the resource version on the status subresource of the `Cluster`, setting
  `status.targetPrimary`, `status.targetPrimaryTimestamp` (RFC 3339 with six
  fractional digits), `status.phase` to "Switchover in progress" and
  `status.phaseReason` to "Switching over to `<instance>`". It checks that
  the cluster exists, that the instance is not the target already and that a
  pod of that name exists. It does not check that the pod belongs to the
  cluster, that it is ready, that the cluster is healthy or that nothing is
  already in flight, and the admission webhooks do not see the status
  subresource: every guard is the client's.
- What follows: the old primary shuts PostgreSQL down (fast, then immediate
  after `.spec.switchoverDelay`) and comes back as a standby; the target
  waits for its WAL receiver to stop, promotes and writes
  `status.currentPrimary`; the operator then brings the phase back to
  healthy. Completion is `currentPrimary == targetPrimary == <instance>`
  with the healthy phase.
- A cluster whose primary update is `supervised` stops a rolling update at
  "Waiting for user action": this same write is the documented way to
  continue.
- On a replica cluster the same write only moves the designated primary;
  promoting a replica cluster is a change of `.spec.replica` (never written,
  SPEC-0020 W10 and W11).
- Needs `patch` on `clusters/status`, which an account with edit rights on
  `clusters` does not necessarily have.

## Scope

Included: "Switchover" on a `Cluster`; "Promote" on the row of a standby in
the Instances table of the drawer, which opens the same dialog with that
standby chosen; the candidates table of the dialog; the write through the
status subresource module of SPEC-0020.

Excluded: replica clusters (disabled with the reason, W11); a progress view
of its own (the drawer already shows the target primary and the phase, the
Timeline the sequence, SPEC-0003 and SPEC-0017).

## Design

### Standard or ad hoc view, and why

The dialog is ad hoc: choosing the new primary is the whole task, and a
name in a select hides what matters. The candidates are a small table.

### Pure module (`src/renderer/components/switchover.ts`)

- `canSwitchover(cluster facts)`: disabled, with the reason, when the
  cluster follows another one (W11); when it is hibernated; when it declares
  fewer than two instances ("There is no standby to promote"); when
  `currentPrimary` differs from `targetPrimary` ("A switchover or a failover
  is already in flight, to `<target>`"); when the phase is neither the
  healthy one nor "Waiting for user action" (the phase is quoted); when no
  candidate is eligible; by W3 on `clusters/status`.
- `switchoverCandidates(cluster, pods, fenced, replication)`: one row per
  instance other than the primary. Eligible when it is in
  `status.instancesStatus.healthy`, its pod exists with the labels
  `cnpg.io/cluster` of this cluster and `cnpg.io/podRole: instance`, it is
  not fenced and its pod is ready. An ineligible row stays visible, disabled,
  with its reason.
- Lag per candidate, from the replication rows the primary reports through
  its status endpoint (SPEC-0006, already read by the live view): replay lag
  in bytes against the primary's current LSN, the state, the sync state.
  When the endpoint cannot be read the column says so and the action stays
  available: the lag informs the choice, it does not gate it.
- The preselected candidate is the eligible one with the least replay lag,
  a synchronous one first; from "Promote" on a row it is that row.
- `switchoverPatch(cluster, target, now)`: the four status fields and
  `metadata.resourceVersion`; no conditions (SPEC-0020 W7, spike S2).

### The dialog

Subject and context (W4); the candidates table (instance, state, sync,
replay lag, node, a radio); the one write, spelled as the four fields; then:

- Note: what happens, in order, with this cluster's own
  `.spec.switchoverDelay`: the primary `<current>` is shut down first, then
  `<target>` is promoted; clients of the read-write service are disconnected
  and reconnect to the new primary.
- Note, when the phase is "Waiting for user action": this switchover is what
  the supervised rolling update is waiting for.
- Warning, when the chosen candidate is behind by more than one WAL segment
  (16 MiB): it has that much to replay before it can be promoted, and writes
  wait for it.
- Warning, when `.spec.postgresql.synchronous` is set with a
  `dataDurability` other than `preferred` and, while the old primary comes
  back, the cluster is left with fewer ready standbys than its `number`:
  writes wait for a standby during that time.
- Typed name (W5). The candidates refresh every five seconds while the
  dialog is open; choosing a row that has just become ineligible disables OK
  with the reason.

### After

"Switchover of `<cluster>` to `<target>` requested", with a door to the
Timeline of the cluster. The drawer shows "Target primary" and the phase as
the operator writes them. `409` follows W6: the operator writes the status
often, so a retry is the normal case and a changed candidate list reopens
the dialog.

### Safety

One write, to the status subresource, of four fields whose values are
constants or validated names. The instance name always comes from the
cluster's own status and is checked against a pod that carries the cluster's
labels, which the upstream tooling does not do.

## Tests (non-regression list)

- Unit: `switchover.test.ts`: every guard reason; eligibility for each
  failing condition (unhealthy, fenced, foreign pod of the same name, pod not
  ready, the primary itself); lag from LSN pairs including a candidate ahead
  of the last report and an unreadable endpoint; the preselection order; the
  body of the patch (six fractional digits, UTC, no conditions, resource
  version); both warnings on and off; the supervised note.
- E2E, on `e2e-actions`: "Switchover" from the row menu: the dialog lists the
  standby with a lag and a state, OK stays disabled until the name is typed;
  after OK `kubectl` reads the requested `targetPrimary`, and within the
  timeout `currentPrimary` equal to it with the healthy phase; "Promote" on
  the row of the new standby opens the dialog with that row chosen (closed
  without writing); the entry of `e2e-single` is disabled with "There is no
  standby to promote".
- Pre-review: the dialog on both themes, with the typed name empty and
  filled.
- Manual verification: a switchover under write load on the demo cluster,
  during the M6 milestone review.

## Notes and deviations

- Approved on 2026-09-20 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M6 at the
  milestone review.
- Implemented on 2026-09-21.
- `switchoverPatch` is not in the pure module: the body is `switchoverBody`
  of the status subresource module of SPEC-0020 (W7), which is the only place
  allowed to express it and where its unit cases already are (six fractional
  digits, UTC, no conditions, resource version).
- W6 became one function, `writeWithConflictRetry` in `write-actions.ts`, with
  its own unit cases: it sends, and on `409` reads the object again, runs the
  guard again and compares the lines with the ones the user confirmed. It is
  what SPEC-0023 and SPEC-0024 use too. The line of this write quotes the
  current primary and the phase, so a status the operator rewrote without
  changing either is retried, and a primary that moved reopens the dialog.
- The guard counts the candidates only once the pod of the primary is in the
  host's pod store: the store's own `isLoaded` says nothing about one
  namespace, and the list of the clusters does not load the pods by itself,
  so the entry asks for them. Until then the entry is offered and the dialog,
  which loads the pods before it opens, decides on facts.
- The dialog opens after one read of the primary (bounded by the five second
  timeout of the pod proxy client), so the proposed standby is the one with
  the least lag from the first frame; afterwards the user's choice is never
  moved by a refresh.
- The shared dialog gained `onClose`, called once whether the dialog is
  confirmed or cancelled: it is where the five second refresh stops.
- The candidates are a plain table with one native radio per row: the host's
  `RadioGroup` takes its radios as direct children and cannot be laid out as
  the rows of a table.
- "Promote" is a column of the Instances table of the drawer, empty on the row
  of the primary. It runs the guard of the action, the eligibility of its own
  row and W3, at render and again on the click.
- The API server defaults `.spec.switchoverDelay` to 3600, so the note always
  quotes a number on a real cluster; the wording without it is for an object
  that has none.
