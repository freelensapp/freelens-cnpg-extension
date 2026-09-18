# SPEC-0002: Test environment and E2E infrastructure

- **Status:** Draft
- **Milestone:** `M1` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0` (operator), Barman Cloud
  plugin `v0.15.0`
- **Author / date:** freelensapp core team, 2026-09-18

## Goal

One command brings up a disposable kind cluster with the real CloudNativePG
operator, the Barman Cloud plugin, an in-cluster object store and a set of
PostgreSQL clusters, backups, a scheduled backup and a pooler in every state
the M1 and M2 views distinguish, so that every view can be developed,
verified live and covered by E2E tests against real statuses. The same
cluster answers spike S1 of SPEC-0001.

## Upstream reference

- CloudNativePG installation (`releases/cnpg-1.30.0.yaml`), quickstart and
  `docs/src/supported_releases.md` (Kubernetes 1.34 to 1.36 for 1.30.x).
- Barman Cloud plugin installation and usage (`web/docs/installation.mdx`,
  `web/docs/usage.md`): same namespace as the operator, cert-manager
  required, `ObjectStore` plus `spec.plugins[]`.
- freelens-kubeswift-extension `e2e/` (MIT): the script layout, the
  dedicated kubeconfig, the Freelens integration harness reuse, the CI
  workflow. Copied and adapted, as intended.

## Scope

Included: the cluster lifecycle scripts, the fixtures, the E2E suite
skeleton with the spike S1 case and the extension-activation case, the CI
workflow, the developer documentation in TESTING.md. Excluded: the demo
cluster and the pre-review pass (SPEC-0008), any view assertion (each view
spec adds its own cases to the suite).

## Design

### Pins (single place: `e2e/scripts/lib.sh`, Renovate-annotated)

| Component | Version | Source |
| --- | --- | --- |
| kind | 0.33.0 | `kubernetes-sigs/kind` |
| Kubernetes node image | `kindest/node:v1.36.4` (digest pinned) | kind 0.33.0 release |
| CloudNativePG operator | 1.30.0 | `releases/cnpg-1.30.0.yaml` at the tag |
| cert-manager | v1.21.2 | `cert-manager/cert-manager` release manifest |
| Barman Cloud plugin | v0.15.0 | release asset `manifest.yaml` |
| MinIO | `RELEASE.2025-09-07T16-13-09Z` (the newest tag published on quay.io) | `quay.io/minio/minio` |
| PostgreSQL image | the operator's default for 1.30.0 (18.x) | operator |

Local prerequisites: Docker with at least 8 GB for its VM, `kind`,
`kubectl`, `curl`. On macOS `brew install kind` provides the pinned major.

### Cluster shape

- Name `cnpg-e2e`, context `kind-cnpg-e2e`, kubeconfig `.e2e/kubeconfig`
  (the developer's `~/.kube/config` is never read or written).
- One control-plane and two worker nodes, so that the three-instance
  cluster spreads and `status.topology` shows more than one node.
- Namespace `cnpg-e2e` for every namespaced fixture; `cnpg-system` for
  the operator and the plugin; `cert-manager` for cert-manager.

### Bring-up order (`cluster-up.sh`, idempotent)

1. Create the cluster (reuse if present), export the kubeconfig.
2. cert-manager: apply the release manifest, wait for the three
   deployments and for the webhook to answer (a `cmctl`-free check: create
   and delete a dry-run Certificate).
3. Operator: apply the release manifest, wait for
   `deployment/cnpg-controller-manager` available.
4. Barman Cloud plugin: apply `manifest.yaml` in `cnpg-system`, wait for
   `deployment/barman-cloud` available and for the `Cluster` webhook to
   accept a plugin reference (retry on the "unknown plugin" admission
   error).
5. MinIO: one Deployment plus Service `minio` on 9000, a bucket created by
   a Job with the `mc` client, credentials in a Secret; wait for the Job.
6. Fixtures (numbered files, `kubectl apply`), then waits:
   - `ObjectStore` `e2e-store` (MinIO endpoint, bucket `backups`) and
     `e2e-store-broken` (wrong credentials, for the failed backup);
   - `Cluster` `e2e-main`: 3 instances, plugin WAL archiving on
     `e2e-store`, monitoring enabled with plaintext metrics, small
     resources, storage 1Gi;
   - `Cluster` `e2e-single`: 1 instance, metrics with TLS enabled
     (`.spec.monitoring.tls.enabled: true`), plugin on `e2e-store-broken`;
   - `Cluster` `e2e-hibernated`: 1 instance created healthy, then
     annotated `cnpg.io/hibernation: "on"`; the script waits for the pods
     to go away;
   - `Cluster` `e2e-fenced`: 1 instance, then annotated
     `cnpg.io/fencedInstances: '["e2e-fenced-1"]'`;
   - `Backup` `e2e-backup-ok` on `e2e-main` (`method: plugin`), waited to
     `completed`; `Backup` `e2e-backup-failed` on `e2e-single`, waited to
     `failed`;
   - `ScheduledBackup` `e2e-nightly` on `e2e-main` (`0 0 3 * * *`,
     `immediate: false`, plugin);
   - `Pooler` `e2e-main-pooler` (rw, one PgBouncer instance).
7. Readback assertions (`verify_fixtures`): phases, `readyInstances`,
   backup phases, the hibernated cluster with zero pods, the fenced
   instance in `status.instancesStatus`, the pooler deployment ready.

Expected wall time: 6 to 10 minutes on first run (image pulls), 2 to 4
minutes on reuse.

### Why no injected statuses

The operator reconciles `Cluster.status` continuously, so a status patch
would be overwritten within seconds; the states the operator cannot
produce on demand (an unrecoverable cluster, a WAL archiving failure, an
expired certificate) are covered by unit tests of the health model over
hand-written fixtures, and by no E2E case. The one exception is the
"phase string never seen" case, which needs no cluster.

### E2E suite skeleton (`e2e/__tests__/cnpg-e2e.tests.ts`)

Runs inside the Freelens integration harness like the kubeswift suite:
`run-suite.sh` packs the extension, copies the suite and
`integration/helpers/*` into the Freelens checkout and runs
`pnpm test:integration cnpg-e2e`. Helpers: `cnpg-cluster.ts` (kubectl
against the E2E kubeconfig, kubeconfig copy into the sandboxed user data),
`cnpg-extension.ts` (install from `EXTENSION_PATH`, activation without
errors), `cnpg-views.ts` (sidebar and table helpers, grows with the
views).

Cases in this spec:

1. The extension installs and activates without errors (the scaffold's
   integration case, kept).
2. The cluster connects and the namespace filter is set to `cnpg-e2e`.
3. **Spike S1**: through the extension's pod proxy client, `GET
   /pg/status` of the primary of `e2e-main` (https scheme) and of
   `e2e-single` (https) returns JSON whose `isPrimary` is true and whose
   `currentLsn` matches `kubectl cnpg status` within the run; and `GET
   /metrics` of `e2e-main-1` contains `cnpg_collector_up`. The client is
   a minimal module exposed for the test (`window` hook behind a test-only
   flag), replaced by the real live view client in SPEC-0006.
4. An http-scheme instance is not available on 1.30 (every new pod is
   TLS); the http branch of the scheme detector is covered by a unit test.

### CI (`.github/workflows/e2e-tests.yaml`)

Copied from kubeswift: `ubuntu-24.04-arm` runner, Freelens checkout at the
pinned tag built with the same caches as the integration workflow, kind and
kubectl installed from `lib.sh` pins, `pnpm e2e`, artifacts uploaded on
failure. Runs on every PR and on main.

### Safety

The scripts only ever touch the `cnpg-e2e` kind cluster and the
`.e2e/` directory. `require_docker` refuses to run without a daemon;
`cluster-down.sh` deletes only the named cluster.

## Tests (non-regression list)

- Unit: `e2e/scripts` has none (bash); the health-model fixtures of
  SPEC-0003 reuse the objects this cluster produces, exported once with
  `kubectl get -o yaml` and trimmed.
- Integration: the scaffold's activation case, unchanged.
- E2E: cases 1 to 3 above; every later spec appends its cases to the same
  file.
- Manual verification: first bring-up on macOS (Docker Desktop) and on the
  CI runner, recorded here with the wall time observed.

## Notes and deviations

Filled during implementation when reality diverges from the plan.
