# SPEC-0039: Links to Grafana dashboards

- **Status:** Done
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

- Implemented on 2026-10-29 with the port to Freelens v2 (SPEC-0030): `common/preferences-store.ts`,
  `grafana.ts` (pure), `grafana-link.tsx`, `preferences/grafana-preferences.tsx`.
- **The preferences** are the extension's tab of the host's preferences (`appPreferences`), one row per
  Kubernetes cluster of the catalog, keyed by its catalog id. The store is a `Common.Store.ExtensionStore`
  loaded in both processes, as the template does: main keeps the file in the profile
  (`extension-store/@freelensapp/cnpg-extension/cnpg-preferences-store.json`), and this is the first thing
  main does for the extension. Its model is a plain reference replaced on every change: the host clones
  it to send it to main, and a deep observable failed to clone ("An object could not be cloned", found
  by the E2E case).
- **The dashboard** is the CloudNativePG dashboard of `cloudnative-pg/grafana-dashboards`
  (`charts/cluster`, UID `cloudnative-pg`, variables `namespace` and `cluster`); a team's own UID can be
  set per cluster.
- **The URL** is checked: http or https, no credentials, no query or fragment; a wrong one says why and
  gives no link. The range follows the Trends of the Live View (5 min, 15 min, 1 h, or since the view
  opened as a fixed start); the drawer uses the last hour.
- **Placement.** The drawer shows "Monitoring: Open in Grafana" only when a URL is set. The Live View puts
  the link next to the range of its Trends, and without a URL says where to set it; that link opens the
  extension's preferences (`navigateToPreferences`, from the cluster frame).
- The E2E case reads the link and never follows it: it would open the browser of the machine. Its URL is
  under `.invalid`, and the case clears the preference afterwards.
