# Roadmap to v1.0.0

Goal for v1.0.0: the most complete and usable graphical interface for
CloudNativePG, reimplemented from scratch as a Freelens extension that reads
the Kubernetes API directly (see [ARCHITECTURE.md](ARCHITECTURE.md) for the
architecture and licensing boundaries). Every existing CloudNativePG user
interface and tool is a functional reference to be matched and then exceeded,
never a source of code.

This file is the single source of truth for scope and progress. Update it in
every PR that starts, completes, or re-scopes a feature.

## Releases

- **0.1**: M1 and M2, read-only, plus the test infrastructure. A few things
  done properly: cluster health at a glance, cluster detail, backups, the live
  database view and the psql terminal.
- **1.0.0**: M1 to M7.

## Feature inventory and milestones

Derived from the CloudNativePG v1.30.0 API (11 kinds in
`postgresql.cnpg.io/v1`, plus `ObjectStore` in `barmancloud.cnpg.io/v1`),
the `kubectl cnpg` plugin and the instance manager contracts recorded in
[SPEC-0001](../specs/SPEC-0001-recon-and-architecture.md).

### M1 - Cluster views (read-only)

| Feature | Spec | Status |
| --- | --- | --- |
| Recon digest, data access architecture, health model | [SPEC-0001](../specs/SPEC-0001-recon-and-architecture.md) | Approved |
| Test environment and E2E infrastructure (kind, operator, fixtures) | [SPEC-0002](../specs/SPEC-0002-test-environment-and-e2e-infrastructure.md) | Done |
| Cluster list with health summary + detail drawer (instances and roles, replication topology, storage, certificates, conditions, related objects) | [SPEC-0003](../specs/SPEC-0003-m1-cluster-list-and-detail.md) | Done |
| Overview page (ad hoc): health of every cluster at a glance, drill-down to lists and drawers | [SPEC-0004](../specs/SPEC-0004-m1-overview-page.md) | Done |

### M2 - Backups, live view, psql (read-only)

| Feature | Spec | Status |
| --- | --- | --- |
| Backup and ScheduledBackup lists + details, backup history strip, backup-derived health | [SPEC-0005](../specs/SPEC-0005-m2-backups-and-scheduled-backups.md) | Done |
| Live database view (instance status and metrics through the API server pod proxy: replication topology, sessions, replication lag, database sizes, WAL, slots) | [SPEC-0006](../specs/SPEC-0006-m2-live-database-view.md) | Done |
| Open psql in a Freelens terminal tab (primary or replica) | [SPEC-0007](../specs/SPEC-0007-m2-open-psql.md) | Done |
| Pre-review agent pass and local demo cluster | [SPEC-0008](../specs/SPEC-0008-m2-pre-review-pass-and-demo-cluster.md) | Done |

### M3 - Pooling, images, quorum, object stores (read-only)

| Feature | Spec | Status |
| --- | --- | --- |
| Pooler list + detail (PgBouncer, referring cluster, live pooler figures through the pod proxy) | [SPEC-0012](../specs/SPEC-0012-m3-poolers.md) | Done |
| ImageCatalog and ClusterImageCatalog list + detail, with the clusters that follow them | [SPEC-0010](../specs/SPEC-0010-m3-image-catalogs.md) | Done |
| FailoverQuorum list + detail, with the quorum check in words | [SPEC-0011](../specs/SPEC-0011-m3-failover-quorums.md) | Done |
| ObjectStore (Barman Cloud plugin) list + detail with referring clusters and the plugin's recovery windows | [SPEC-0009](../specs/SPEC-0009-m3-object-stores.md) | Done |

### M4 - Declarative database management (read-only)

| Feature | Spec | Status |
| --- | --- | --- |
| Database list + detail with reconciliation status | [SPEC-0013](../specs/SPEC-0013-m4-databases.md) | Done |
| DatabaseRole list + detail | [SPEC-0014](../specs/SPEC-0014-m4-database-roles.md) | Done |
| Publication and Subscription list + detail | [SPEC-0015](../specs/SPEC-0015-m4-publications-and-subscriptions.md) | Done |

### M5 - Operations views (ad hoc)

| Feature | Spec | Status |
| --- | --- | --- |
| Operator status page (deployment, version, CRDs, detected plugins, listening namespaces, reconciles right now) | [SPEC-0016](../specs/SPEC-0016-m5-operator-page.md) | Planned |
| Cluster events timeline (Kubernetes events, backups, switchovers, phase changes) | [SPEC-0017](../specs/SPEC-0017-m5-cluster-timeline.md) | Planned |
| Instance logs made readable, every instance of a cluster on one time axis | [SPEC-0018](../specs/SPEC-0018-m5-instance-logs.md) | Planned |
| Leader election lease of the operator and of a cluster (holder, acquire and renew time, transitions) | [SPEC-0019](../specs/SPEC-0019-m5-leases.md) | In PR |

### M6 - Write actions (behind explicit confirmation)

| Feature | Spec | Status |
| --- | --- | --- |
| On-demand backup | | Planned |
| Switchover and promote | | Planned |
| Restart and reload | | Planned |
| Fencing and hibernation | | Planned |
| ScheduledBackup suspend and trigger now | | Planned |

The first write spec sets the ground rules for every action of this
milestone: confirmation dialogs that name the CloudNativePG cluster and the
Kubernetes context and enumerate the writes they perform, no optimistic UI,
explicit patch types, failures reported rather than swallowed, no dead
controls. Nothing in M6 ships without a test that reads the result back from
the cluster.

### M7 - Creation forms and metrics charts

| Feature | Spec | Status |
| --- | --- | --- |
| Create Cluster form with live YAML preview (plugin-based backups by default) | | Planned |
| Create ScheduledBackup (cron editor), Pooler, ObjectStore | | Planned |
| Create Database, DatabaseRole, Publication, Subscription | | Planned |
| Metrics charts (host chart components over the live view data) | | Planned |

### Cross-cutting

| Item | Status |
| --- | --- |
| E2E test infrastructure (kind + operator + fixtures + Playwright) | [SPEC-0002](../specs/SPEC-0002-test-environment-and-e2e-infrastructure.md), Done |
| Local demo cluster and milestone review gate (`pnpm demo:up`) | [SPEC-0008](../specs/SPEC-0008-m2-pre-review-pass-and-demo-cluster.md), Done |

## Out of scope for v1

- Anything the deprecated in-tree `barmanObjectStore` backup method needs
  as its default: the extension shows it where it exists and never
  generates it.
- Running user-supplied SQL from the extension's own code paths: the psql
  terminal is the place for that, under the user's own credentials.
- Replacing Freelens native views for Pods, PVCs, Services and Secrets:
  the extension links to them.

## Release criteria for v1.0.0

- All milestones M1 to M7 implemented, each behind an approved spec.
- Every feature covered by non-regression tests (unit + E2E) green in CI.
- Docs (specs, architecture, roadmap) aligned with the shipped behavior.
