# SPEC-0032: Creation forms: server validation, parameter presets, recovery from an object store, image catalogs

- **Status:** Draft
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1` (Barman Cloud plugin `v0.15.1`)
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

Every creation form tells the user what the API server will say before the object exists; Create
Cluster offers a sound starting set of PostgreSQL parameters; a cluster is recovered from an object
store's recovery window in one click; image catalogs are created like everything else.

## Upstream reference

- Kubernetes server-side dry run: `?dryRun=All` on the create request runs admission (the CNPG
  webhooks included) and persists nothing; it needs the same `create` permission.
- CNPG: `Cluster.spec.postgresql.parameters`, the parameters the operator fixes and refuses
  (documented list of fixed parameters), `spec.bootstrap.recovery` with a plugin source
  (`externalClusters[].plugin` of `barman-cloud.cloudnative-pg.io` with `barmanObjectName` and
  `serverName`); `ImageCatalog` (namespaced) and `ClusterImageCatalog` (cluster-scoped),
  `spec.images[]` of `{ major, image }`, majors unique.
- Other UIs: the Headlamp plugin validates Create Cluster with a dry run, offers parameter presets and
  a Recover button in the ObjectStore recovery window. Functional reference only (AGENTS.md): our
  presets and texts are our own.

## Scope

Included: dry-run validation in all the forms of SPEC-0025 to SPEC-0029 and the new ones;
presets in Create Cluster; "Recover into a new cluster" on each server of an ObjectStore's recovery
windows; Create ImageCatalog and Create ClusterImageCatalog.

Excluded: editing existing objects (the host's editor), cloning a running cluster with
`pg_basebackup` (a later spec if wanted).

## Design

### Server validation

- The form's machinery (SPEC-0025) sends the object it shows with `dryRun=All` before enabling the
  submit, again whenever the YAML changes (debounced), through the same client as the create.
- The result is one of: valid; refused with the API server's message, mapped to the field of the
  form when the message names a path, else above the YAML; not checked (no permission, offline),
  which does not block the submit and says so.
- The inline checks of SPEC-0025 stay: they answer at once and offline; the dry run is the last word.

### Parameter presets (Create Cluster)

- A select above the parameters list: "None" (default), and a few presets of our own, each with one
  line on what it is for (for example general purpose, write heavy, analytics, small development).
- A preset fills `postgresql.parameters` with values computed from the memory request of the form
  (`shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, WAL and checkpoint
  sizes), every value editable afterwards; never a parameter the operator fixes or refuses.
- Changing the memory request recomputes a preset's values only while the user has not edited them.

### Recover into a new cluster (ObjectStore drawer)

- On each server row of the recovery windows (SPEC-0009): "Recover into a new cluster", enabled when
  a first recoverability point exists.
- It opens Create Cluster with: bootstrap by recovery from this object store and server, the
  external cluster entry, the PostgreSQL major and image of the referring cluster when there is one,
  its storage size, a free name (`<server>-recovered`), the same namespace, and an optional target
  time between the first recoverability point and the last backup.

### Image catalogs

- Create ImageCatalog (namespace) and Create ClusterImageCatalog: rows of PostgreSQL major and image;
  majors unique and positive, image references well formed; the YAML pane and the dry run as in
  every form.

### Safety

The dry run writes nothing. Creates follow SPEC-0025 (the form is the confirmation, the exact YAML in
view, read-back test).

## Tests (non-regression list)

- Unit: the mapping of admission messages to fields; the preset values for a few memory sizes, none
  of them a fixed parameter; the recovery pre-fill from an ObjectStore, a server and a referring
  cluster; the image catalog validation.
- E2E: a Create Cluster with a value the webhook refuses shows the webhook's message before the
  submit and creates nothing; a valid form validates; "Recover into a new cluster" from
  `e2e-store` creates a cluster that reaches healthy with the fixture's marker table; Create
  ImageCatalog and ClusterImageCatalog create objects read back from the cluster.

## Notes and deviations

Filled during implementation.
