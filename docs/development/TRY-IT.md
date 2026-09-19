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
   live view door.
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
6. Row menu of `e2e-main`: **Open psql**. It opens a session as the
   `postgres` superuser on the primary, under your own kubeconfig.
7. Switch the theme in the Freelens preferences and look again.

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
