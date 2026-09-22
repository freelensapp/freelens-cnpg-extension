# UI/UX design directives

Binding for every contributor, human or agent, like
[PROCESS.md](PROCESS.md). These directives encode three commitments:

1. **Native-first.** The extension must feel like a part of Freelens, not
   a website embedded in it. Freelens core and the most mature freelensapp
   extensions define the patterns; this file names the canonical ones and
   forbids the known deviations. When a core component exists, custom code
   is not an alternative.
2. **Desktop-grade experience.** Freelens is an Electron desktop app used
   daily by operators. Views are optimized for scanability (state visible
   at a glance), keyboard and mouse ergonomics, perceived performance, and
   correctness on both dark and light themes at any window size.
3. **The best possible view for the task.** The standard Freelens
   vocabulary (list page plus detail drawer) is the model for Kubernetes
   resources, not the ceiling of the extension. Where a list cannot carry
   the task (a health overview, a replication topology, a timeline, live
   data), the extension designs an ad hoc view, held to the same rules on
   theme, states and native primitives (section 12).

Sources surveyed for these rules: Freelens core (`packages/core`,
`packages/ui-components`), freelens-fluxcd-extension (the reference
implementation for list pages), freelens-kubeswift-extension (the reference
implementation for these directives, specs and E2E), gateway-api,
resource-map, sveltos, kamaji, karpenter (the reference for ad hoc
dashboards), agentbridge. File references below point into those
repositories.

## 1. List pages

- Every list page uses `Renderer.Component.KubeObjectListLayout`. Custom
  tables at page level are forbidden.
- Canonical file shape (see fluxcd `pages/kustomize/kustomizations-v1.tsx`
  and kubeswift `pages/swiftguests-page-v1alpha1.tsx`):
  1. destructured `Renderer.Component` imports at module top;
  2. `const KubeObject = X; type KubeObject = X;` alias so the body stays
     version-agnostic;
  3. module-scope `sortingCallbacks`;
  4. `renderTableHeader` typed as
     `{ title: string; sortBy: keyof typeof sortingCallbacks; className?: string }[]`
     so a header cannot reference a missing sort callback;
  5. the layout call with a `tableId` derived from `KubeObject.crd.plural`,
     plus `store`, `sortingCallbacks`, `searchFilters`,
     `renderHeaderTitle`, `renderTableHeader`, `renderTableContents`.
- **Column grammar** (fixed order, no deviations):
  `Name | Namespace | <domain columns> | Condition | Status | Age`.
  - Name: `<WithTooltip>{object.getName()}</WithTooltip>`, no link (the
    row click opens the drawer).
  - Namespace: `<NamespaceSelectBadge namespace={...} />` (clickable
    namespace filter, the core idiom), not plain text.
  - Age: `<KubeObjectAge object={object} key="age" />`, sorting callback
    on `getCreationTimestamp()`.
  - Domain columns carry the resource's day-to-day operational fields
    (instances, primary, WAL archiving, last backup, method, phase...),
    most important first.
- `searchFilters` is always `[(object) => object.getSearchFields()]`;
  extend it only when a column shows data not covered by the search
  fields.
- Give every non-default column a `className`; the header class is copied
  onto body cells automatically (`copyClassNameFromHeadCells`), so column
  widths are styled once as `.page :global(.TableCell).<name>`.
- Cells are single-line: the list is virtualized with a fixed row height,
  multi-line content breaks row measurement. Long values get truncation
  plus `WithTooltip`, never wrapping.
- Every cell in `renderTableContents` gets a React `key` (all of them,
  not just some).
- Missing values render as `"N/A"` in lists.
- **`tableId` collisions.** Core persists sort preferences under a
  globally keyed `table_settings` map shared by itself and every
  extension. A `tableId` derived from a plural another extension could
  plausibly pick (`clusters`, `backups`, `databases`) is written as a
  qualified literal instead (`cnpgClustersTable`). Only the id changes;
  the menu title and the page header still come from `crd.title`.

## 2. Status semantics

- Each CRD family has a **pure, unit-tested status classifier** module
  (model: fluxcd `components/status-conditions.ts` + test): functions
  from the object/conditions to a small closed set of display states
  (for example `Healthy | Progressing | Degraded | Failed | Hibernated |
  Unknown`), with no JSX and no colors inside. For CloudNativePG the
  classifier reads `status.phase` (a closed set of 22 known strings, see
  SPEC-0001), the `Ready`, `ContinuousArchiving` and `LastBackupSucceeded`
  conditions, `readyInstances` versus `instances`, and the hibernation and
  fencing annotations; an unknown phase string maps to `Unknown`, never
  to a guess.
- Lists show state in **two columns**: `Condition` renders
  `<Badge className={conditionClass} label={conditionText} />` (short
  scannable word), `Status` renders the raw phase or condition message
  truncated with `WithTooltip`. Both sortable.
- Colors are never authored by the extension. The classifier maps states
  to the host's global classes `success | warning | error | info`
  (defined in core `app.scss` on top of `--colorSuccess` etc.), or, for
  custom elements, to the semantic theme tokens:

  | Meaning | Token |
  | --- | --- |
  | healthy / running / ready | `--colorOk` |
  | completed / succeeded | `--colorSuccess` |
  | pending / waiting / in progress | `--colorWarning` |
  | failed / error | `--colorError` |
  | terminated / terminating / hibernated / fenced | `--colorTerminated` |
  | informational / neutral | `--colorInfo` |
  | unknown | `--colorVague` |

  This mirrors core's `workloads-mixins.scss`, the canonical status
  color map extensions must not contradict.
- Boolean facts use `<BadgeBoolean />`. Prefer positive phrasing so green
  means healthy ("Archiving" rather than "Archive failing").
- `StatusBrick` is reserved for dense per-unit galleries (one brick per
  instance in a cluster row is the intended use), following core's
  container-column encoding.
- **Deprecated forms are labelled.** Where the API still accepts a
  deprecated shape (the in-tree `barmanObjectStore` backup method, the
  deprecated status backup timestamps), the view shows the value with a
  "deprecated" badge and a tooltip naming the replacement. The
  extension never generates a deprecated shape.

## 3. Detail drawers

- Registered via `kubeObjectDetailItems`; the component renders content
  only (the host draws the title bar, toolbar, and close affordance).
- Structure, in order: guard clauses (`!object` and wrong-class check),
  then `DrawerTitle` sections with `DrawerItem` rows, then related-object
  tables, then large blobs.
- `DrawerItem` conventions: `hidden={!value}` for optional rows instead
  of JSX conditionals; `labelsOnly` when the children are `Badge`s;
  values that must show as absent use `"N/A"`.
- **Do not re-render what the host already renders.** Metadata
  (`KubeObjectMeta`) is added by the host at the top of every drawer, and
  the generic custom-resource item may already include the conditions
  table; before adding a `KubeObjectConditionsDrawer`, verify in a real
  Freelens that conditions are not shown twice.
- **The host's printer-column block is accepted duplication.** Freelens
  core injects a generic `.CustomResourceDetails` section into every CR
  drawer, one plain-text row per `additionalPrinterColumns` entry, above
  the extension's content, with no hook to suppress or reformat it. Build
  the full enriched section, do not trim rows to dodge a host
  printer-column row, and never hide the host block with CSS.
- References to other objects are links, never plain text:
  `LinkToNamespace`, `LinkToNode`, `LinkToPod`, `LinkToSecret`,
  `LinkToService`... for well-known kinds, `LinkToObject` for arbitrary
  refs, and `MaybeLink` + a URL helper that returns `""` for unresolvable
  refs so they degrade to text instead of dead links. Always
  `stopPropagation` on link clicks. A CloudNativePG cluster drawer links
  to its instance pods, PVCs, services (`-rw`, `-ro`, `-r`), secrets
  (app, superuser when present, CA and TLS) and, when present, its
  poolers, scheduled backups and object store.
- A reference is linked only when the target is actually in its store;
  otherwise the row degrades to `WithTooltip` plain text. The stores
  behind those checks are filled by a reference loader that asks for the
  namespaces the references live in, retries and watches, never by an
  ad hoc one-shot `loadAll()` in the component.
- Repeated sub-objects (instances, replication slots, certificates,
  tablespaces) either render as a nested core `Table`
  (`sortSyncWithUrl={false}`, `scrollable={false}`) or as self-guarding
  section components that return `null` when their data is absent.
- Timestamps: `LocaleDate` for absolute dates (honors the user's timezone
  preference; never `toLocaleString()`), `ReactiveDuration` /
  `KubeObjectAge` for ages. Values that arrive in a non standard layout
  (the Go `time.String()` of certificate expirations) are parsed by a
  tested helper before they reach a date component.
- YAML or JSON blobs use a read-only `MonacoEditor` with a clamped
  initial height and `scrollbar.alwaysConsumeMouseWheel: false` so page
  scrolling is not trapped.

## 4. Navigation and sidebar

- One root menu entry "CloudNativePG" with an icon; group parents and
  leaves below it are text-only (`components: {}`), mirroring core's
  sidebar (icon on "Workloads", none on "Pods").
- **Two-level grouping is the standard**: the root's children are a few
  domain groups (Overview, Clusters, Backups, Pooling and Images,
  Databases, Operations; later milestones add their own), each with a
  `target` pointing at its first leaf, and the resource pages hang under
  the groups. Never flatten all resources directly under the root once a
  milestone brings the count past a handful.
- **One menu leaf per resource, not per API version.** Version selection
  happens inside the page (probe the store per version, newest first,
  and fall back).
- Icons are original monochrome SVGs (never copied), square
  `viewBox="0 0 24 24"`, no hardcoded `fill`/`stroke` (the host applies
  `fill: currentColor`), imported with `?raw` and passed to
  `Renderer.Component.Icon` via `svg=`. No `<img>` icons, no
  `filter: invert()` hacks (they break the light theme).
- Titles come from the model: the `crd` static block (`title`, `plural`)
  is the single source of truth feeding the menu title, the page header
  and the `tableId` (with the collision rule of section 1).
- Navigation display names are humanized Title Case with spaces
  ("Scheduled Backups", "Image Catalogs"). **When the humanized kind
  would collide with a name the host already uses in the same sidebar
  (`Cluster`, `Database`, `Event`, `Service`...), the title is qualified
  with the resource's own domain word, not left ambiguous**: the
  `postgresql.cnpg.io` `Cluster` is titled "PostgreSQL Clusters", because
  core registers a root sidebar item titled exactly "Cluster". The kind
  stays technical everywhere it is a kind (drawer titles `Kind: name`).

## 5. Theming

- **No hardcoded colors anywhere** (SCSS, TSX, inline styles, SVG, chart
  datasets). Semantic colors use the tokens from section 2; text and
  chrome use `--textColorPrimary/Secondary/Tertiary`, `--borderColor`,
  `--borderFaintColor`, `--contentColor`, `--layoutBackground`, etc.
- Derived accents (tinted backgrounds, borders, pills) are computed from
  tokens with `color-mix(in srgb, var(--colorInfo) 20%, transparent)`,
  never authored as hex.
- When a `var()` fallback is unavoidable, it is theme-neutral
  (`rgba(127, 127, 127, 0.25)`), never a dark-only or light-only hex.
- Spacing and typography use the host scale: `--unit` (8px) and
  multiples, `--border-radius`, `--font-size-*`; the local `vars.scss`
  only aliases that scale.
- Every view must be checked on **both themes** before a PR is opened
  (switch in Freelens preferences); the milestone review does the same.

## 6. States: loading, empty, error, absent

Every page, and every card of an ad hoc view separately, handles four
non-happy states, none of which may render a blank area:

- **Loading**: the layout's spinner is enough for lists; custom pages and
  cards show a skeleton, never a flash of empty content.
- **Empty list**: delegated to `KubeObjectListLayout` (`NoItems`); an
  empty card says what would fill it.
- **Render error**: every page and details component is wrapped in
  `withErrorPage` so a throw renders a readable error, not a blank
  drawer.
- **CRDs not installed / operator absent / version drift**: the page
  probes the store and renders an explanatory panel (which CRDs are
  missing, which API versions were tried, whether the operator deployment
  exists) with a link to the docs. Tri-state logic
  (`unknown | absent | present`) so "still probing" is not rendered as
  "not installed".
- **Live data unreachable** (pod proxy denied, instance not ready, TLS
  mismatch): the card names the mechanism that failed and the permission
  it needs (`pods/proxy`), and the rest of the page stays usable.

## 7. Interaction and performance

- Row click opens the drawer; links inside rows and drawers call
  `stopPropagation` so navigation never fights selection.
- Keep the UI responsive: no work in render paths, MobX `observer` on
  every component that reads stores, virtualized lists untouched (do not
  disable `virtual`).
- Tooltips (`WithTooltip`, `Icon tooltip=`) carry the full value or the
  explanation; nothing important lives only in a tooltip.
- Live data is polled at a declared interval shown in the panel, with
  a manual refresh, and stops when the panel is not visible.
- Destructive or state-changing actions (from M6 on) go through
  `ConfirmDialog.open({ ok })` and notify outcomes via `Notifications`;
  buttons disable while an operation is in flight. Section 13 states the
  full rules for every write.
- Respect platform conventions Freelens already implements (menus,
  shortcuts, scrolling); the extension adds no global key bindings that
  could shadow the host's.

## 8. SCSS rules

- CSS Modules only (`*.module.scss` + generated `*.module.d.scss.ts`),
  one module per component, plus the `?inline` + `<style>` injection
  idiom required by the v1 extension API. When the project migrates to
  the v2 API, the injection idiom is removed (v2 auto-injects the built
  CSS); track it in the migration, do not mix styles of the two eras.
- Page modules contain column sizing almost exclusively, as
  `.page { :global(.TableCell) { &.<column> { flex-grow: ...; } } }`.
  Host class selectors must be wrapped in `:global()` (without it the
  class name is hashed and the rule is dead code).
- Width scale reference (from fluxcd): `age 0.3`, `condition 0.7`,
  `status 1.5`, boolean columns `0.5`, URLs/revisions `1.3-1.5`.
- Inline `style={{}}` is allowed only for one-off computed values (a bar
  width percentage), never for static styling.
- Do not override host chrome (`.TabLayout`, `.Tabs`, global element
  rules): extensions style their own subtree only.

## 9. Forbidden (summary)

- Custom tables where `KubeObjectListLayout` fits; pages without drawer
  integration.
- Hardcoded colors of any kind; dark-only fallbacks; PNG/`<img>` icons;
  `filter: invert()`; a palette module of the extension's own.
- Inline-style systems (recipes duplicated across call sites) and global
  CSS leaks (unscoped host selectors, missing `:global()`).
- `(object as any)` chains: type the CRD instead (see AGENTS.md for the
  static-properties rule).
- Copy-paste identifiers from template repos; dead files in `src/`;
  duplicated menu ids across API versions.
- Copying anything (code, CSS, strings, mapping logic) from other
  CloudNativePG user interfaces or tools (see ARCHITECTURE.md); they are
  functional references only.
- Showing a deprecated CloudNativePG shape as if it were current, or
  generating one.

## 10. Enforcement

- Every spec's Design section states whether each view is standard or ad
  hoc and why, describes columns, status mapping, drawer sections (or the
  card grid and the data source of every card), and the non-happy
  states, and declares any deviation from this file (which requires
  updating this file in the same PR or dropping the deviation).
- Every UI PR states in its description: themes checked (dark and
  light), states checked (loading, empty, error, absent, live data
  unreachable), and includes a screenshot from the live verification
  (TESTING.md).
- The milestone manual review gate (PROCESS.md) walks every view on a
  real Freelens and asks of each "is this the best possible view for the
  task?".

## 11. Known gaps against these directives (retrofit backlog)

None yet: this file precedes the first view. Entries are added here when
a review finds a view that violates a directive and the fix is deferred.

## 12. Ad hoc views

Binding for every overview, topology, timeline and live panel. These are
the views that make the extension more than a resource browser, and they
are held to the same discipline as the standard ones.

- **When.** A task is served by an ad hoc view when a list cannot carry
  it: an aggregated picture of a domain (the health of every PostgreSQL
  cluster at a glance), relationships and topologies (primary and
  replicas, streaming and synchronous replication), sequences in time
  (backups, switchovers, phase changes, events), live data that lives in
  no CRD (sessions, replication lag, database sizes, WAL), and drill-down
  from a summary to the objects behind it.
- **Where.** An ad hoc view is a `clusterPages` entry rendered inside the
  host's `TabLayout`, or a section of a detail drawer. Lists inside it
  stay `KubeObjectListLayout`.
- **Primitives.** Cards use the host components that exist: `PieChart`
  and `BarChart` for charts, `Badge`, `BadgeBoolean`, `Icon`, `Tooltip`,
  `Spinner`, `LinkTo*`, `Table`. Custom components are written only for
  what the host has no primitive for (a replication topology, a timeline,
  a tile grid), as SVG or DOM with the theme tokens, never with a chart
  library of their own unless a spec argues for it.
- **Every tile and every mark is a door.** A count opens the filtered
  list, a cluster name opens its drawer, a point on a timeline opens the
  object it stands for. A dashboard is an entry point, not a dead end.
- **Desktop density.** More information per screen than a web page
  would dare, readable text, no scrolling inside a card, a grid that
  degrades to fewer columns on a narrow window instead of overflowing.
- **Reactive.** Data comes from MobX stores where a store exists, or
  from a polling loop with a declared interval visible in the panel and
  a manual refresh; skeletons at first load, never a flash of empty.
- **Non-happy states per card** (section 6), so one unreachable instance
  never blanks the whole overview.
- **Both themes, zero authored colors** (section 5). Series colors in
  charts come from the semantic tokens and from the host's chart
  defaults, never from a palette of the extension's own.
- **Logic in pure functions.** Aggregations, classifiers, topology
  layout and timeline bucketing are pure, unit-tested modules; the
  component is a thin shell over them.
- **Numbers are exact somewhere.** Every rounded or humanized figure has
  the exact value in a tooltip; every gauge has its unit.
- **Keyboard.** Grouping, filter and refresh controls are reachable and
  operable from the keyboard.
- **Declared in the spec.** The Design section describes the grid
  (rows, cards, content, what each click leads to) and the data source of
  every card, and states why this view beats a list for the task.

## 13. Write actions

Binding from M6 on, for every action, form and dialog that changes
anything in a cluster. Sections 1 to 12 describe surfaces that read; this
one describes surfaces that write, and it is stricter because a misread
view is a nuisance while a mistaken write on a production database is an
outage.

- A write is offered only where its guard says it is meaningful, and the
  guard's reason is shown where the control is disabled (row menu,
  drawer toolbar and the drawer's own row), never as a silent absence.
- Every write goes through `ConfirmDialog.open({ ok })`: the dialog names
  the CloudNativePG cluster, its namespace and the Kubernetes context,
  and enumerates the exact writes it will perform (which object, which
  field or annotation, which value), so that the user reads what the
  extension is about to do, not a euphemism for it.
- No optimistic UI: the view changes when the cluster says it changed.
  While the write is in flight the dialog's OK button stays in the host's
  `waiting` state and no second submit is possible.
- Failures are reported with the API server's message in a
  `Notifications` error and never swallowed; a 409 conflict is retried
  only while the write the user read is still the write that would be
  sent, otherwise the dialog reopens with the new facts and the values
  intact.
- Patch types are explicit: a JSON merge patch with a spelled out body,
  carrying `metadata.resourceVersion` when the new value was computed from
  the old one and whenever the status subresource is the target. A JSON
  patch is not used: a failed `test` answers `422` with a sentence that
  tells the user nothing, where a stale resource version answers `409`
  with a clear one (spike S1 of SPEC-0020). Each write case in the E2E
  suite reads the result back from the cluster with `kubectl`.
- The psql terminal is not a write action of the extension: it composes
  a command line for the host's terminal and issues no API call, so it
  carries no confirmation dialog but a tooltip that states it connects as
  the `postgres` superuser.
- Actions that interrupt the primary, take instances down or lose data
  (switchover, restart of a cluster or of its primary, fencing,
  hibernation, delete) additionally require the user to type the cluster
  name in the dialog. The actions that bring things back (lift a fence,
  resume) confirm with one click.
- The full rules, W1 to W12, are in
  [SPEC-0020](../specs/SPEC-0020-m6-write-actions-ground-rules-and-backup-now.md).

## 14. Creation forms

Binding from M7 on, for every form that creates an object. A form is a
write (section 13 applies) that needs input first, so it has rules of its
own on top of the write rules.

- **The form is the confirmation.** One dialog per kind, through
  `ConfirmDialog.open({ ok })` with the machinery of the action dialogs:
  the fields in reading order on the left, the YAML of the exact body the
  create will send on the right (a read only `MonacoEditor` with a copy
  button, for those who commit it to git instead), the write summary of
  section 13 under the fields. Nothing is stacked on top of a form: no
  second confirmation, no nested dialog (a missing object store is a door
  to its page, not a form inside the form).
- **Width, the one declared deviation.** The host's confirmation box stops
  at half the window: a creation dialog widens it, only while it holds a
  form (`:has`), to `min(1100px, 90vw)`, and stacks its panes under
  900 px. The box is white in both themes, so the form carries its own
  ink, like every dialog of the extension.
- **Validation before the submit.** Every rule of the operator's admission
  the form can express is enforced inline, with the reason at the field,
  before the submit; the OK button carries the verb and is disabled with
  the first reason in reading order, never mute. What the API server
  refuses anyway comes back at the top of the reopened form, values kept,
  in the API server's own words (rule W9).
- **Effective values, never sent.** A value the API server or the operator
  stamps when a field is left out is shown next to the control ("Left
  empty: unsupervised") and is not in the YAML: the pane shows only what
  the user decided.
- **The recommended shape is the default and no deprecated field is ever
  generated** (the in-tree `barmanObjectStore`, `backup.retentionPolicy`,
  the legacy synchronous pair, `enablePodMonitor`).
- **Pickers never block a name.** A reference is a picker over what a
  read on open found (the host's stores for secrets, storage classes and
  namespaces, the extension's for its kinds), degrading to a text input
  when the read failed or found nothing, with "Type a name..." always
  offered; a name the read did not see warns and never blocks, a
  collision with the store warns and never blocks (the store may be
  partial).
- **Names.** A Kubernetes name is checked as the API server checks it, and
  as the operator derives things from it: a cluster name is a DNS label of
  50 characters at most because it prefixes pods, services and secrets.
- **Immutable fields say so** in their hint, and a section that the
  operator reads once (the bootstrap of a cluster) says that too.
- **Access.** The `create` verb is asked as in W3 when the form opens; a
  denial disables OK with the verb and the resource in the reason, and the
  form stays readable so the YAML can still be copied.
- **Native controls on the white box.** Radios and checkboxes are native
  inputs with the host's accent color and one sentence per option: the
  host's `RadioGroup` takes its radios as direct children and cannot carry
  a line each, and the host's `Button` paints itself for a dark surface.
- **Tests.** Every rule, every message and every body is a unit case of
  the pure module of the kind; every form has an E2E case that fills it in
  the real Freelens, compares the YAML pane with the body, creates the
  object in the write namespace, reads it back with `kubectl` and deletes
  it; the pre-review pass opens every form on both themes, filled, and
  closes it without creating.
- The full rules, F1 to F14, are in
  [SPEC-0025](../specs/SPEC-0025-m7-creation-forms-ground-rules-and-create-cluster.md).
