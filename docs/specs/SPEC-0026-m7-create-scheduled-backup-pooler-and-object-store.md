# SPEC-0026: Create ScheduledBackup (with a cron editor), Pooler and ObjectStore

- **Status:** Verified
- **Milestone:** `M7` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0` (Barman Cloud plugin `v0.15.0`)
- **Author / date:** freelensapp core team, 2026-09-22

## Goal

Three forms under the ground rules of SPEC-0025 for the three objects an
operator adds around a cluster: a backup schedule whose cron expression is
built and explained rather than typed, a PgBouncer pooler in front of the
cluster, and the object store of the Barman Cloud plugin where WAL and
backups go.

## Upstream reference

- `ScheduledBackup` of `postgresql.cnpg.io/v1`: required `cluster` and
  `schedule`; the schedule is a cron expression with six fields, seconds
  first, read by the operator's cron library (the exact grammar the
  operator accepts, descriptors included, is in RECON-M7 and enforced by
  `cronError`); `immediate` takes a first backup at creation;
  `backupOwnerReference` is `none`, `self` or `cluster` and decides who
  owns the backups; `suspend`; `method`, `target`, `online`,
  `onlineConfiguration` and `pluginConfiguration` as on a `Backup`
  (SPEC-0020). `status.nextScheduleTime` is written by the operator after
  the first reconciliation.
- `Pooler` of `postgresql.cnpg.io/v1`: required `cluster` and `pgbouncer`;
  `type` is `rw`, `ro` or `r`; `instances`; `pgbouncer.poolMode` is
  `session` or `transaction`; `pgbouncer.parameters` are PgBouncer
  settings, some of which the operator owns and refuses; `authQuerySecret`
  and `authQuery` for a custom auth query, else the operator's own;
  `paused`; the pooler becomes a Deployment and a Service named as the
  pooler, so its name must not be one of the cluster's services.
- `ObjectStore` of `barmancloud.cnpg.io/v1` (plugin v0.15.0): required
  `configuration.destinationPath`; one credential family among
  `s3Credentials`, `azureCredentials` and `googleCredentials`;
  `endpointURL` and `endpointCA`; `wal` and `data` with their compression,
  encryption and parallelism; `retentionPolicy` as a number of days, weeks
  or months; `instanceSidecarConfiguration`; `serverName` to store under
  a name other than the cluster's.
- The functional references of scope: `kubectl cnpg backup` (a Backup, not
  a schedule), the documentation's samples of a schedule, a pooler and an
  object store. Nothing is copied.

## Scope

Included: the three forms with the fields below, the cron editor and its
next runs, the E2E cases that create each object in the write namespace
and read it back, the pre-review of the three forms.

Excluded, and where it goes: the `template` and `serviceTemplate` of a
pooler and its `monitoring` (deprecated pod monitor; YAML); the
`instanceSidecarConfiguration` of an object store beyond the retention
interval (YAML); Azure and Google credentials beyond the secret and key
pickers (the form offers them, it does not create the secrets); editing a
schedule (the host's editor; suspend and resume are SPEC-0021).

## Design

### Standard or ad hoc view, and why

The dialogs of SPEC-0025 (F2). The one ad hoc element of this spec is the
cron editor: an expression typed blind is the usual source of a schedule
that runs at 3:00 every minute; the editor builds the six fields from what
the operator means and shows the next three runs before anything is sent.

### Create ScheduledBackup

Entry points: the floating button of the Scheduled Backups page; the
"Create one" door of the Scheduled backups row of the Cluster drawer (the
cluster set and shown as a fact).

1. **Identity.** Namespace (F4), cluster (picker over the clusters of the
   namespace; a hibernated cluster and a cluster without WAL archiving are
   dimmed with the reason, a typed name is accepted), name (default
   `<cluster>-daily`, F5).
2. **Schedule.** A radio of presets that fill the expression: every hour
   at a minute; every day at a time; every week on a day at a time; every
   month on a day at a time; a custom expression. The expression field
   always shows the six fields the form will send, editable under
   "custom"; a five field expression is refused with the reason (the
   operator's parser reads five fields seconds first too, with the day of
   week left out, never the Kubernetes way); a descriptor (`@hourly`,
   `@daily`, `@weekly`, `@monthly`, `@every 1h30m`) is accepted, with the
   note that the operator warns on anything but six fields. Under it: the sentence of
   `describeSchedule` (SPEC-0005) and the next three runs computed by the
   extension's own evaluator, in UTC with the note that the operator
   applies its own time zone.
3. **What the run takes.** Method (`plugin` when the cluster has a backup
   plugin, `volumeSnapshot` when the cluster configures one and the
   VolumeSnapshot CRD exists in the Kubernetes cluster, else dimmed with
   the reason; the method is always sent, with the plugin name, because
   the API's own default is the deprecated in-tree one); target (the cluster's default, `primary`, `prefer-standby`);
   *collapsed, volume snapshots only*: online, immediate checkpoint, wait
   for archive.
4. **Behaviour.** Take a first backup right away (`immediate`); create
   suspended (`suspend`); who owns the backups (`backupOwnerReference`,
   one sentence per value: with `none` the backups outlive the schedule,
   with `self` they go with the schedule, with `cluster` they go with the
   cluster).

Summary: the create line, "runs `<sentence>`, next at `<three times>`", the
first backup right away when asked, the method and the target as facts,
the owner sentence; warnings: the cluster has no WAL archiving (every run
will fail), the cluster is hibernated or not healthy (a first backup right
away will fail, or wait in the case of a snapshot), a run more often than
every fifteen minutes (the backups will queue, one at a time), a cluster
name the store does not know (the backups will stay pending until it
exists).

### Create Pooler

Entry points: the floating button of the Poolers page; the "Create one"
door of the Poolers row of the Cluster drawer.

1. **Identity.** Namespace, cluster (picker; a cluster with one instance
   dims `ro` and `r` with the reason), name (default `<cluster>-pooler-rw`
   following the type; a DNS label of 63 characters at most, since it
   names a Service and a Deployment; refused when it equals `<cluster>`,
   `<cluster>-rw`, `<cluster>-ro`, `<cluster>-r` or `<cluster>-any`, the
   services of the cluster, or any Service the store knows).
2. **Front of what.** Type (`rw`, `ro`, `r`, one sentence each: writes to
   the primary, reads from the standbys, reads from any instance);
   instances (default 1).
3. **PgBouncer.** Pool mode (`session` or `transaction`, one sentence
   each, with the prepared statements caveat of transaction mode);
   parameters as a key value editor whose keys are offered from the allow
   list of the operator's webhook (57 PgBouncer settings, `max_client_conn`
   and `default_pool_size` first) and refused outside it with the reason
   (`pool_mode`, `auth_user`, `auth_query`, `listen_addr`, `listen_port`
   and the file paths belong to the operator); the operator does not check
   the values, and the hint says that a wrong value crash loops every
   pod; *collapsed*: paused; auth query secret (picker) and auth query,
   given together or not at all as the webhook demands, with the effective
   default (the operator's own query, user and secret) shown when empty.

Summary: "a Deployment and a Service named `<name>`, `<n>` PgBouncer pods in
`<mode>` mode toward `<cluster>`-`<type>`"; the auth fact; warnings: transaction
mode with prepared statements, `ro` or `r` on a cluster with one instance.

### Create ObjectStore

Entry points: the floating button of the Object Stores page; the Backups
section of the Create Cluster form links to the page when the namespace
has no object store (a page, not a nested dialog).

1. **Identity.** Namespace, name.
2. **Where.** Destination path (required; the scheme must match the
   provider chosen below: `s3://`, `azure://` or `https://` for Azure,
   `gs://`); provider radio: S3 compatible (endpoint URL, required for
   anything but AWS; region; credentials as a secret picker with the keys
   of the access key id and the secret access key, or "inherit from the
   IAM role"); Azure (connection string, or storage account with a key or
   a SAS token, each a secret and a key; or "inherit from Azure AD
   workload identity"); Google (application credentials as a secret and
   key, or "GKE environment"); *collapsed*: endpoint CA (secret and key).
   There is no server name here: the folder a cluster writes to is the
   cluster's own plugin parameter, and the API refuses the field on a
   store.
3. **WAL and data.** WAL compression (none, bzip2, gzip, lz4, snappy, xz,
   zstd), WAL encryption (none, AES256, aws:kms), max parallel; data
   compression (none, bzip2, gzip, lz4, snappy: the plugin lists fewer
   than for WAL), data encryption, jobs, immediate checkpoint.
4. **Retention.** Retention policy as a number and a unit (days, weeks,
   months), sent as `30d`; empty means "keep forever" and the summary says
   so; *collapsed*: retention check interval of the sidecar (the effective
   default of 1800 seconds shown); tags and history tags as key value
   pairs.

Summary: the create line, "clusters use it by naming it in their plugin
entry; WAL compressed with X; backups kept N days"; warnings: no retention
(kept forever), a plaintext endpoint, credentials from the environment
(the nodes need the role), a destination path shared by two object stores
of the namespace (the store knows them).

### Rules the forms enforce

As RECON-M7 recorded them at the tags; the implementation PR lists each
with the message it prevents:

- ScheduledBackup: the schedule parses as the operator's parser reads
  it (six fields seconds first, or a descriptor); the method is `plugin`
  or `volumeSnapshot` and is always sent; `pluginConfiguration` goes with
  `plugin`; `online` and `onlineConfiguration` go with `volumeSnapshot`
  (the operator refuses them only with the in-tree method; the form drops
  them for the plugin because they mean nothing there);
  `backupOwnerReference` in its three values; the cluster is immutable
  afterwards.
- Pooler: the `pgbouncer` section is always sent (empty at least); `type`
  in its three values; `poolMode` in its two; the parameter keys in the
  allow list; the auth query and its secret together; the name rules
  above; `instances` 1 or more; the cluster is immutable afterwards.
- ObjectStore: no webhook and no CEL beyond the path and the forbidden
  server name, so the form enforces what the plugin's library would:
  exactly one credential family; for S3 the key id and the secret key
  together, or the IAM role alone; for Azure a connection string alone,
  or a storage account with exactly one of a key, a SAS token, Azure AD
  or the default credentials; for Google the application credentials
  unless the GKE environment is chosen; a destination path with the
  scheme of the provider; `retentionPolicy` matching `^[1-9][0-9]*[dwm]$`;
  compression and encryption values from the plugin's lists.

### Non-happy states

- No cluster in the namespace: the two forms that need one say so with a
  door to the Create Cluster form.
- The cluster picked has no backup configuration: the method control
  explains what the cluster needs, OK stays disabled with the reason.
- No secret in the namespace: the credential pickers accept a typed name
  with the warning that the object store will fail until it exists.
- The webhook refuses or does not answer: as SPEC-0025, for the schedule
  and the pooler, which have one. An object store has none: its create
  succeeds even with the operator down, and the summary says that the
  store is only tried when a cluster uses it, so wrong credentials show up
  on the cluster's archiving condition, not here.

### Safety

One `create` per form, nothing else; no secret content is read or written;
no annotation of the operator; the deprecated in-tree method is never
sent, and a schedule without a method is never sent.

### DESIGN.md conformance

As SPEC-0025; no new deviation.

## Tests (non-regression list)

- Unit: `cron.test.ts`: the six field grammar of the operator's parser
  (`*`, `/`, `,`, `-`, `?`, names of months and days), the refusal of
  five fields with the reason, the next runs of every preset and of
  steps, ranges, lists, month ends and leap years, the descriptors the
  operator accepts and their next runs; `scheduled-backup-create.test.ts`,
  `pooler-create.test.ts`, `object-store-create.test.ts`: every rule
  above, every body, the notes and warnings.
- Integration: unchanged.
- E2E: in the write namespace, create a weekly schedule on `e2e-actions`
  from the drawer door with the method the cluster has, a first backup
  right away and `self` as the owner, read it back with `kubectl`, wait
  for the child backup named `<schedule>-<14 digits>` and for
  `status.nextScheduleTime` (the operator writes it only once a backup was
  created), delete the schedule and see the backup go with it; create a
  pooler of type `rw` with one instance, read it back, wait for its
  Deployment, delete it; create an object store on the S3 store of the
  fixtures with the credentials secret of the write namespace, read it
  back, delete it; the name of an existing schedule warns; a five field
  cron is refused at the field.
- Pre-review: the three forms on both themes, filled, closed without
  creating; the cron editor with a custom expression and its next runs.
- Manual verification: none beyond the M7 milestone review.

## Notes and deviations

- The cron evaluator is the extension's own (`cron.ts`): it follows the
  grammar of the operator's parser (six fields seconds first, `*`, `?`,
  lists, ranges, steps, names of months and days, the descriptors and
  `@every`), including its rule for the two day fields (when either is a
  star both must match, else either may), and computes the next runs in
  UTC. A five field expression is refused with the reason, as the spec
  asks; the words of a schedule still come from `describeSchedule`.
- The methods a schedule offers are the ones `backupMethodOptions` of
  SPEC-0020 computes for the picked cluster, minus the deprecated one, so
  the two dialogs cannot drift apart on what a cluster can do. The method
  follows the cluster: the first usable one is picked when the cluster
  changes.
- Whether the VolumeSnapshot CRD exists is read with one `get` of the CRD
  on open: a 404 is "no", a refused read leaves the fact unknown and the
  option offered (the operator's webhook decides then).
- The pooler name follows the cluster and the type until the user types
  one; a name that is one of the cluster's services, or any Service the
  read on open found in the namespace, is refused at the field, since the
  operator would fail to create the pooler's own Service.
- The object store form enforces the credential rules of the plugin's
  library itself (exactly one family, the S3 key pair together or the IAM
  role, the Azure and Google variants), because the API of the kind checks
  none of them; the key inside a secret is picked from the keys the secret
  carries when the read on open could see them.
- The drawer rows "Scheduled backups" and "Poolers" of a cluster are always
  shown now (the Poolers row used to hide itself without poolers): each
  carries the "Create one" door with the cluster and its namespace set.
- The E2E case of the schedule creates it with a first backup right away
  and the schedule as the owner, waits for the child backup named after the
  schedule and the time of the run and for `status.nextScheduleTime`, then
  deletes the schedule and sees the backup go with it; the pooler case
  waits for the Deployment and the Service the operator names after the
  pooler.
- The host's `Select` asks for 220 px at least, more than a column of three
  gets in the dialog: in an inline row the column wins, and the pre-review
  pass checks the weekday select of the weekly schedule against the hour
  field (found on the screenshots of the M7 pre-review pass, fixed in #61).
- M7 milestone review: 2026-09-24, lead maintainer, on the screenshots of the
  pre-review pass on both themes (gallery on an ephemeral branch, deleted
  after the review). Verdict: approved, no blocking finding. Status moved to
  Verified.
