# SPEC-0008: Pre-review agent pass and local demo cluster

- **Status:** Implemented
- **Milestone:** `M2` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

Before a human sits down for a milestone review, an agent has already walked
every view of the extension on both themes against a real operator, checked
the rules of DESIGN.md that a machine can check, compared what the views say
with what the instances say, and written a report with the screenshots and
the list of what is left to human judgment. And the human has a cluster to
look at whose databases are doing something: `pnpm demo:up`.

## Upstream reference

None: this is the tooling of the process (PROCESS.md, "Milestone manual
review gate"; TESTING.md, layer 4 and "Domain correctness checks"). The demo
load uses `pgbench`, which ships with PostgreSQL.

## Scope

Included: `pnpm demo:up` and `pnpm demo:down` (a kind cluster of its own with
the E2E fixtures plus a small, continuous `pgbench` load on the three
instance cluster); `pnpm pre-review` (brings the demo cluster up, runs the
pass, writes the report); the pass itself as a suite of its own
(`e2e/__tests__/pre-review.tests.ts`); `docs/development/TRY-IT.md`.

Excluded: running the pass in CI (it graduates its checks into the E2E suite
instead, TESTING.md layer 4), any hosted demo, load profiles beyond the one
that makes the live view move.

## Design

### Standard or ad hoc view, and why

Not a view: tooling. It looks at every view the milestones introduced.

### Demo cluster

- Same scripts as the E2E cluster with a name and a state folder of their
  own (`cnpg-demo`, `.demo/`), so a developer can keep both; on a small
  machine the pass can point at the E2E cluster instead
  (`DEMO_CLUSTER_NAME=cnpg-e2e DEMO_STATE_DIR=.e2e pnpm pre-review`).
- `e2e/fixtures/demo/70-pgbench.yaml`, applied by `demo-up.sh` only: a Job
  that initializes the `pgbench` tables in the `app` database of `e2e-main`
  and a Deployment that runs a rate limited `pgbench` against the read-write
  service, forever. The workload reads the application secret the operator
  generated, through `secretKeyRef`, inside the cluster: the extension never
  sees it. The image is the PostgreSQL image the fixture cluster runs, so
  nothing else is pulled.
- `demo-down.sh` deletes the cluster and its state folder.

### The pass (`e2e/__tests__/pre-review.tests.ts`)

For each theme, dark then light:

1. Every page (Overview, PostgreSQL Clusters, Live View of `e2e-main`,
   Backups, Scheduled Backups) and every drawer (Cluster, Backup, Scheduled
   Backup): a screenshot named `<theme>-<view>.png`.
2. The statically checkable rules of DESIGN.md, asserted on the DOM:
   - list pages are the host's list layout and follow the column grammar
     (`Name`, `Namespace`, then the domain columns, `Condition`, `Status`,
     `Age`);
   - no empty cell in a list row: a missing value reads "N/A";
   - no link nested in a link;
   - no authored color: inside the extension's own subtrees no inline
     `style` carries a color, a background or a border color (positions and
     sizes are what inline styles are allowed for);
   - the live view declares its two intervals and offers pause and refresh
     as buttons reachable from the keyboard;
   - no console error and no failed request during the walk.
3. Domain correctness (TESTING.md): the LSN the live view shows for the
   primary lies between the `currentLsn` the instance manager answers before
   and after the page is read (the position only grows); the current WAL
   file equals one of the two answers; the primary the view draws is the one
   `Cluster.status` names; the last successful backup of the Cluster drawer
   is the latest `stoppedAt` among the completed `Backup` objects read with
   `kubectl`.

The pass writes `e2e-artifacts/pre-review/REPORT.md`: date, versions, the
checks with their outcome, the screenshots, and the fixed list "for human
judgment" (density on a laptop screen, whether the strip tells the
protection story, the topology with many standbys, psql on Windows and
Linux desktops, the permission panel with a kubeconfig without
`pods/proxy`, the live view against a busy database for ten minutes).

### Non-happy states

A pass that cannot start (no Freelens build, no Docker) says which
prerequisite is missing, as the E2E runner does. A failed check fails the
pass and is in the report with what was expected and what was found.

### Safety

The demo load writes only to the `pgbench_*` tables of the `app` database of
a disposable cluster. The pass is read-only.

## Tests (non-regression list)

- The pass is itself a test suite; its codifiable checks graduate into
  `cnpg-e2e.tests.ts` (this spec moves the column grammar, the nested link
  and the LSN sandwich checks there).
- Manual verification: the lead maintainer follows TRY-IT.md once on a
  clean machine during the M2 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M2 at the
  milestone review.
- Implementation notes: `pre-review.sh` is the E2E runner with the demo
  cluster, a suite pattern and an artifacts folder of its own, so the two
  never drift. The checks live in `integration/helpers/cnpg-design-checks.ts`
  and are shared by the pass and by the E2E suite, where the column grammar,
  the empty cell, the nested link, the authored color and the LSN sandwich
  checks now run on every pull request.
- What the first runs of the pass taught: every view follows the namespace
  filter, so the pass selects the fixtures' namespace before it walks; the
  host draws the sort arrow of a list header as an icon font ligature, which
  is text to the DOM, so the headers are read without their icons; the host
  select styles its own input inline (`color: inherit`), so the authored
  color check leaves host components alone and accepts the values that author
  nothing.
- The first attempt of the load may lose the race with the init job; the
  loop retries after ten seconds instead of crash looping (observed once).
- First pass on 2026-09-19 (E2E cluster with the demo load, operator 1.30.0):
  22 checks passed, 20 screenshots on the two themes, the LSN sandwich held
  under the `pgbench` load.
