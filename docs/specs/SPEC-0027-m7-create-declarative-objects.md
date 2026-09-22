# SPEC-0027: Create Database, DatabaseRole, Publication and Subscription

- **Status:** Approved
- **Milestone:** `M7` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-22

## Goal

Four forms under the ground rules of SPEC-0025 for the objects the
instance manager turns into SQL on the primary of a cluster: a database, a
role, a publication and a subscription. Each form says, before the click,
the statement the operator will run and what it needs to exist first, so
that a declarative object is created with its outcome in view, not
discovered later in a failed condition.

## Upstream reference

- `Database`, `DatabaseRole`, `Publication` and `Subscription` of
  `postgresql.cnpg.io/v1` at v1.30.0, their CRD schemas (required fields,
  defaults, enums and the CEL rules that are their whole admission for
  three of them) and the one validating webhook among them (`Database`:
  uniqueness of the extensions, schemas, foreign data wrappers and
  servers). The reconciliation model of the four kinds is in SPEC-0013 to
  SPEC-0015 (applied, failed, waiting, orphan).
- The instance manager of the current primary reconciles them; a
  referenced cluster that does not exist is never rejected at admission
  and leaves the object with an empty status until the cluster's primary
  runs.
- `kubectl cnpg publication create` and `kubectl cnpg subscription
  create` (v1.30.0) as the functional reference of the two replication
  forms: a publication is `--all-tables`, or `--schema` and `--table`
  entries, on `--dbname`, with `--parameters`; a subscription names
  `--external-cluster`, `--publication`, `--subscription`, `--dbname` and
  `--publication-dbname`. Flags only; nothing is copied.
- The password secret of a role: type `kubernetes.io/basic-auth`, key
  `username` equal to the role name, key `password`; the role name and
  the cluster's `managed.roles` precedence (the inline entry always wins
  on the same name).

## Scope

Included: the four forms with the fields below; the pickers over the
objects of the cluster the extension already knows (databases, roles,
external clusters, publications); the E2E cases that create each object in
the write namespace, read it back, see the operator apply it and delete
it; a fixture change so that a subscription can be created for real; the
pre-review of the four forms.

Excluded, and where it goes: foreign data wrappers and servers of a
database (YAML: rare, and their options are free text the form would only
relay); the `import` of an existing database; the creation of the password
secret of a role (the host creates secrets; the form links to the Secrets
page with the shape the secret must have); the client certificate of a
role beyond the toggle; `ensure: absent` (a deletion, not a creation:
the host deletes, the reclaim policy decides the rest); editing (the
host's editor).

## Design

### Standard or ad hoc view, and why

The dialogs of SPEC-0025 (F2). What is ad hoc here is the summary: each
form states the SQL the operator will run in words ("`CREATE ROLE
reporting` that can log in, member of `pg_read_all_data`"), because that
is what the operator does with the object and what the user wants to check.

### Common to the four

- The cluster is a picker over the clusters of the namespace (F7); a
  cluster whose primary is not running, a hibernated one, or a replica
  cluster is dimmed with the reason (the object would wait or stay
  unapplied); a typed name is accepted with the warning that nothing
  reconciles the object until such a cluster runs.
- The PostgreSQL side names (`spec.name`, `owner`, `dbname`) are checked
  as lowercase PostgreSQL identifiers of 63 bytes at most (letters, digits
  and underscore, not starting with a digit): the operator's quoting of
  anything else is not documented, and the form says so.
- The reclaim policy is a radio with one sentence per value: `retain`
  leaves the object in PostgreSQL when the Kubernetes object is deleted,
  `delete` drops it.
- The fields the API server refuses to change afterwards carry F11's
  hint: cluster and name for all four, and for a database the template,
  the encoding and the locale fields, for a publication `allTables`, for
  a subscription `dbname`.
- No form of this spec has a webhook of its own except the database's
  uniqueness check: the summary says that the API server accepts the
  object and that the primary applies it, so a mistake shows up in the
  object's status, where the views of M4 explain it.

### Create Database

Entry points: the floating button of the Databases page.

1. **Identity.** Namespace, cluster, object name (F5), database name
   (refused when `postgres`, `template0` or `template1`, the reserved
   names of the CRD).
2. **Owner.** A picker over the roles the extension knows of the cluster:
   the owner of the bootstrap database, the inline `managed.roles`, the
   `DatabaseRole` objects of the cluster, `postgres`; a typed name is
   accepted with the warning that the role must exist before the database
   is created (the operator fails the object otherwise).
3. **Objects inside** (*collapsed*). Extensions as rows (name, version,
   schema) and schemas as rows (name, owner), names unique as the webhook
   demands; the summary lists the `CREATE EXTENSION` and `CREATE SCHEMA`
   statements that follow.
4. **Creation options** (*collapsed*, creation only). Template
   (`template0`, `template1` or another database of the cluster),
   encoding, locale provider and locale (with the CEL rules of the
   provider enforced inline), tablespace (from the cluster's own list),
   connection limit, allow connections, is a template.
5. **Reclaim policy.**

Summary: "`CREATE DATABASE <name> OWNER <owner>` on the primary of
`<cluster>`", the objects inside, the reclaim sentence; warnings: a second
object for the same database name on the same cluster (the store knows
the others; the operator refuses the second), the owner not known.

### Create DatabaseRole

Entry points: the floating button of the Database Roles page.

1. **Identity.** Namespace, cluster, object name, role name (refused when
   `postgres` or `streaming_replica`, or starting with `pg_` or `cnpg_`,
   the reserved names of the CRD; refused with the reason when the
   cluster's own `managed.roles` names it, since the inline entry always
   wins and the object would never apply).
2. **Authentication.** A radio: *a password from a secret* (a picker over
   the `kubernetes.io/basic-auth` secrets of the namespace whose
   `username` is the role name, else a typed name with the shape the
   secret must have), *no password* (`disablePassword`, with the sentence
   that the role then needs a certificate or trust to connect), *leave the
   password alone* (nothing sent: the operator never touches it and a new
   role gets none). Can log in (`login`, default on); a client
   certificate managed by the operator (needs login, as the CRD says).
3. **Privileges.** Superuser, create databases, create roles, replication,
   bypass row level security, inherit (default on), each with one
   sentence; connection limit (default unlimited, shown as the effective
   value); valid until (a date and time, sent as RFC 3339).
4. **Membership.** Member of: a multi picker over the roles of the
   cluster and the PostgreSQL built ins (`pg_monitor`,
   `pg_read_all_data`, `pg_write_all_data`, `pg_signal_backend`, and the
   others), typed names accepted with the warning that a missing group
   fails the object.
5. **Comment** and **reclaim policy.**

Summary: "`CREATE ROLE <name>` with `<the attributes that are on>`, member
of `<groups>`", the password sentence of the choice made, the reclaim
sentence; warnings: superuser, replication, no password with login, a
validity already past.

### Create Publication

Entry points: the floating button of the Publications page.

1. **Identity.** Namespace, cluster, object name, publication name,
   database (a picker over the databases the extension knows of the
   cluster: the bootstrap database and the `Database` objects; typed
   accepted).
2. **What it publishes.** A radio: *all tables* (`allTables`), or
   *objects*: rows that are either a schema (`tablesInSchema`) or a table
   (schema, name, only this table, a column list), with the CEL rules
   inline (a column list never together with a schema row; at least one
   row).
3. **Options** (*collapsed*). Parameters as key value pairs with the
   known keys offered (`publish`, `publish_via_partition_root`).
4. **Reclaim policy.**

Summary: "`CREATE PUBLICATION <name> FOR ALL TABLES` (or the list) in
`<database>` on `<cluster>`, with `<parameters>`", and the sentence that a
subscriber needs a role with `REPLICATION` and `LOGIN` on this cluster;
warnings: a table row whose table does not exist cannot be checked here
(the operator fails the object with the PostgreSQL error).

### Create Subscription

Entry points: the floating button of the Subscriptions page.

1. **Identity.** Namespace, cluster (the subscriber), object name,
   subscription name, local database (picker as above).
2. **Where from.** External cluster: a select over the `externalClusters`
   entries of the picked cluster that carry connection parameters; when
   the cluster has none, the field explains what the cluster's YAML needs
   (an entry with a host, a user, a database and a password secret) and
   OK stays disabled with that reason. Publication: a picker over the
   `Publication` objects of the cluster the entry points to, when the
   entry's host is the `rw` service of a cluster the extension knows in
   the selected namespaces, else typed. Publication database: the
   effective default is the entry's own database, shown; a different one
   can be typed.
3. **Options** (*collapsed*). Parameters as key value pairs with the
   known keys offered (`copy_data`, `create_slot`, `slot_name`,
   `failover`, `streaming`), and the note that most cannot change once
   the subscription exists.
4. **Reclaim policy.**

Summary: "`CREATE SUBSCRIPTION <name>` in `<database>` on `<cluster>`, from
`<external cluster>` (`<host>`), publication `<publication>`", the sentence that
the tables must already exist on the subscriber and that the initial copy
runs unless `copy_data` is off; warnings: the entry names no password
secret, the publication cannot be checked.

### Fixture change

The cluster of the write cases, `e2e-actions`, gains an `externalClusters`
entry named `e2e-main` with the connection parameters of the publisher of
the logical replication fixtures and a password secret; the second phase
of `cluster-up.sh` copies the application secret of `e2e-main` into the
write namespace under that name, once the cluster exists. Nothing changes
for the read-only fixtures.

### Non-happy states

- No cluster in the namespace: the form says so with a door to the
  Create Cluster form.
- The cluster picked has no running primary: the warning of "Common to
  the four", the form stays usable.
- No secret, no role, no publication to pick: typed names with the
  warning that says what will happen.
- The API server refuses (a CEL rule the form did not know, a name taken):
  its message at the top, values kept.

### Safety

One `create` per form. The forms never read or write a password, never
run SQL themselves (the operator does, from the object), never set an
annotation of the operator, never send `ensure: absent`.

### DESIGN.md conformance

As SPEC-0025; no new deviation.

## Tests (non-regression list)

- Unit: `database-create.test.ts`, `database-role-create.test.ts`,
  `publication-create.test.ts`, `subscription-create.test.ts`: every
  rule above (reserved names, the identifier check, the CEL exclusions,
  the `managed.roles` clash, the external cluster requirement), every
  body, every summary sentence and warning, the RFC 3339 of the validity.
- Integration: unchanged.
- E2E, in the write namespace on `e2e-actions`: create a role that can log
  in with a password secret created by the case, see it applied and read
  back from the primary with `psql`; create a database owned by it with
  one extension, see it applied and present; create a publication for all
  tables of that database, see it applied; on the subscriber side, create
  the table the fixture publisher publishes with `psql`, create a
  subscription from the `e2e-main` entry to `e2e_numbers_pub`, see it
  applied and the rows arrive; delete the four objects with `delete` as
  the reclaim policy and see PostgreSQL clean; a reserved role name and a
  reserved database name are refused at the field; a subscription on a
  cluster without external clusters keeps OK disabled with the reason.
- Pre-review: the four forms on both themes, filled, closed without
  creating.
- Manual verification: none beyond the M7 milestone review.

## Notes and deviations

Filled during implementation when reality diverges from the plan.
