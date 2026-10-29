# SPEC-0033: Live view: wraparound, extension updates, checkpoints and the lag of every standby

- **Status:** Done
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

The live view answers three more questions of an incident: is a database near wraparound or behind
on its extensions, is an instance checkpointing too often, and where does a standby fall behind
(write, flush or replay).

## Upstream reference

Default exporter queries of v1.30.1, read on port 9187 through the pod proxy as SPEC-0006 does:
`cnpg_pg_database_mxid_age`, `cnpg_pg_database_xid_age`, `cnpg_pg_extensions_update_available`,
`cnpg_pg_stat_checkpointer_checkpoints_timed`, `_checkpoints_req`, `_buffers_written`,
`_write_time`, `_sync_time`, `_restartpoints_timed`, `_restartpoints_req`, `_restartpoints_done`,
`cnpg_pg_stat_replication_write_lag_seconds`, `_flush_lag_seconds`, `_replay_lag_seconds` and the
`_diff_bytes` counterparts per `application_name`. Checked on the kind cluster.

## Scope

Included: the database tile, a checkpoints tile per instance, the replication tile with three lags
per standby. Excluded: custom monitoring queries, alerting.

## Design

### Standard or ad hoc view, and why

Additions to the ad hoc live view of SPEC-0006 and SPEC-0028, in its tiles and trends.

- Databases: next to the XID age, the multixact age, with the same levels (warning and danger
  thresholds as fractions of `autovacuum_multixact_freeze_max_age` and of the 2^31 limit, worded);
  "Extension updates available: <n>" per database, listed by name on hover.
- Checkpoints: per instance, timed and requested since the statistics reset, the share requested
  (a high share means `max_wal_size` is small for the load), buffers written, write and sync time;
  on a standby the restartpoints. A trend of requested checkpoints per minute.
- Replication: per standby, write, flush and replay lag in time and bytes, the worst one first; a
  standby with no row in `pg_stat_replication` is shown as not streaming.
- Missing metrics (a custom exporter configuration without these queries): the figure says
  "not collected" and why, never zero.

### Safety

Reads only, as SPEC-0006.

## Tests (non-regression list)

- Unit: the parsing of the new families from a recorded `/metrics` of the kind cluster; the levels;
  missing families.
- E2E: on `e2e-main`, the live view shows the multixact age, the checkpoints of each instance and
  three lags for each standby.

## Notes and deviations

- Implemented on 2026-10-29 with the port to Freelens v2 (SPEC-0030), in `live-model.ts` and `tiles.tsx`.
- **Multixact age levels.** Autovacuum forces a freeze at `autovacuum_multixact_freeze_max_age`
  (400 million by default, read from the primary's exporter). The warning is at twice that, capped at the
  warning of the XID age (1 billion), since by then autovacuum is not keeping up. The error is at
  1.5 billion, as for transaction IDs, since both wrap around at 2^31. The thresholds are worded in the
  tooltip of each figure.
- **Checkpoints.** The share of requested checkpoints warns at 50 % once an instance counts at least 10,
  on the primary only. An instance in recovery (a standby, or the designated primary of a replica
  cluster, SPEC-0034) shows its restartpoints. PostgreSQL 16 and older report checkpoints in
  `pg_stat_bgwriter`, which is read when `pg_stat_checkpointer` is absent. "A trend of requested
  checkpoints per minute" was already in the trends of SPEC-0028 (timed and requested per interval),
  so no second chart was added.
- **Lag in bytes.** The write, flush and replay distances come from the LSNs the primary reports in
  `/pg/status` (`writeLsn`, `flushLsn`, `replayLsn` against `currentLsn`), as the replay distance of
  SPEC-0006 already did, rather than from the `_diff_bytes` metrics. They refresh every 5 s instead of
  every 30 s, and need no metrics. `pg_stat_replication` also lists the logical subscriptions (the
  fixtures have `e2e_numbers_sub`); only the instances of the cluster are standbys.
- **Not collected.** A family the exporter does not read says "not collected" with the reason. Its
  absence is judged on the primary's metrics as a whole, so one missing database never reads as zero.
