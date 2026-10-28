# SPEC-0035: PostgreSQL configuration and HBA rules of a cluster

- **Status:** Draft
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

The user reads the PostgreSQL configuration and the HBA rules the primary is running with, as
`kubectl cnpg status -v -v` prints them, and sees whether a change still waits for a restart.

## Upstream reference

- `kubectl cnpg status -v -v` (v1.30.1, `internal/cmd/plugin/status/status.go`) reads them on the
  primary pod with `exec`: `cat` of `custom.conf` and of `pg_hba.conf` in `PGDATA`.
- The instance manager status (`/pg/status`, SPEC-0006) reports `pendingRestart`,
  `pendingRestartForDecrease` and `loadedConfigurationHash` per instance.
- `Cluster.spec.postgresql.parameters` and `spec.postgresql.pg_hba` are what the user asked; the files
  are what the operator wrote, with its fixed parameters.

## Scope

Included: a "PostgreSQL configuration" view per cluster: the parameters the operator wrote, the HBA
rules, and the pending restart of each instance. Excluded: `pg_settings` with sources (a SQL query),
`pg_ident`, editing.

## Design

### Standard or ad hoc view, and why

A page opened from the cluster drawer and menu (like logs and timeline), because the content is long
and read side by side with the spec.

- Two tabs: Configuration (parameter, value, and whether it comes from the spec, from the operator's
  fixed set or from its defaults) and HBA rules (one row per rule, the operator's own rules marked).
- A strip per instance: configuration loaded (hash), restart pending, restart pending for a decrease;
  the restart action of SPEC-0023 one click away.
- A search box; copy of the raw file.

### Main process

- Main runs, with the host's kubectl and the cluster's environment (`Main.Shell`),
  `kubectl exec -n <ns> <primary> -c postgres -- cat <PGDATA>/custom.conf` and the same for
  `pg_hba.conf`: two fixed commands, no argument from the user but the cluster and pod names, which
  main checks against the cluster's `status.currentPrimary` before running.
- The answer goes back to the frame that asked; nothing is cached on disk.
- Access review on `create pods/exec` before the page offers to read; denied, the page says what to
  grant and still shows the spec's parameters and rules.

### Safety

Reads only. `exec` of two fixed `cat` commands (AGENTS.md: fixed strings, no user SQL). The files hold
no password (`pg_hba.conf` names methods, not secrets).

## Tests (non-regression list)

- Unit: parsing of `custom.conf` and `pg_hba.conf` recorded from the kind cluster; the origin of each
  parameter; the command builder refuses a pod that is not the current primary.
- E2E: on `e2e-main`, the page lists `shared_buffers` and the fixture's parameters with their origin,
  and the HBA rules; after a parameter change that needs a restart, the strip shows it pending.

## Notes and deviations

Filled during implementation.
