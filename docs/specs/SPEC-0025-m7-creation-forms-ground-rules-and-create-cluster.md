# SPEC-0025: Creation forms, the ground rules, and the Create Cluster form

- **Status:** Implemented
- **Milestone:** `M7` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-22

## Goal

The extension creates objects. This spec fixes, once for the eight forms of
M7, how a creation is offered, filled, previewed, validated, sent, reported
and tested, ships the machinery they share, and ships the first and largest
form: a PostgreSQL cluster, from the essentials an operator decides to the
exact YAML the API server receives, with the recommended shape as the
default and never a deprecated one.

## Upstream reference

- The `Cluster` resource of `postgresql.cnpg.io/v1` at v1.30.0: the CRD
  schema (`spec.instances` is the only required field; every other field
  has a default in the schema or in the mutating webhook) and the rules of
  the validating webhook, listed in the "Rules the form enforces" section
  below as the recon recorded them.
- The bootstrap methods of the operator (`initdb`, `recovery`,
  `pg_basebackup`), exactly one per cluster, and the plugin based recovery
  through an `externalClusters` entry that names the object store and the
  server name of the source (Barman Cloud plugin v0.15.0).
- The Barman Cloud plugin as a WAL archiver: the entry of `.spec.plugins`
  with `isWALArchiver: true` and the parameter `barmanObjectName`; the
  retention policy lives on the `ObjectStore`, not on the cluster.
- The in-tree `barmanObjectStore` method is deprecated (SPEC-0001 R8): the
  form never generates it, and a form that could is a bug.
- The `kubectl cnpg` plugin has no `create cluster`: the functional
  reference is the documentation's own samples, and the creation form of
  the other graphical interface for CloudNativePG (live YAML preview,
  bootstrap from a backup), as a scope reference only.

## Scope

Included: the ground rules F1 to F14 below, binding for SPEC-0026 and
SPEC-0027; the shared machinery (the creation dialog with its two panes, the
form grammar, the YAML preview and copy, the name and quantity validators,
the pickers over the host's and the extension's stores, the write summary,
the creation client with the `AlreadyExists` path); the Create Cluster form
with the fields listed below; the E2E case that creates a cluster through
the form on the E2E cluster and reads it back; the extension of the
pre-review pass to every form.

Excluded, and where it goes: editing an existing object (the host's own
YAML editor, in the drawer's toolbar, stays the way to edit; M7 creates);
deleting (the host's delete); bootstrap by streaming from another cluster
(`pg_basebackup`, needs the credentials of a source and a page of its own
after v1); the `postInitSQL` families of `initdb` and the `import` of
databases (free SQL, out of scope by AGENTS.md); tablespaces, managed
services, projected volumes, probes, priority classes and the other fields
of `.spec` an operator sets in YAML once and for all (the form says where
the YAML preview can be copied to finish the job); the creation of the
secrets a cluster references (the host creates secrets); `managed.roles` on
the cluster (roles are `DatabaseRole` objects, SPEC-0027).

## Design

### Standard or ad hoc view, and why

The form is a dialog opened from where the user is, and the dialog is ad
hoc on purpose, as in M6: a generic "paste YAML here" is the worst possible
form for a database cluster, because everything that decides whether the
cluster will be safe (an object store, more than one instance, a storage
size, a bootstrap source) is a fact the form can ask for by name, refuse
with a reason, and show as the exact YAML before it is sent.

### Ground rules

- **F1, entry points.** Every list page of a kind with a form carries the
  host's floating add button (`addRemoveButtons={{ onAdd, addTooltip }}` of
  the list layout, the idiom of the core Namespaces page); the tooltip
  names the verb ("Create PostgreSQL cluster"). The page takes an 80 px
  clearance at the end of its list so the button never covers the row menu
  of the last row. Where the drawer of a cluster shows the objects that
  depend on it (the "Scheduled backups" and "Poolers" rows), the row
  carries a "Create one" door that opens the same form with the cluster
  and its namespace already set and shown as facts.
- **F2, the form is the confirmation.** One dialog per kind, through
  `ConfirmDialog.open({ ok })` with the machinery of SPEC-0020 (the model
  outside React in a MobX observable, the observable `okButtonProps`, the
  reopen delay after a conflict). The left pane is the form, in reading
  order: identity first, then what the kind is about, then the sections
  that ship collapsed. The right pane is the YAML of the exact body the
  create will send, read only, updated on every change, with a "Copy YAML"
  button for those who commit it to git instead. Under the form the live
  write summary of W4: the one `create Kind namespace/name` line, then
  the notes true of this object, then the warnings. The OK button carries
  the verb and is disabled while a field is missing or invalid, with the
  reason at the field, never a mute grey button.
- **F3, width.** A creation dialog with a preview is wider than the host's
  confirmation box (`max-width: 50vw`): its stylesheet ships one rule that
  widens the host's box when it contains a creation form, to
  `min(1100px, 90vw)`, and stacks the two panes under 900 px. Declared
  deviation, recorded in DESIGN.md section 13 by the implementation PR.
- **F4, namespace.** The host's `NamespaceSelect`, defaulted to the one
  namespace the page filter names when it names exactly one, else empty
  and required. A form opened from a cluster inherits its namespace and
  shows it as a fact, not a control. Changing the namespace reloads every
  picker that is namespaced.
- **F5, names.** A name is checked as the API server checks it (a DNS
  subdomain: lowercase letters, digits, `-` and `.`, 253 characters at
  most) plus what the operator derives from it: a cluster name is a DNS
  label, because it becomes the prefix of pods, services and secrets, and
  the form says so. A name already in the store of the kind warns at the
  field and never blocks (the store may be partial); the server's
  `AlreadyExists` reopens the dialog with its message and the values kept.
- **F6, validation before submit.** Every rule of the validating webhook
  the form can express is enforced inline, with the reason, before the
  submit, so the user never meets a server error for something the form
  knows; on a default install the webhook is there, on a cluster where it
  is not the form is the only guard. The API server's message is shown as
  it came when it refuses anyway (W9).
- **F7, pickers.** References are pickers over stores: the host's for
  secrets, storage classes and namespaces, the extension's for clusters,
  object stores, image catalogs, backups and roles. A picker loads the
  namespace it needs on open through the reference loader of SPEC-0003,
  dims what is not usable with the reason (a not yet reconciled object
  store, a backup that did not complete) and always accepts a typed name,
  so a value the user knows is never blocked by a store that is empty or
  forbidden.
- **F8, defaults and effective values.** The form ships the recommended
  shape: plugin based WAL archiving when an object store exists in the
  namespace, three instances, no deprecated field, nothing the operator
  would refuse. A value the API server or the operator will stamp when the
  field is left out is shown next to the control as the effective value
  and is never sent: the YAML pane shows only what the user decided.
- **F9, no optimistic UI.** As W8: nothing changes because the user
  clicked; the OK button is in the host's `waiting` state while the create
  is in flight; on `201` the dialog closes, a notification says that the
  object was requested and that the operator does the rest, with a door to
  its drawer, and the row appears when the store sees it.
- **F10, access.** The `create` verb on the resource in the namespace is
  asked as in W3 when the dialog opens; a denial keeps OK disabled with
  the verb and the resource in the reason, and the form stays readable so
  the YAML can still be copied for someone who may.
- **F11, immutable fields.** A field the API server refuses to change
  after creation says so in its hint ("cannot be changed later"), from the
  list of each kind's spec.
- **F12, the YAML pane.** The body is serialized with `js-yaml` in the
  key order the form presents, without comments or defaults, and the pane
  is the host's `MonacoEditor` (`language="yaml"`, `readOnly`) with the
  clamped height rule of DESIGN.md section 3. What is in the pane is what
  is sent, byte for byte after serialization, and the E2E case proves it
  by reading the object back.
- **F13, what is never written.** Any deprecated form (the in-tree
  `barmanObjectStore`, `backup.retentionPolicy`, `enablePodMonitor`,
  `minSyncReplicas` and `maxSyncReplicas`, `bootstrap.initdb.options`);
  a `backup` section at all when a plugin archives; the `cnpg.io/`
  annotations and labels of the operator; `cnpg.io/validation`;
  `spec.replica`; a secret's content.
- **F14, tests.** Every rule of F5 and F6, every note and warning of the
  summary and the body of every form is a unit case of the pure module of
  the kind. Every form has an E2E case that fills it in the real Freelens,
  compares the YAML pane with the body, creates the object in the write
  namespace, reads it back with `kubectl`, waits for the operator's first
  reaction where it is cheap, and deletes it. The pre-review pass opens
  every form on both themes, fills it with valid values, screenshots it
  with the YAML pane and closes it without creating.

### Shared machinery

- `src/renderer/components/create-dialog.tsx` and its stylesheet: the two
  pane layout, `Field` (label, control, hint, error, warning),
  `CollapsibleSection`, `KeyValueEditor` (for parameters and labels, with
  per key validation), `QuantityField` (a Kubernetes quantity, refusing
  zero and negatives), `ObjectPicker` (F7), `YamlPane` and the copy
  button, `WriteSummary`; the width rule of F3.
- `src/renderer/components/create-forms.ts` (pure): `objectNameError`,
  `dnsLabelError`, `quantityError`, `cronError` (SPEC-0026),
  `effectiveValue` helpers, the serialization to YAML, `creationFacts`
  (the write line and the summary shape), the `AlreadyExists` and
  webhook failure sentences on top of `apiFailureFacts`.
- `src/renderer/components/create-client.ts`: the one `store.create` of
  the host with the body, the notification, the door to the drawer.
- One pure module per kind, `<kind>-create.ts`: the default form, the
  errors, the warnings, the notes, the body. The dialog of the kind is a
  thin observer over it, as the menus of M6 are over their modules.

### The Create Cluster form

Entry points: the floating button of the PostgreSQL Clusters page. Sections
in order, the collapsed ones marked:

1. **Identity.** Namespace (F4); name (F5: a DNS label of 50 characters at
   most, the operator's own limit, because it becomes the prefix of the
   pods, the volumes, the services and the secrets); description; instances
   (integer, 1 or more, default 3; the hint says what 1 means).
2. **Image.** A radio: *the operator's default* (nothing is sent; the
   effective image is read from the operator deployment when SPEC-0016 can
   read it, else named as "the operator's default"), *an image catalog*
   (picker over the `ImageCatalog` of the namespace and the
   `ClusterImageCatalog` of the cluster, then the major among the ones the
   catalog lists), *an image name* (free text: a reference whose tag is a PostgreSQL
   version, because the operator refuses `latest` and a digest alone).
   Exactly one is sent; a catalog that lacks the major is not checked by
   the API server (the cluster would report an invalid catalog), so the
   picker offers only the majors the catalog lists.
3. **Storage.** Size (required quantity, cannot shrink later); storage
   class (picker, "the cluster's default" sends nothing); *collapsed*: WAL
   on its own volume (size and class; it can be added later, never removed
   once set).
4. **Bootstrap.** A radio, exactly one sent: *a new database* (`initdb`:
   database and owner, default `app` and `app`, the owner's secret as a
   picker of `kubernetes.io/basic-auth` secrets or nothing so the operator
   generates it, *collapsed*: encoding, locale provider and locale, data
   checksums); *recovery* (`recovery`: either a completed `Backup` of the
   namespace as a picker, or an object store of the namespace with the
   server name of the source cluster, which sends the `externalClusters`
   entry with the plugin parameters; then an optional target time; the
   summary says that recovery replays the WAL of the source up to the
   target). The bootstrap section says that it is read once, when the
   first instance is created, and ignored afterwards.
5. **Backups and WAL archiving.** The object store (picker over the
   `ObjectStore` of the namespace) that becomes the plugin entry with
   `isWALArchiver: true`; "none" is allowed and the summary warns that
   without archiving there is no backup and no point in time recovery;
   *collapsed*: backup target (`prefer-standby` or `primary`, the
   effective default shown).
6. **Superuser.** Enable superuser access (checkbox, the effective default
   shown) and, when enabled, the superuser secret as a picker or nothing.
7. **Replication** (*collapsed*, offered when instances is 2 or more).
   Synchronous replication: method (`any` or `first`), number, data
   durability (`required` or `preferred`, the effective default shown),
   with the rule that the number must be below the instances enforced
   inline; the deprecated pair of minimum and maximum sync replicas is not
   offered.
8. **Resources** (*collapsed*). Requests and limits of CPU and memory,
   quantities, with the note that equal requests and limits give the
   Guaranteed class the operator recommends, and the warning of the
   summary when nothing is set.
9. **Updates and PostgreSQL** (*collapsed*). Primary update strategy
   (`unsupervised` or `supervised`, the latter dimmed with one instance)
   and method (`restart` or `switchover`), effective defaults shown;
   PostgreSQL parameters as a key value editor that refuses the parameters
   the operator fixes itself and says which ones the operator writes on
   its own (about twenty, `wal_level` `logical` among them), so the user
   never mistakes them for input.
10. **Scheduling** (*collapsed*). Pod anti affinity: preferred or required,
    and its topology key (`kubernetes.io/hostname` by default); node
    selector as key value pairs.

The effective values the form shows and never sends: the operator's
default image; `initdb` with a database `app` owned by `app`, encoding
`UTF8`, locale `C`; update strategy `unsupervised` by `restart`; superuser
access off; backup target `prefer-standby`; pod anti affinity preferred;
replication slots for high availability on.

The write summary of a cluster names what the operator will create from it:
the pods `<name>-1` to `<name>-N` on volumes of the size chosen, the
services `<name>-rw`, `<name>-ro` and `<name>-r`, the secrets `<name>-app`
and, when enabled, `<name>-superuser`, the archiving destination or its
absence, the bootstrap source. Warnings: one instance (no failover), no
object store (no backups), no resources (BestEffort), a supervised strategy
(updates wait for a switchover by hand, SPEC-0022), a synchronous number
that equals the standbys (a lost standby blocks writes).

### Rules the form enforces

The validating webhook rules of v1.30.0 the form expresses inline, as the
recon recorded them (RECON-M7); the implementation PR lists each with the
error message of the operator it prevents:

- `metadata.name` is a DNS label of 50 characters at most.
- `instances` is 1 or more; `supervised` needs more than one instance; a
  synchronous `number` is below `instances`.
- Exactly one of `imageName` and `imageCatalogRef`; an image tag is a
  PostgreSQL version, never `latest` or a digest alone; a catalog
  reference names a major the catalog lists.
- `storage.size` is a quantity above zero (the form always gives a size);
  the same for the WAL volume.
- At most one bootstrap method; a database and an owner are given
  together; a recovery names a backup or a source, and a source is an
  `externalClusters` entry with a plugin configuration; a target time
  parses.
- At most one plugin is the WAL archiver; the operator checks neither
  that a plugin exists nor that its object store does (the plugin does at
  reconcile time), so the form checks the object store against its store
  and warns on a typed name it cannot see.
- The parameters the operator fixes (`archive_mode`, `archive_command`,
  `cluster_name`, `hot_standby`, `listen_addresses`, `port`,
  `shared_preload_libraries`, the `ssl` family,
  `synchronous_standby_names`) are refused; `wal_level` is `logical` or
  `replica` on a cluster of more than one instance; `shared_buffers` is a
  quantity; `min_wal_size` stays below `max_wal_size`.
- Resource limits are not below requests, and the memory request is not
  below `shared_buffers`.
- What the API server accepts with a warning (a `shared_buffers` without
  unit, a deprecated field) is shown in the success notification as the
  warning it is.

### Non-happy states

- No object store in the namespace: the picker offers "none" with the
  warning and a door to the Object Stores page.
- No image catalog: the option says so and the two others stay.
- Stores forbidden (a picker cannot list secrets): the picker becomes a
  text field with the reason, the form stays usable.
- The webhook refuses: its message at the top of the form, the values
  kept, OK enabled again.
- The webhook does not answer: the sentence of W9 with the door to the
  Operator page (a cluster has a webhook, so its create fails until the
  operator is back).

### Safety

One `create` of one `Cluster`, listed in the summary, nothing else. The
form never writes a secret, never sets an annotation of the operator, never
generates a deprecated field. A cluster created from the form is exactly
the YAML the user saw.

### DESIGN.md conformance

Sections 3, 5, 6, 7 and 13 apply; the width of F3 is the one declared
deviation, and the implementation PR records the F rules in DESIGN.md as
section 14 ("Creation forms"), next to the write actions.

## Tests (non-regression list)

- Unit: `create-forms.test.ts` (names, labels, quantities, serialization,
  failure sentences); `cluster-create.test.ts`: every rule above, the body
  of every bootstrap and image choice, the effective values, the notes and
  warnings of the summary, the plugin entry for the object store, the
  parameters refused, the `externalClusters` entry of a plugin recovery.
- Integration: unchanged.
- E2E: from the floating button of the PostgreSQL Clusters page, in the
  write namespace, fill the form for a one instance cluster on the object
  store of the fixtures with a new database; assert the YAML pane equals
  the summary's body; create; read the object back with `kubectl` (the
  instances, the storage size, the plugin entry, the bootstrap); wait for
  the operator to create the first pod; delete the cluster; a second run
  of the form with the name of `e2e-actions` warns of the collision; a
  synchronous number equal to the instances is refused at the field.
- Pre-review: the form on both themes, filled, with the YAML pane, closed
  without creating, plus the "Create one" doors of the drawer.
- Manual verification: none beyond the M7 milestone review.

## Notes and deviations

- The host's `Select` accepts an `isCreatable` prop that is deprecated and
  does nothing (Freelens 1.10.3): "type a name" is a last option of every
  picker ("Type a name...") that turns the control into a text input, with
  a link back to the list; the choice lives in the model so a reopen keeps
  it.
- The dependency for the YAML pane, `js-yaml`, is a devDependency like
  every other library the bundle carries (`cronstrue`, `mobx`, `react`):
  the extension ships bundled and its package declares no runtime
  dependency, which is what the production check of `knip` enforces.
- The operator's default image is read from the `POSTGRES_IMAGE_NAME`
  variable of the operator deployment when the account may list
  deployments and the variable is set; the release manifest sets it only
  when the default is overridden, so on a default install the effective
  value reads "the operator's default image" and the E2E case proves the
  stamp by reading `spec.imageName` back after the create.
- A refusal of the API server does not close the form: the dialog comes
  back after the host's leave animation with the sentence of W9 at its
  top and every value kept, and no notification is raised beside it. On
  `AlreadyExists` the sentence says that a cluster with that name appeared
  in the meantime.
- Radios and checkboxes are native inputs with the host's accent color:
  the host's `RadioGroup` cannot carry a line per option and its `Button`
  is painted for a dark surface (DESIGN.md section 14).
- The two recovery bootstraps are covered by the unit cases of the body
  and the rules; the E2E case creates by `initdb`, since a recovery on the
  E2E cluster would take minutes of WAL replay for what the body already
  proves.
- The width rule of F3 is a global rule shipped with the dialog's
  stylesheet, scoped by `:has` to the host's box while it holds a creation
  form; the action dialogs of M6 keep their width.
- The host's `MonacoEditor` sizes its container from the line count of the
  value it mounted with (90, 180 or 360 px) unless a height is given, and
  the body of a form grows with every field: the pane gives the editor the
  height of its box, and the pre-review pass checks that the editor fills
  it (found on the screenshots of the M7 pre-review pass, fixed in #61).
