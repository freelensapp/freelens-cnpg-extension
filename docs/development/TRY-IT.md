# Try it: the extension on a demo cluster

This is the path of the milestone review (PROCESS.md, "Milestone manual
review gate") and the quickest way to see the extension do its job: a local
kind cluster with a real CloudNativePG operator, four PostgreSQL clusters in
different states, real backups, and a small load that keeps the databases
busy.

## What you need

- Docker (Docker Desktop with about 8 GB of memory for its VM is enough),
  `kind`, `kubectl`, Node.js and `pnpm` as in the README.
- Freelens 1.10.3 or newer.

## 1. Bring the demo cluster up

```bash
pnpm install
pnpm demo:up
```

The first run takes about ten minutes (images are pulled, the operator, the
Barman Cloud plugin and an in-cluster object store are installed, the
clusters are created and backed up); later runs take seconds. The script ends
by printing the kubeconfig to add to Freelens (`.demo/kubeconfig`, context
`kind-cnpg-demo`).

On a small machine that already runs the E2E cluster, point the demo at it
instead of creating a second one:

```bash
DEMO_CLUSTER_NAME=cnpg-e2e DEMO_STATE_DIR=.e2e pnpm demo:up
```

What is in the namespace `cnpg-e2e`:

| Cluster | State | What it is there to show |
| --- | --- | --- |
| `e2e-main` | healthy, three instances, archiving, backups, two schedules, a `pgbench` load | the happy path: topology, lag, sessions, backup history |
| `e2e-single` | degraded, archiving into a broken object store, a failed backup, a suspended schedule | failures that must be impossible to miss |
| `e2e-hibernated` | hibernated | a cluster with no instances |
| `e2e-fenced` | its only instance fenced | an instance manager that answers while PostgreSQL does not |

## 2. Install the extension in Freelens

```bash
pnpm pack:dev
```

In Freelens: Extensions, then install the `.tgz` the command printed. Add the
demo kubeconfig (Catalog, add from file), open the cluster, and select the
namespace `cnpg-e2e` in the namespace filter of any list: every view of the
extension follows that filter.

## 3. Walk through it

1. **CloudNativePG, Overview**: four tiles ordered by urgency. Click a
   counter, a tile, the backup figure of a tile, its next backup line, its
   live view door. The last counter and a line on the tiles say how many
   declared objects PostgreSQL does not have as declared.
2. **Clusters, PostgreSQL Clusters**: open `e2e-main`; scroll to "Backups and
   archiving" for the backup history strip; try the psql button of a standby
   in the Instances table.
3. **Clusters, Live View**: pick `e2e-main` and watch for a minute: the
   sessions, the lag sparklines and the WAL position move with the load.
   Then pick `e2e-single` (the archive is failing), `e2e-fenced` and
   `e2e-hibernated`.
4. **Backups**: open a completed backup for its restore coordinates and the
   failed one for its error; in **Scheduled Backups** open `e2e-immediate`
   for the backups it generated and `e2e-suspended` for the warning.
5. **Backups, Object Stores**: the recovery window the plugin reports for
   every server; **Images**: who follows a catalog; **Clusters, Failover
   Quorums**: whether a failover could be decided safely; **Pooling,
   Poolers**: open `e2e-main-pooler` and watch "Right now" with the demo
   client going through it.
6. **Databases**: `e2e-db-bad-extension` says which managed object failed,
   `e2e-db-inventory-again` links the object that already manages its
   database, `e2e-db-inventory` shows its size right now. **Database Roles**:
   `e2e-role-reporting` for the client certificate, `e2e-role-contractor` for
   the expired password, `e2e-role-inline-rival` for the conflict with the
   cluster spec (then open `e2e-single` and look at "Declarative objects").
   **Publications** and **Subscriptions**: open `e2e-sub-numbers` for the
   replication path from `e2e-main`, the slot on the publisher and the
   failover caveat.
7. **Clusters, Logs**: pick `e2e-main` and read the rows: a failed declared
   database shows as a PostgreSQL error with its query, right above the
   instance manager error it caused; narrow to the primary with its chip; set
   the level to Errors on `e2e-single` for the WAL archiving failures; click
   a row for its raw JSON. **Clusters, Timeline**: events, backups, the
   primary and its lease in order, with what is scheduled above the "now"
   line. In the drawer of a cluster, Replication section: the **primary
   lease**. **Operator**: version, leader, what it watches, the reconciles
   per controller right now, the plugin and the kinds.
8. Row menu of `e2e-main`: **Open psql**. It opens a session as the
   `postgres` superuser on the primary, under your own kubeconfig.
9. **The write actions**, on the cluster made for them: set the namespace
   filter to `cnpg-e2e-actions`. Open the row menu of `e2e-actions` and read
   a dialog before you confirm anything: every one names the cluster and the
   Kubernetes context and lists the exact API calls. **Back up now**, then
   follow the backup in the Backups list. **Switchover**: the table of the
   standbys with their state and replay lag, read from the primary every five
   seconds; type the name and confirm, then watch the Timeline. **Restart**:
   the rollout in order, with what happens to the primary under this
   cluster's own settings. In the drawer, Instances table: **Promote**,
   **Restart** (a standby is recreated, the primary restarts PostgreSQL in
   place) and **Fence**, then lift the fence from the "Fenced instances" row.
   **Hibernate**: the dialog lists what is attached to the cluster and what
   happens to it; the "Hibernation" row of the drawer follows the operator,
   and **Resume** is on that row. Under Backups, Scheduled Backups:
   **Suspend**, **Run now** (the hollow mark in the history of the schedule)
   and **Resume**. On the other namespace, look at what is refused and why:
   the menus of `e2e-hibernated`, `e2e-single` and `e2e-fenced`.
10. Switch the theme in the Freelens preferences and look again.

For every view the question of the review is the same: is this the best
possible view for the task?

## 4. The agent pass that precedes a review

```bash
pnpm pre-review
```

It brings the demo cluster up, walks every view on both themes, checks the
rules of DESIGN.md that a machine can check and compares the views with what
the instances say. Screenshots and `REPORT.md` land in
`e2e-artifacts/pre-review/`; the report ends with the list of what is left
to human judgment. It needs the Freelens checkout of the E2E suite (see
TESTING.md).

## 5. Tear it down

```bash
pnpm demo:down
```

It deletes the demo cluster and `.demo/`. When the demo was pointed at the
E2E cluster, it removes only the `pgbench` load.
