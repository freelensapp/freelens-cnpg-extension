# SPEC-0004: Overview page (ad hoc)

- **Status:** Implemented
- **Milestone:** `M1` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-18

## Goal

The first thing an operator sees under "CloudNativePG" answers, in one
screen and without scrolling on a laptop, "are my PostgreSQL clusters fine,
and if not, which one and why": every cluster as a tile with its health,
instances, primary, archiving, last backup and certificate horizon, a summary
strip on top, and a click on anything that leads to the list or to the
drawer behind it.

## Upstream reference

- The mental model of `kubectl cnpg status` run on every cluster in turn,
  which is what operators do today.
- The Overview page of freelens-karpenter-extension (MIT, the reference for
  an ad hoc dashboard inside Freelens: tiles, host `PieChart`, drill-down).
- Other CloudNativePG user interfaces show a per-cluster traffic light;
  none of them shows the fleet of clusters of a Kubernetes cluster on one
  screen with backups and certificates. Functional reference only.

## Scope

Included: the Overview page, its summary strip, the cluster tiles, the
navigation from every element, the pure aggregation module and its tests.
Excluded: metrics and charts over time (M7), the live view (SPEC-0006),
anything cross-cluster in the Freelens sense (one Kubernetes cluster at a
time, like every page).

## Design

### Standard or ad hoc view, and why

Ad hoc (DESIGN.md section 12). A list can show one row per cluster, but it
cannot show the reason of a Degraded cluster, the backup horizon and the
certificate horizon of every cluster at once, nor rank them by urgency. The
Overview is the entry point; the list (SPEC-0003) is where the same facts
become sortable columns, and the drawer is where they become complete.

### Placement

Group "Overview" with the leaf "Overview" as the first child of the
"CloudNativePG" root, so it is what the root's target opens. Page id
`cnpg-overview`. Rendered inside the host `TabLayout`.

### Data

Only what the stores already hold: the `Cluster` store, the `Backup` store
(for backup facts, SPEC-0001 H3), the `Pod` store (instance readiness as a
cross-check) and the `ScheduledBackup` store (next scheduled backup per
cluster). No live data: the overview must be instant and must work with
`pods/proxy` denied. Everything is derived by
`src/renderer/components/overview-model.ts`, a pure module:

- `summarize(clusters, backups, schedules, now)` returns the strip counters
  (clusters by health state, instances ready over total, clusters with
  archiving failing, clusters without a successful backup in the last 24
  hours or ever, certificates expiring within 30 days or expired) and the
  ordered tiles.
- Tiles are ordered by urgency: Failed, Degraded, Progressing, Unknown,
  Healthy, Hibernated, then by namespace and name; the order is stable and
  tested.

### Layout

1. **Summary strip** (one row of stat tiles): Clusters (total, with a host
   `PieChart` of the health states), Instances (ready/total), Archiving
   failing (count), Backups overdue (count), Certificates expiring
   (count), Operator (version from the operator deployment when visible,
   else "unknown"). Each tile is a button: Clusters opens the list; the
   others open the list filtered by the corresponding state through the
   page's search filter (the list registers `searchFilters` on the health
   words, so "Degraded" as a search term filters the list).
2. **Cluster tiles** (responsive grid, 3 columns on a wide window, 2, then
   1): header with the namespace badge, the name and the condition
   `Badge`; body with four facts on two lines: instances (`StatusBrick` per
   instance, primary marked, fenced dimmed), primary name, archiving
   (`BadgeBoolean`), last successful backup as a relative time with the
   exact time in a tooltip; footer with the certificate horizon ("certs
   ok until the earliest expiry date" or "cert expires in N days" in
   warning, or "cert expired" in error) and the next scheduled backup when a schedule exists.
   A Degraded or Failed tile shows its reason sentence below the header.
   The whole tile opens the cluster drawer (through the list page with the
   object selected); the namespace badge sets the namespace filter.
3. **Empty and absent states**: no CRD, the same explanatory panel as the
   list; CRD present but no clusters, a panel that says so and links to
   the CloudNativePG quickstart; stores still loading, a skeleton strip and
   three skeleton tiles, never a blank page.

### Components

`src/renderer/pages/overview-page.tsx` (thin, `observer`,
`withErrorPage`), `src/renderer/components/overview/stat-tile.tsx`,
`cluster-tile.tsx`, `tile-grid.module.scss`. Host primitives only:
`PieChart`, `Badge`, `BadgeBoolean`, `StatusBrick`, `Icon`, `Tooltip`,
`NamespaceSelectBadge`, `ReactiveDuration`, `LocaleDate`, `Spinner`. Grid
by CSS grid with `--unit` spacing; colors from the semantic tokens through
the health classifier's class names; no chart colors authored (the
`PieChart` data uses the host's status colors by class).

### Desktop density and keyboard

Tiles are compact (about four lines) so that twelve clusters fit a 1440 px
wide window without scrolling; every tile and stat tile is a `button`
element reachable by Tab, activated by Enter; tooltips carry the exact
values behind every rounded or relative figure.

### Themes

Both themes verified by the pre-review pass and the milestone review.

### Safety

Reads only, from stores; no network call of its own.

## Tests (non-regression list)

- Unit: `src/renderer/components/overview-model.test.ts` (counters and
  tile order over fixtures with every health state, backup overdue rules,
  certificate horizon rules, empty inputs).
- Integration: the scaffold's activation case, unchanged.
- E2E (appended to `cnpg-e2e.tests.ts`): the Overview opens from the root
  item; the strip shows 4 clusters with 1 Healthy, 2 Degraded, 1
  Hibernated, instances 4/5 (three of `e2e-main`, one of `e2e-single`,
  none of the hibernated one, the fenced one not ready), archiving failing
  1, certificates expiring 0; the `e2e-single` tile shows the archiving
  reason; clicking the `e2e-main` tile opens its drawer; the pre-review
  pass screenshots the page on both themes.
- Manual verification: the "is this the best possible view" question of
  the milestone review, with the tile density judged on a laptop screen.

## Notes and deviations

- Approved on 2026-09-18 by the lead maintainer together with SPEC-0003.
- The strip has five tiles: Clusters (with the host `PieChart` of the health
  states, colored by reading the theme tokens at render time), Instances
  ready, Archiving failing, Backups overdue, Certificates expiring. The
  "Operator" tile of the plan is deferred to the operator status page of M5:
  the operator deployment lives in another namespace and would have needed
  its own loader for one figure.
- Navigation from the strip: every tile opens the list through
  `extension.navigate` and presets the list search box through the global
  `search` page parameter (the list registers the health words as search
  fields). Clicking a cluster tile opens its drawer with `showDetails`.
- On the E2E cluster the hibernated fixture still declares one instance in
  `status.instances`, so the strip reads 4 of 6 ready instances, not 4 of 5.
- The Pod store cross-check of the plan is not needed: the operator's
  `status.readyInstances` already reflects pod readiness (verified on the
  fenced fixture).
- Merged with #17 on 2026-09-19; the unit, integration and E2E workflows ran
  green on main at `cd337d3`. The manual verification above is part of the
  M1 milestone review: the status moves to Verified when its result (date,
  tester, verdict) is recorded here.
