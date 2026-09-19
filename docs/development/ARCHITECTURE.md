# Architecture

## What this extension is

A Freelens extension that shows CloudNativePG resources (PostgreSQL clusters
run by the CloudNativePG operator) and the live state of their databases
inside Freelens. It is **CRD-native**: it reads the CloudNativePG custom
resources directly from the Kubernetes API of the active cluster, through
the Freelens extension framework, and it reaches the instances only through
the Kubernetes API server (pod proxy), never with database credentials.

## What it deliberately is not

- Not a CloudNativePG product: "CloudNativePG" is a trademark of the Linux
  Foundation; this is the "Freelens extension for CloudNativePG".
- Not a replacement for `kubectl cnpg`: the extension shows, compares and
  later acts; the plugin remains the reference tool and the psql terminal
  composes a plain `kubectl exec` for it.
- Not a port of any other CloudNativePG user interface: other interfaces
  are functional references to be matched and exceeded, never a source of
  code (see the licensing boundary).
- Not a database client: the extension never runs user-supplied SQL and
  never stores or forwards database credentials.

## Licensing boundary (critical)

This repository is MIT and written from scratch. The CloudNativePG operator,
the `kubectl cnpg` plugin and the Barman Cloud plugin are Apache-2.0, and any
other user interface for CloudNativePG carries its own license: their
documentation, CRD schemas, permission lists and observable behavior may be
read to understand fields and semantics, but components, CSS, UI strings,
status-mapping logic and generated clients are never copied. TypeScript types
for the CRDs are written in this repository from the CRD schemas of the
pinned operator release. See the "Licensing and provenance constraints" section of
[AGENTS.md](../../AGENTS.md) for the binding rules.

## Upstream facts (verify on every milestone)

Recorded in detail in
[SPEC-0001](../specs/SPEC-0001-recon-and-architecture.md), pinned to
CloudNativePG **v1.30.0**:

- API group `postgresql.cnpg.io/v1`, 11 kinds: `Cluster`, `Backup`,
  `ScheduledBackup`, `Pooler`, `Database`, `DatabaseRole`, `Publication`,
  `Subscription`, `ImageCatalog`, `ClusterImageCatalog`, `FailoverQuorum`.
  Plus `ObjectStore` in `barmancloud.cnpg.io/v1` (Barman Cloud plugin).
- Authoritative CRD schemas: the release manifest
  `releases/cnpg-<version>.yaml` in `cloudnative-pg/cloudnative-pg`.
- Every instance pod runs the `postgres` container with three named ports:
  `postgresql` 5432, `metrics` 9187, `status` 8000. `GET /pg/status` on
  the status port is unauthenticated by design and reachable through the
  API server's `pods/proxy` subresource; `/metrics` likewise.
- The backup method the CRD defaults to (`barmanObjectStore`) is
  deprecated; the Barman Cloud plugin (`method: plugin`) is the current
  path and the extension treats it as such.

## Process model

Freelens extensions run in two Electron processes. This extension keeps
everything it can in the renderer.

- **Renderer** (`src/renderer/`): all views, all CRD stores
  (`KubeApi` + `KubeObjectStore` per kind), the health model, the parsers,
  and the live data client. Live data is fetched with the host's own
  Kubernetes JSON API client (the `KubeJsonApi` every `KubeApi` carries as
  its protected `request`, reached through a small `KubeApi` subclass of
  ours, the same client core uses for pod logs), which goes through the
  Freelens cluster proxy with the user's own credentials, addressing the
  pod proxy path
  `/api/v1/namespaces/<ns>/pods/<scheme>:<pod>:<port>/proxy/<path>`.
  No extra dependency, no kubeconfig handling, no CORS.
- **Main** (`src/main/`): nothing beyond the scaffold's preferences store
  until a feature needs it. The one candidate is programmatic `exec` into
  an instance (fixed diagnostic queries), which would use
  `@kubernetes/client-node` from the main process with the cluster's own
  kubeconfig path and context, following the pattern proven in
  freelens-kafka-extension. It is a spike in M2, not a dependency of 0.1.
- **Common** (`src/common/`): code shared by both processes.

The renderer-first decision rests on one fact to be proven by a spike
(SPEC-0002, S1): that a GET on the pod proxy path through the Freelens
cluster proxy returns the instance manager JSON for both the `http` and
`https` status schemes. The fallback, if it does not, is the main-process
client above, exposed to the renderer through the extension's IPC.

## Data paths

| Need | Source | Path | Credentials |
| --- | --- | --- | --- |
| Clusters, backups, poolers, ... | CRDs | `KubeObjectStore` watch through the Freelens proxy | user's kubeconfig (host) |
| Instance pods, PVCs, services, secrets metadata, events | core stores | host stores (`podsStore`, `pvcStore`, ...) | user's kubeconfig (host) |
| Instance status (LSN, WAL, replication, slots, basebackups) | instance manager `GET /pg/status` | pod proxy, port 8000 | RBAC `pods/proxy` |
| Sessions, lag, sizes, archiver counters | metrics exporter `GET /metrics` | pod proxy, port 9187 | RBAC `pods/proxy` |
| Operator reconciles, workers, queues | operator `GET /metrics` | pod proxy, the `metrics` port of its container (8080) | RBAC `pods/proxy` in the operator's namespace |
| Instance logs | Kubernetes pod log API `GET .../pods/<pod>/log` | Freelens cluster proxy | RBAC `pods/log` |
| Primary lease, operator lease | `Lease` objects | the host's own store, through the API manager | user's kubeconfig (host) |
| psql | host terminal tab | `kubectl exec -it -n <ns> -c postgres <pod> -- psql -U postgres` | user's kubeconfig (terminal) |
| Query-level detail (later, if ever) | `exec` with fixed queries | main process, `@kubernetes/client-node` | RBAC `pods/exec` |

Nothing in the table stores a database password. The psql terminal
connects as the `postgres` superuser through the container's local socket
and says so in its tooltip.

## Health model (summary)

The cluster health shown in lists and in the overview is computed by a
pure, unit-tested module from: `status.phase` (closed set of known
strings), the `Ready`, `ContinuousArchiving` and `LastBackupSucceeded`
conditions, `readyInstances` against `instances`, the hibernation and
fencing annotations, and the backup facts. Backup facts (last successful
backup, last failed backup, first recoverability point) are derived from
the `Backup` objects of the cluster, because the corresponding
`Cluster.status` fields are deprecated and empty when backups go through
the plugin; the status fields are the fallback. Certificate expiry comes
from `status.certificates.expirations`, whose values use the Go
`time.String()` layout and are parsed by a tested helper. The full model is
in SPEC-0001.

## Source layout (target)

```text
src/
  main/index.ts              # Extension entry point (main process): preferences only
  renderer/index.tsx         # Extension entry point (renderer): registers
                             # kubeObjectDetailItems, kubeObjectMenuItems,
                             # clusterPages, clusterPageMenus
  renderer/api/cnpg/         # One file per CRD: KubeObject + KubeApi +
                             # KubeObjectStore, typed Spec/Status interfaces
                             # written from the CRD schemas
  renderer/api/barmancloud/  # The ObjectStore kind of the optional Barman Cloud plugin
  renderer/api/instance/     # Instance manager and metrics contracts: the
                             # PostgresqlStatus type and guard, the Prometheus
                             # text reader, the pod proxy client (GET on the four
                             # read endpoints only, typed failures)
  renderer/pages/            # List pages and the ad hoc pages (overview, live view)
  renderer/details/          # Detail panels (kubeObjectDetailItems)
  renderer/menus/            # kubeObjectMenuItems: navigation (live view) and,
                             # from M6, the actions; the psql terminal comes next
  renderer/components/       # Shared pure modules and components: health model,
                             # status classifiers, parsers (Go time, LSN, intervals,
                             # cron text), backup history, reference loading
  renderer/components/live/  # The live view: pure model, poller, sparkline series,
                             # topology layout and component, tiles; the pooler
                             # model; the polling loop the drawers share and the
                             # readings of a database and of a replication slot
  renderer/components/logs/  # The Logs page: line parser, merge buffer, filters,
                             # the reading loop over the pod log API
  renderer/icons/            # Original SVG icons (never copied)
  common/                    # Code shared between main and renderer
e2e/                         # kind cluster scripts, fixtures, Playwright suite
docs/development/            # This file, PROCESS, ROADMAP, DESIGN, TESTING, TRY-IT
docs/specs/                  # One spec per feature
```

Pattern rules (KubeObject statics, no instance methods, host-provided
globals, SCSS modules) are in [AGENTS.md](../../AGENTS.md).

## Sidebar structure

One "CloudNativePG" parent entry in the cluster sidebar; below it a few
groups (Overview, Clusters, Backups, and later Pooling and Images,
Databases, Operations), each with its resource pages. The `Cluster` kind is
titled "PostgreSQL Clusters" because the host already has a root item named
"Cluster" (DESIGN.md, section 4).

## Reference code

When implementing views, study these repositories for patterns (all MIT,
copying allowed and encouraged):

- `freelensapp/freelens`: the host application; list/detail components,
  stores, conditions rendering, drawer layout, the terminal dock.
- `freelensapp/freelens-kubeswift-extension`: the reference for specs,
  E2E infrastructure, the pre-review pass and the terminal-tab command
  pattern.
- `freelensapp/freelens-kafka-extension`: the reference for a main-process
  client with `@kubernetes/client-node` (kubeconfig resolution,
  port-forward, timeouts, write-mode gate).
- `freelensapp/freelens-karpenter-extension`: the reference for an ad hoc
  dashboard (overview cards, topology, timeline).
- `freelensapp/freelens-example-extension`: the scaffold this repo started
  from.
