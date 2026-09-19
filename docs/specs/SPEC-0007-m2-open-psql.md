# SPEC-0007: Open psql in a Freelens terminal tab

- **Status:** Verified
- **Milestone:** `M2` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

From a PostgreSQL cluster, one click opens a `psql` session on its primary,
or on the instance the user points at, in a terminal tab of Freelens: the
same session `kubectl cnpg psql` gives, without leaving the application and
without the extension ever touching a credential.

## Upstream reference

- `kubectl cnpg psql <cluster> [--replica]` as recorded in SPEC-0001 R7: it
  runs `kubectl exec -t -i -n <ns> -c postgres <pod> -- psql -U postgres`;
  the container environment points `psql` at the local socket, where peer
  authentication makes the `postgres` operating system user the `postgres`
  superuser. The plugin picks the pod by its role label.
- Architecture decision A6 of SPEC-0001 and DESIGN.md section 13 (the psql
  terminal is not a write action of the extension: no API call, no
  confirmation dialog, a tooltip that states the superuser connection).

## Scope

Included: the pure target, guard and command modules with their tests; the
"Open psql" entry in the menu of a Cluster (row menu of the list and toolbar
of the drawer), on the primary; a psql button on every instance of the
Instances table of the Cluster drawer and of the Live View topology, so a
standby can be chosen by name; the README paragraph that states what the
session is.

Excluded: running SQL from the extension (never, AGENTS.md safety rules),
passing extra `psql` arguments or a database name (the user types `\c`),
sessions as an application user (that needs a secret: out of scope by A2),
pooler sessions (M3).

## Design

### Standard or ad hoc view, and why

Neither: this is an action that hands over to the host's terminal, the
right tool for an interactive shell. It appears where the user already is
(the list, the drawer, the live view) instead of on a page of its own.

### Target (`src/renderer/components/psql.ts`, pure)

- `psqlTarget(cluster facts, instance?)`: the named instance when given,
  else `status.currentPrimary`, else the instance the health model calls
  primary. The pod is never guessed from a name pattern.
- `canOpenPsql(cluster facts, target)`: enabled, or disabled with the reason
  shown in the tooltip and re-evaluated on the click against the live
  object (the host's `disabled` is styling, not a guard):
  - hibernated: "The cluster is hibernated: there is no instance to connect
    to";
  - no target: "The cluster status names no primary yet";
  - fenced target: "The instance is fenced: PostgreSQL is stopped on it";
  - a namespace or a pod name that is not a DNS-1123 name: refused (it
    cannot come from the API server; the check is what makes the quoting
    below trivially safe on every shell).

### Command (pure)

`kubectl exec -i -t -n '<namespace>' '<pod>' -c postgres -- psql -U postgres`,
with the host's configured `kubectl` path when there is one. No `--context`
and no kubeconfig: the host's terminal session already carries the proxy
kubeconfig of the cluster the frame belongs to. Every interpolated value is
validated first and single-quoted; nothing else is interpolated. The
command is not prefixed with `exec`: leaving `psql` gives the shell back,
it does not close the tab.

### Surfaces

- Menu entry "Open psql" on the Cluster kind (icon `terminal`): the row menu
  of the list and the drawer toolbar. Tooltip when enabled: "Opens psql on
  the primary `<pod>` as the postgres superuser, through kubectl exec with
  your own credentials (needs pods/exec)". When disabled: the reason.
- Instances table of the Cluster drawer and instance cards of the Live View:
  a small terminal icon button per instance, same tooltip with the role
  ("on the standby `<pod>`: a read-only session"), hidden for an instance
  the guard refuses, with the reason as its tooltip instead.
- The tab: title `psql: <pod>`, id `cnpg-psql-<namespace>-<pod>`, created with
  the host's `createTerminalTab`, the command sent with
  `terminalStore.sendCommand(..., { enter: true })`. The only failure that
  is the extension's own (the tab or the send failing) is a notification;
  everything after that (a missing `pods/exec`, a pod that went away) is
  `kubectl`'s own words in the user's terminal.

### Non-happy states

Covered by the guard above; the entry is never a silent absence.

### Themes

Host components only (`MenuItem`, `Icon`): nothing to theme.

### Safety

The extension issues no API call and reads no secret: it composes one
command line from two validated names and hands it to the user's terminal,
where it runs under the user's own kubeconfig and RBAC. The session is a
superuser session: the tooltip and the README say so in plain words. No SQL
is ever composed, sent or stored by the extension.

## Tests (non-regression list)

- Unit: `psql.test.ts`: target precedence (named instance, current primary,
  health model), every guard reason, DNS-1123 validation (uppercase, quote,
  space, semicolon, empty, too long), the command with and without a
  configured kubectl path, the tab id and title.
- Integration: the scaffold's activation case, unchanged.
- E2E (appended to `cnpg-e2e.tests.ts`): "Open psql" from the row menu of
  `e2e-main` opens a dock tab titled with the primary pod and the terminal
  reaches the `postgres=#` prompt; `select pg_is_in_recovery();` typed in it
  answers `f`; the psql button of a standby in the drawer opens a second tab
  whose same query answers `t`; the entry of `e2e-hibernated` is disabled
  with its reason.
- Manual verification: Windows and Linux desktops (the E2E runs on macOS
  locally and on Linux in CI), during the M2 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M2 at the
  milestone review.
- Implementation notes: the entry and the buttons live in
  `src/renderer/menus/open-psql.tsx` over the pure `components/psql.ts`. The
  psql button of the live view is handed to the topology by the page, so the
  topology stays a component of the model alone. The command quotes the
  configured kubectl path as well. On the E2E cluster the primary answers
  `pg_is_in_recovery()` with false and a standby with true, which is what the
  case asserts; the drawer covers the dock, so the case closes it before
  typing into the terminal.
- The host numbers a new terminal tab when the dock already holds its own
  "Terminal" tab (the title reads `psql: <pod> (2)` on a fresh dock): that is
  the host's naming, left alone.
- Merged with #21 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `42d7b7d`. The manual verification above is part of the M2
  milestone review: the status moves to Verified when its result is recorded
  here.
- M2 milestone review: 2026-09-19, lead maintainer, on the screenshots of the
  pre-review pass and of the E2E suite on both themes (gallery on an ephemeral
  branch, deleted after the review). Verdict: approved, no blocking finding.
  Status moved to Verified. Still open for a later look, as the pre-review
  report lists: the psql terminal on Windows and Linux desktops, the live view
  with a kubeconfig without `pods/proxy`, the live view against a busy
  database for ten minutes.
