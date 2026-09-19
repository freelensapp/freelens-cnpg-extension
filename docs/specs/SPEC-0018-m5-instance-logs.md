# SPEC-0018: Instance logs, readable (ad hoc, read-only)

- **Status:** Implemented
- **Milestone:** `M5` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

The logs of a PostgreSQL cluster read as logs: who said it (PostgreSQL, the
instance manager, the WAL archiver, a plugin), how serious it is, the
message, and for PostgreSQL the user, the database and the query, across
every instance of the cluster on one time axis. Today they are one JSON
object per line, which no log viewer makes readable.

## Upstream reference

- "Logging" (v1.30.0): every container of an instance writes JSON lines to
  standard output with `level`, `ts`, `logger`, `msg`, `logging_pod`, and
  `record` when `msg` is the keyword `record`. For `logger: postgres` the
  record is the PostgreSQL CSV log line (`error_severity`, `message`,
  `detail`, `hint`, `user_name`, `database_name`, `application_name`,
  `query`, `sql_state_code`, `backend_type`, `process_id`). Other loggers
  seen on 1.30.0: `instance-manager`, `wal-archive`, `wal-restore`,
  `pg_controldata`, `pg_basebackup`, and the controllers of the declarative
  objects (`database-resource`, ...). Errors carry `error` and
  `stacktrace`.
- The PostgreSQL container is `postgres`; plugin sidecars are init
  containers that keep running.
- Kubernetes pod log API: `GET .../pods/<pod>/log` with `container`,
  `tailLines`, `sinceTime`, `timestamps`; it needs `get` on `pods/log`.

## Scope

Included: a "Logs" page in the Clusters group, addressed by cluster; doors
from the Cluster drawer (one per instance and one for the cluster) and from
the cluster menu; the pure parser and model; the log client. Excluded: the
operator's logs, log storage, export, full-text search on the server, any
change of `logLevel`.

## Design

### Standard or ad hoc view, and why

Ad hoc: the host's log viewer shows one container as raw text. This page
merges instances and turns each JSON line into a row. A door to the host
viewer stays for the raw text.

### Pure modules (`src/renderer/components/logs/`)

- `log-line.ts`: `parseLogLine(raw, pod)` reads the Kubernetes timestamp
  prefix and the JSON; a line that is not JSON is kept as it is. It yields
  `{ time, pod, source, level, message, fields }` with `source` one of
  `PostgreSQL`, `Instance manager`, `WAL archiving`, `Backup`, `Plugin`,
  `Declarative objects`, `Other`, and `level` from the PostgreSQL severity
  for PostgreSQL lines (`PANIC`, `FATAL`, `ERROR` error; `WARNING`
  warning; the rest info or debug) and from `level` otherwise. `fields`
  are the few worth a second line: user, database, application, query,
  detail, hint, SQL state, the error text; never the stack trace by
  default.
- `log-buffer.ts`: merges the lines of several pods by time, drops the
  duplicates a `sinceTime` read brings back, keeps the last 2000.
- `log-filter.ts`: by instance, source, minimum level and text.

### Client (`src/renderer/api/instance/pod-logs.ts`)

`GET` on the pod log endpoint through the host's cluster proxy, with the
typed failures of SPEC-0006 (`forbidden` names `pods/log`). First read:
the last 500 lines per instance; then every 3 seconds `sinceTime` of the
last line seen, one request per pod at a time, nothing while the window is
hidden or "Follow" is off.

### Page

Header: cluster picker, instance chips (all by default, the primary
marked), container picker (`postgres` and the sidecars), source chips,
level picker (All, Warnings and errors, Errors), text filter, Follow
toggle, a door to the host's log viewer of the selected pod. Body: rows of
time, instance, source badge, level badge, message; a second line with the
fields; a click expands the raw JSON. Newest at the bottom, the view sticks
to the bottom while following unless the user scrolled up.

### Non-happy states

Forbidden on `pods/log`: the panel says which permission is missing. A pod
without logs yet, a hibernated cluster (no pods): said in words. A pod that
fails to answer does not hide the others.

### Safety

Reads only. Logs can contain statements and their parameters: the page
shows what the cluster already writes to its standard output to whoever has
`pods/log`, and sends it nowhere.

## Tests (non-regression list)

- Unit: `log-line.test.ts` (every logger seen on 1.30.0 from recorded
  lines, severities, a non-JSON line, a broken line), `log-buffer.test.ts`
  (merge, duplicates, cap), `log-filter.test.ts`, the client.
- E2E: the logs of `e2e-main` show PostgreSQL and instance manager rows
  from more than one instance; the level picker on Errors keeps only error
  rows; the WAL archiving failure of `e2e-single` shows as an error row of
  the WAL archiving source; the door of an instance in the Cluster drawer
  lands on that instance only.
- Manual verification: the M5 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M5 at the
  milestone review.
- Implementation notes: the time of a row is the instance manager's own `ts`
  (when it happened); the Kubernetes stamp (when it was written) is the
  identity of the line and what the next read starts from, also after
  "Clear". A line without a logger belongs to the instance manager. The
  PostgreSQL tools the instance manager runs (`pg_controldata`,
  `pg_basebackup`, `pg_rewind`, ...) are filed under PostgreSQL. The text
  filter looks in the raw line, so a field or a query matches too. The DOM
  keeps the newest 1000 rows that pass the filters, the buffer the newest
  2000 lines, and the status line says both. With one instance the instance
  column is dropped. The frame of the page (title, cluster picker fed by the
  URL, doors, panels) is the shared `ClusterPickerPage`, which the Timeline
  uses too.
- Seen live on the E2E cluster (operator 1.30.0, PostgreSQL 18.4): rows of
  three instances on one axis; a PostgreSQL ERROR with its user, database,
  query and SQL state next to the instance manager error it caused; the WAL
  archiving failures of `e2e-single` alone on the Errors level; the door of
  an instance. Covered by unit tests only: a non-JSON line, a broken line, the
  plugin sidecar container, the forbidden panel.
