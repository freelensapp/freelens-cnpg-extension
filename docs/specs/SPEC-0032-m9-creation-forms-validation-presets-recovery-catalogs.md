# SPEC-0032: Creation forms: server validation, parameter presets, recovery from an object store, image catalogs

- **Status:** Implemented
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1` (Barman Cloud plugin `v0.15.1`)
- **Author / date:** freelensapp core team, 2026-10-28
- **Issue:** #97

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

- **Where the answer shows.** The API server's answer is one line under the YAML pane (it is about that
  YAML, and stays in sight however far the form scrolls), not under each input: a refusal lists every
  cause with the field of the form in words and the path the server named
  (`PostgreSQL parameters (spec.postgresql.parameters.min_wal_size)`), and its first cause is the
  reason OK is disabled. The webhook's message is shown verbatim (CNPG 1.30.1 writes "Invalid vale").
- **When it runs.** Only once the inline checks pass (nothing is sent for a form that still says what is
  missing), 500 ms after the YAML stops changing; an answer about an older YAML is dropped and OK stays
  off until the YAML of the moment is answered. 400, 409 and 422 refuse; 401, 403, no answer and any
  other code leave the form "not checked", said in the line, and do not block.
- **A name taken.** SPEC-0025 F5 stays for the list read on open (a warning, since the list may be
  stale); the dry run's `409 AlreadyExists` is the API server's own word and now blocks, attributed to
  Name. The E2E of SPEC-0025 was updated accordingly.
- **Presets.** General purpose, write heavy, analytics, small development. Sized on the memory request,
  else the limit, else an assumed 1GB (the hint says so), and also on the WAL disk (the WAL volume,
  else the data volume): `max_wal_size` takes at most a quarter of it, so a preset never fills a small
  volume, and `min_wal_size` stays below it and at 32MB or more. `checkpoint_completion_target` is left
  out (0.9 is already PostgreSQL's default); write heavy adds `checkpoint_timeout`, analytics
  `default_statistics_target`. "None" removes the preset's rows the user left alone; a switch replaces
  them; the user's own rows are never touched. A unit test runs every preset over memory and disk sizes
  through the form's own key and value checks.
- **Recovery.** The image comes from the referring cluster's `imageCatalogRef`, else `imageName`, else
  `status.image` (a recovery needs the same major); the volumes and their classes too. A server with no
  cluster (a deleted one) gets the recovery fields only. The target time is the existing field of
  SPEC-0025, left empty (the end of the archive). WAL archiving of the new cluster is left unset: the
  plugin refuses to archive into a server that already holds WAL, so the user picks a store or another
  server name. The E2E recovers `e2e-actions` from `actions-store` (the store of the write namespace)
  and finds a row written after the last backup, which only the archived WAL carries.
- **Catalogs.** The CRD allows 1 to 8 images and majors of 10 or more (not just "positive"); both are
  checked inline. A tag whose version is another major than the row's only warns: the API server does
  not check it, and a cluster asking for that major would run the other one.
- **E2E noise.** Chromium logs every refused dry run as a console error; the session lets through only
  400, 409 and 422 on `?dryRun=All` creates of the CNPG group.
