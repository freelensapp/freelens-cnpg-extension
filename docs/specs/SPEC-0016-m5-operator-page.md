# SPEC-0016: Operator page (ad hoc, read-only)

- **Status:** Implemented
- **Milestone:** `M5` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

Before looking at any database, an operator of the platform wants to know
that the thing which runs them is well: which version of CloudNativePG is
installed and where, whether it is up and who leads, what it watches, which
plugins it found, which kinds the cluster knows, and whether it is
reconciling without errors right now.

## Upstream reference

- The operator is a `Deployment` labelled
  `app.kubernetes.io/name=cloudnative-pg` (`cnpg-controller-manager` in
  `cnpg-system` with the release manifest; name and namespace differ with
  Helm and OLM). Its container carries the version in the image tag and in
  `OPERATOR_IMAGE_NAME`, the ports `metrics` (8080, plain HTTP) and
  `webhook-server`, and the flags `--leader-elect`,
  `--max-concurrent-reconciles`, `--config-map-name`, `--secret-name`.
- Configuration ("Operator configuration", v1.30.0): an optional ConfigMap
  and an optional Secret with the names given by the flags; `WATCH_NAMESPACE`
  (empty means every namespace), `INHERITED_ANNOTATIONS`, `INHERITED_LABELS`
  and the other options, as plain keys. The operator reads them at start.
- Leader election: a `Lease` named `db9c8771.cnpg.io` in the operator's
  namespace; the holder identity starts with the pod name.
- CNPG-I plugins are discovered through Services labelled
  `cnpg.io/pluginName` in the operator's namespace, with the annotations
  `cnpg.io/pluginPort`, `cnpg.io/pluginClientSecret`,
  `cnpg.io/pluginServerSecret`. A cluster reports the plugins it loaded in
  `status.pluginStatus` (name, version, capabilities).
- The metrics endpoint exposes the controller-runtime series:
  `controller_runtime_reconcile_total{controller,result}`,
  `controller_runtime_reconcile_errors_total{controller}`,
  `controller_runtime_active_workers{controller}`,
  `controller_runtime_max_concurrent_reconciles{controller}`,
  `workqueue_depth{name}`, `leader_election_master_status`. Functional
  reference only; the sentences shown are ours.

## Scope

Included: an "Operator" page in the Overview group; the pure model; the
fourth read endpoint of the pod proxy client (operator metrics). Excluded:
any action (restart, scaling, configuration), reading the operator Secret
(linked, never opened), the webhook configurations, the operator logs (the
Logs page of SPEC-0018 covers instances; the operator pod links to the
host's own log viewer).

## Design

### Standard or ad hoc view, and why

Ad hoc page: the operator is not a custom resource but a deployment, a
lease, a few services and a set of CRDs that only make sense together.
Native components inside: `DrawerItem`-like rows in cards, `Badge`,
`Table`.

### Pure module (`src/renderer/components/operator.ts`)

- `findOperators(deployments)`: by the label, else by the container image
  name; more than one is reported as such (one per namespace is a supported
  installation).
- `operatorFacts(deployment, pods, lease, configMap)`: version (image tag,
  digest stripped), image, ready over declared replicas, state
  (`Running`, `Progressing`, `Down`), leader pod from the lease holder,
  lease renew age and transitions, watch scope (`All namespaces` or the
  list), max concurrent reconciles, the configuration keys that are set.
- `leaseFacts(lease, now)`: holder, acquired, renewed, duration,
  transitions, and whether it is current (renewed within twice its
  duration), shared with SPEC-0019.
- `pluginFacts(services, deployments, clusters)`: every discovered plugin
  with its port, the readiness of the deployment behind the service, and
  the clusters that loaded it with the version they report.
- `kindFacts(crds)`: the CRDs of `postgresql.cnpg.io` and
  `barmancloud.cnpg.io`, their served and stored versions, and whether the
  extension has a view for each.
- `reconcileFacts(previous, current, seconds)`: per controller, reconciles
  and errors per minute between two readings, active workers over the
  maximum, queue depth; the level is `error` while errors grow.

### Page

Cards: **Operator** (state badge, version, image, namespace, replicas, pods
as links, leader, watch scope, configuration), **Right now** (per
controller table from the metrics of the leader pod, every 30 seconds while
the page is visible; the typed failures of SPEC-0006 as one sentence),
**Plugins**, **Kinds**. More than one operator: a selector on top.

### Non-happy states

No operator deployment visible: a panel that says the deployment was not
found in the namespaces the user can list, and that the kinds may still be
served. Forbidden on deployments, leases, services or CRDs: the card says
what could not be read and the rest of the page stays.

### Safety

Reads only. One new `GET` through the pod proxy, on the operator's metrics
port; the client still has no generic request method.

## Tests (non-regression list)

- Unit: `operator.test.ts` (discovery, version parsing, state, watch
  scope, lease, plugins, kinds, reconcile rates), the new client method.
- E2E: the page shows version 1.30.0, Running 1/1, the leader pod, "All
  namespaces", the Barman Cloud plugin with `e2e-main` among its clusters,
  the twelve kinds with a view, and a reconcile table with the `cluster`
  controller.
- Manual verification: the M5 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M5 at the
  milestone review.
- Deviation: the page sits in a sidebar entry of its own at the end
  ("Operator"), not inside the Overview group. The Overview group is its own
  page and has no leaves; giving it one would have turned it into an
  expandable group and moved the landing page of the extension.
- Implementation notes: the operator's namespace is rarely in the namespace
  filter of the host, so the page asks the API server once for the
  deployments with the operator's label in every namespace, and when that is
  refused it tries the namespaces an installation usually picks
  (`cnpg-system`, `openshift-operators`, `operators`) and says that it
  narrowed the search. The objects of that namespace are then loaded by name
  of namespace and watched like any other. The leader is the lease of that
  namespace held by one of the operator's own pods, so the page does not
  depend on the lease name. The configuration shown is the ConfigMap only;
  the Secret is a link. The pace of reconciles and errors needs two readings
  and is left blank across a restart of the operator (counters that went
  back). The clusters of a plugin are the ones of the selected namespaces, and
  the row says so when there are none. `getOperatorMetrics` is the fourth and
  last read endpoint of the pod proxy client.
- Seen live on the E2E cluster (operator 1.30.0 from the release manifest):
  Running 1/1, version 1.30.0, the leader with its lease, "All namespaces", no
  ConfigMap (the defaults), the reconcile table with eight controllers, the
  Barman Cloud plugin with the clusters that loaded it, the twelve kinds with
  their views. Covered by unit tests only: several operators, a rollout, an
  operator that is down, a ConfigMap with a watch scope, the narrowed
  discovery, a plugin whose deployment is down.
