# SPEC-0031: Connect to a cluster, and forward a local port

- **Status:** Implemented
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

From the drawer of a `Cluster` (or a `Pooler`), the user knows how an application reaches the
database and copies a ready connection string, and opens a local port to the primary, the replicas
or the pooler to connect a desktop tool, without typing `kubectl port-forward`.

## Upstream reference

- The application user Secret `<cluster>-app` (type `kubernetes.io/basic-auth`, label
  `cnpg.io/userType: app`), keys on v1.30.1: `username`, `user`, `password`, `dbname`, `host`,
  `port`, `pgpass`, `uri`, `jdbc-uri`, `fqdn-uri`, `fqdn-jdbc-uri`. The superuser Secret exists only
  with `enableSuperuserAccess`.
- The services of a cluster: `<cluster>-rw` (primary), `-ro` (replicas only), `-r` (any instance);
  a `Pooler` has its own service. `spec.managed.services` can disable `-ro` and `-r` and add more.
- `kubectl port-forward service/<name> <local>:5432`; RBAC `create` on `pods/portforward`.
- Other UIs: the Headlamp plugin shows a connection panel from the Secret; port-forward is asked for
  in its issue #94. Functional reference only (AGENTS.md).

## Scope

Included: a "Connect" section in the `Cluster` and `Pooler` drawers; a "Forward a local port"
action on both; a list of the active forwards of the cluster in its drawer.

Excluded: other users' Secrets (managed roles), the superuser Secret, client certificates (SPEC-0034
shows the role certificate), opening an external database tool.

## Design

### Standard or ad hoc view, and why

A drawer section and an action: the question "how do I connect" is asked about one cluster, where
its drawer already is.

### Connect section

- Rows per service of the cluster that exists (rw, ro, r, and those of `spec.managed.services`):
  in-cluster host (`<service>.<namespace>`, the FQDN as tooltip), port, purpose in words
  ("read and write, primary only"). For a Pooler: its service and the pooler type.
- From the `-app` Secret: database and user in clear; the password as `••••••` with a "Copy" button;
  "Copy URI" and "Copy JDBC URI" (in-cluster and FQDN variants). The Secret is read when the button is
  pressed, its value goes to `navigator.clipboard` and nowhere else: not into state, logs, IPC or
  storage. A notification says what was copied, never the value.
- Before reading, an access review on `get` of that Secret. Denied: the section still shows hosts
  and ports, and says which permission is missing.
- Missing Secret (a cluster bootstrapped without the default user): "No application user Secret";
  the hosts stay.

### Forward a local port (main process)

- The action asks which service (rw by default, ro, r, a pooler) and starts in main
  `kubectl port-forward --address 127.0.0.1 service/<name> :5432` with the host's kubectl and the
  cluster's environment (`Main.Shell.getKubectlPath(clusterId)`, `Main.Shell.getEnvironment`), as
  freelens-kafka-extension does for its brokers. Main reads the local port from kubectl's output and
  answers the frame that asked (an `invoke`, never a broadcast).
- The drawer lists the active forwards of the cluster: service, `127.0.0.1:<port>`, since when, with
  "Copy psql command" (`psql "host=127.0.0.1 port=<port> dbname=<db> user=<user>"`, no password) and
  "Stop".
- Main stops a forward when asked, when the cluster disconnects, when the extension is deactivated
  and when Freelens quits; a kubectl that exits is reported on the row, not restarted.
- Access review on `create pods/portforward` before the action is offered; denied, the action is
  disabled with the reason.

### Safety

- The section reads one Secret on an explicit click and keeps nothing. This is the only place the
  extension reads a credential; AGENTS.md "Safety rules" gets the exception in words: shown masked,
  copied on request to the clipboard, never stored or forwarded.
- The forward binds `127.0.0.1` only, and writes nothing to the cluster.

## Tests (non-regression list)

- Unit: the service rows from a cluster and its `managed.services`; the strings built for psql
  (no password); the forward registry in main (start, port parsing, stop on abort, disconnect,
  deactivation, process exit) with a fake kubectl.
- E2E: on `e2e-main`, the Connect section lists rw, ro and r; "Copy URI" puts the Secret's `uri` in
  the clipboard (read back in the test, not printed); a forward to rw answers `SELECT 1` from the
  test through `127.0.0.1:<port>`; "Stop" closes the port; disabling the extension closes it too.
- Manual verification: a desktop client (pgAdmin, DBeaver) through the forward on Windows and macOS.

## Notes and deviations

- **Main process.** `src/main/port-forwards.ts`, adapted from the kubectl tunnels of
  freelens-kafka-extension: the host's kubectl and environment (`Main.Shell`), the local port read from
  kubectl's line of readiness, refusals said in words (pods/portforward, credential, service missing, no
  pod), kubectl killed on Stop, on cluster disconnection (`Main.Catalog` status), on deactivation and on
  process exit; a kubectl that exits on its own stays on its row as ended ("Dismiss"), never restarted.
  Only Kubernetes names cross the IPC, checked by main. The list is asked by the drawer every 3 s
  (`invoke`, never a broadcast).
- **One button per service** instead of an action that asks which service: the rows are the choice, one
  click less. Port-forward writes nothing, so it has no confirmation dialog; it is disabled with the reason
  when the access review denies `create pods/portforward`.
- **Database and user** come from the bootstrap of the cluster (`initdb`, `recovery` or `pg_basebackup`,
  app and app by default), so they show without reading the Secret; the Secret is the one the bootstrap
  names, else `<cluster>-app`. Copy buttons: password, URI, JDBC URI and their FQDN variants. A notification
  says what was copied, never the value. Without `get secrets` the section says so and keeps the hosts.
- **E2E**: the URI read back from the clipboard equals the Secret's (compared, never printed); `psql`
  answers `SELECT 1` through the forward with `sslmode=require`; Stop and disabling the extension close the
  port (checked with `pg_isready`). Freelens 2 labels the menu item that enables a disabled extension
  "Enabled" instead of "Enable" (`installed-extensions.tsx`): the test helper takes both. Worth a fix in
  Freelens.
- **Manual verification still to do**: a desktop client (pgAdmin, DBeaver) through a forward on Windows
  and macOS.
