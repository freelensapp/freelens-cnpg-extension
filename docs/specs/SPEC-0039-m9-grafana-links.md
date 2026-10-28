# SPEC-0039: Links to Grafana dashboards

- **Status:** Approved
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

Where the live view stops (history beyond the session, dashboards a team shares), one click opens the
team's Grafana on the CloudNativePG dashboard of this cluster.

## Upstream reference

The CloudNativePG Grafana dashboard (grafana-dashboards repository of the project) with its variables
for namespace and cluster; Prometheus with the operator's `PodMonitor`.

## Scope

Included: a Grafana URL per Kubernetes cluster in the extension's preferences, a dashboard UID, and an
"Open in Grafana" link in the cluster drawer and the live view. Excluded: embedding Grafana, reading
Prometheus.

## Design

- Preferences (the extension's preferences page): per Kubernetes cluster of the catalog, the Grafana
  base URL and the dashboard UID (default the upstream dashboard's UID), stored in the extension's
  store, no credentials.
- The link adds `var-namespace`, `var-cluster` and the time range of the live view; it opens in the
  browser (the host opens `window.open` targets externally). Without a URL, the link is not shown and
  the live view says where to set it.

### Safety

No request to Grafana from the extension; only a link.

## Tests (non-regression list)

- Unit: the URL built from preferences, namespace, cluster and range.
- E2E: with a URL set in the preferences, the drawer of `e2e-main` shows the link with the expected
  URL (the opening of the browser is not tested).

## Notes and deviations

Filled during implementation.
