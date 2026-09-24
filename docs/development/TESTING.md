# Testing strategy

Every feature ships with tests at every layer that applies. A feature
without its non-regression tests is not done (see
[PROCESS.md](PROCESS.md)).

## Layers

### 1. Unit tests (vitest, `pnpm test:unit`)

- Every CRD model: construction from a realistic fixture object, helpers
  (phase, refs, derived values), edge cases (empty refs, missing status).
- Every pure module: status classifiers, the health model (cluster health
  from phase, conditions, instances and backups), the parsers the
  CloudNativePG contracts need (the Go `time.String()` layout of
  `status.certificates.expirations`, PostgreSQL LSN comparison, the
  interval strings of replication lag), the Prometheus text-format reader,
  the psql command composer and its quoting.
- Every component with logic worth isolating.
- Fixtures are hand-written from the CRD schemas and from objects observed
  on the test cluster, never copied from other projects' code or docs
  verbatim.

### 2. Integration tests (existing harness, `integration/`)

The harness downloads a real Freelens, installs the built extension, and
drives it (`integration/__tests__/extensions.tests.ts`: the extension
installs, is listed as enabled, and activates without errors). Keep it green
on every PR.

Both this suite and the E2E one run **inside a checkout of
`freelensapp/freelens`**: their files are copied next to the Freelens ones,
under `integration/__tests__` and `integration/helpers`, and are run by the
Freelens `test:integration` script, which owns the Playwright/Electron launch
helpers (`../helpers/utils`). That is why relative imports of `../helpers/*`
resolve when the tests run but not inside this repository, and why
`integration/` is outside the `tsconfig.json` include list.

### 3. E2E tests (Playwright, against a kind cluster with the real operator)

Unlike extensions for CRDs whose controllers cannot run in a laptop
cluster, CloudNativePG runs fine in `kind`: the E2E cluster carries the
**real operator at the pinned version**, real PostgreSQL instances, the
Barman Cloud plugin with an in-cluster object store, and real backups. The
suite therefore asserts against statuses the operator wrote, not against
injected ones. Static status fixtures (`kubectl patch --subresource=status`)
are used only for states the operator cannot produce on demand in a test
run (an unrecoverable cluster, a WAL archiving failure, an expired
certificate), and every such fixture says so in a comment.

#### Prerequisites

- A running Docker daemon, plus `kind` and `kubectl` on `PATH`.
- A checkout of `freelensapp/freelens` in `./freelens` (gitignored), with the
  app already built (`pnpm build` and the electron-builder step, as in
  `.github/workflows/e2e-tests.yaml`). Point `FREELENS_DIR` elsewhere to use
  another checkout.

#### Commands

| Command | What it does |
| --- | --- |
| `pnpm e2e:cluster:up` | Creates the cluster, installs the CSI hostpath driver with the snapshot controller, cert-manager, the operator, the Barman Cloud plugin and the object store, applies the fixture clusters (one of them on the CSI storage class, with a cold volume snapshot backup) and waits for them to be ready |
| `pnpm e2e:cluster:down` | Deletes the cluster and its kubeconfig |
| `pnpm e2e` | Cluster up, run the suite, cluster down |

`E2E_KEEP_CLUSTER=1 pnpm e2e` leaves the cluster running for inspection.
`pnpm e2e:cluster:up` is idempotent, so it doubles as "re-apply the fixtures".

#### Layout

- `e2e/scripts/` - cluster lifecycle. `lib.sh` is the single place where
  the CloudNativePG, plugin, cert-manager, kind and Kubernetes versions,
  the cluster name and the kubeconfig path are pinned.
- `e2e/fixtures/` - hand-written resources in numbered files applied
  together: the object store, a three-instance cluster, a single-instance
  cluster, a hibernated cluster, a cluster with a fenced instance, backups
  (one completed, one failed), three scheduled backups (nightly, immediate
  with the backup it generates, suspended), a pooler, a namespaced and a
  cluster scoped image catalog (the hibernated cluster follows the first),
  and, applied after the hibernation, the declarative databases, roles,
  publications and subscriptions with one object per state (applied,
  failed with each kind of reason, waiting for a primary, without its
  cluster), including a logical replication that really runs from the
  three-instance cluster to the single-instance one.
  `35-actions.yaml` is apart from all of that: a namespace of its own with a
  two-instance cluster, its object store and a weekly schedule, which
  receives every write of the suite (SPEC-0020), so no write case can change
  what a read-only case asserts. The write cases run last, read every result
  back with `kubectl`, and the pre-review pass opens every dialog and closes
  it without confirming.
  `fixtures/status/` holds the few status patches for states the operator
  cannot produce on demand. Each fixture is chosen to cover a state its
  views distinguish, so the suite can assert both branches.
- `e2e/__tests__/cnpg-e2e.tests.ts` - the suite: it installs the packed
  extension, connects the cluster, points the namespace filter at the
  fixture namespace, then opens every page and asserts the fixture rows,
  one detail panel per kind, the overview tiles and the live view panels.

The details of this layer are specified in SPEC-0002 and evolve with it.

#### What the suite never touches

- The developer's `~/.kube/config`: `kind` writes to a dedicated kubeconfig
  under `.e2e/`, and the suite copies it into the sandboxed Freelens user
  data directory (`<FREELENS_INTEGRATION_TESTING_DIR>/Freelens/kubeconfigs`),
  which Freelens always watches.
- The Freelens checkout's own tests: our files are copied in under their own
  names and selected by name when the runner starts.
- Any cluster other than the disposable one it created.

Runs in CI on every PR through `.github/workflows/e2e-tests.yaml` once
SPEC-0002 lands.

### 4. Agent-driven testing during development, and the pre-review pass

While developing, coding agents must verify their UI changes live, not just
by compiling: launch Freelens with the extension and the kind cluster, then
drive it with Playwright to inspect the rendered pages (assert the list
shows the fixture clusters, open the detail panel, read the live view,
screenshot for the PR). Findings go into the PR description.

Before every human milestone review session, the same machinery runs as the
**pre-review agent pass** (`pnpm pre-review`, SPEC-0008): every view and
every drawer, both themes, screenshots plus DOM asserts of the statically
checkable [DESIGN.md](DESIGN.md) rules, with a report handed to the
reviewer. The human session covers only judgment calls and what cannot be
automated.

Nothing is verified only once: every check of the pass that can be
codified graduates into the E2E suite (layer 3) as a permanent
non-regression test. Exploratory verification is allowed to stay
exploratory only until it stabilizes.

## Domain correctness checks

The audience of this extension knows CloudNativePG well, so the suite also
compares what the extension shows with what the official tooling reports on
the same cluster:

- `kubectl cnpg status <cluster>` output versus the cluster drawer and the
  overview tile (phase, primary, instances, WAL archiving, certificates,
  streaming replication status).
- The `/pg/status` JSON and the `/metrics` text of an instance versus the
  live view panels (same numbers, same units).

These comparisons are E2E cases, not manual steps, from SPEC-0006 on. The
first ones (the primary the live view draws, the LSN of the primary between
two answers of the instance manager, the last successful backup of the drawer
against the `Backup` objects) came with SPEC-0006 and SPEC-0008; the
comparison with the output of `kubectl cnpg status` follows when the plugin
is part of the runner.

## Non-regression policy

- Each spec lists its regression tests by name (test file + case).
- CI runs all layers on every PR; a red layer blocks merge.
- When a bug is found (by CI, manual testing, or in the field), the fix PR
  must add a test that fails without the fix. No silent fixes.
- A test weakened to tolerate an unexplained difference (a platform, a
  timing, a runner) carries that tolerance only until the difference is
  explained. Once the cause is found and fixed, the tolerance is removed in
  the follow-up, or the weakened assert silently becomes the contract.

## Manual testing

What cannot be automated is escalated to the lead maintainer following the
protocol in [PROCESS.md](PROCESS.md) ("Manual testing escalation"), and its
outcome is recorded in the spec. Current known manual-only areas: the psql
terminal on every desktop platform, the live view against a busy
production-like database, a real switchover or failover, and the overall
look and feel inside a real Freelens on Windows, Linux and macOS (agents
verify rendering via Playwright screenshots, not the lived experience).

In addition to ad-hoc escalations, every milestone ends with a structured
manual review session in a real Freelens: see "Milestone manual review
gate" in [PROCESS.md](PROCESS.md).
