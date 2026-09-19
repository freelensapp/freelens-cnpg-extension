# SPEC-0014: Database Roles, list and detail (read-only)

- **Status:** Approved
- **Milestone:** `M4` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.0`
- **Author / date:** freelensapp core team, 2026-09-19

## Goal

An operator sees every role declared for a cluster, what it may do, how it
authenticates and until when, and whether PostgreSQL has it as declared,
with the two traps of role management told in words: a role that the
cluster spec already manages, and a password that has expired.

## Upstream reference

- `DatabaseRole` of `postgresql.cnpg.io/v1` (CRD schema and "PostgreSQL
  Role management", v1.30.0): `spec.cluster.name`, `spec.name` (immutable,
  reserved names rejected at admission), the role attributes (`login`,
  `superuser`, `createdb`, `createrole`, `replication`, `bypassrls`,
  `inherit` default true, `connectionLimit` default -1, `inRoles`,
  `comment`), `passwordSecret`, `disablePassword`, `validUntil`,
  `clientCertificate.enabled`, `databaseRoleReclaimPolicy` (`retain`,
  `delete`). `ensure: absent` is not supported by this kind.
- Status: `applied`, `message`, `observedGeneration`, `conditions`
  (`PasswordSecretChange` is an internal signal, its message is a resource
  version), `clientCertificate.expiration` and `.message`. The status
  semantics are those of SPEC-0013, plus: a role whose name is also in
  `spec.managed.roles` of the cluster is not reconciled (the cluster spec
  wins) and fails with a fixed message.
- Client certificates: Secret `<object name>-client-cert`, 90 days by
  default, renewed by the operator within 7 days of the expiry.
- Creating a `DatabaseRole` for an existing role adopts it and forces every
  attribute to the manifest, omitted ones included. With `delete`, a role
  that owns objects cannot be dropped and the object stays terminating.
- The inline roles of a cluster report in
  `Cluster.status.managedRolesStatus` (`byStatus`, `cannotReconcile`).
  Functional reference only; the sentences shown are ours.

## Scope

Included: the typed model, the "Database Roles" list and its drawer, the
inline managed roles of the cluster shown next to the declared ones in the
Cluster drawer. Excluded: any action, any read of a Secret value (the
drawer links the Secret, never opens it), the roles that exist in
PostgreSQL without being declared.

## Design

### Standard or ad hoc view, and why

Standard list and drawer: a role is a set of attributes and two dates.

### Pure module (`src/renderer/components/database-roles.ts`)

- `roleAttributes(role)`: the granted attributes as words in a fixed order
  (Login, Superuser, Create database, Create role, Replication, Bypass RLS,
  and "No inherit" only when `inherit` is false).
- `passwordFacts(role, now)`: the source ("Secret X", "Disabled", "Not
  managed"), `validUntil` parsed, expired or not.
- `certificateFacts(role, now)`: enabled, the Secret name, the expiry, the
  days left, expired or not, the operator's message.
- `inlineRival(role, cluster)`: the entry of `spec.managed.roles` with the
  same name.
- `roleHealth(role, cluster, now)`: the shared classification, then:
  - the inline conflict told in words: "The cluster spec manages this role:
    `managed.roles` wins, this object is ignored";
  - `Applied` with an expired password: warning, "Applied, but the
    password expired N ago: the role cannot log in with it";
  - `Applied` with an expired client certificate: warning (the operator
    should have renewed it);
  - `Deleting` with the `delete` policy says that a role that owns objects
    cannot be dropped until they are reassigned.
- `inlineRoles(cluster)`: the roles of `managedRolesStatus` by status with
  the `cannotReconcile` reasons.

### List and drawer

List: `Name | Namespace | Cluster | Role | Attributes | Member of |
Password | Expires | Condition | Status | Age`. `tableId`:
`cnpgDatabaseRolesTable`. Drawer:

- **Reconciliation**: as SPEC-0013, plus the inline rival.
- **Role**: cluster, PostgreSQL name, attributes as badges (Superuser and
  Bypass RLS in the warning class: they override every restriction),
  member of, connection limit, comment, reclaim policy in words.
- **Authentication**: password source with the Secret as a link, valid
  until with the time left, client certificate (enabled, Secret as a link,
  expiry with the days left, the operator's message), and one sentence on
  what `login: false` means for both.

Cluster drawer, in the Declarative objects section of SPEC-0013: a "Roles
in the cluster spec" row with the inline roles by status and the reasons
of the ones that cannot be reconciled.

### Non-happy states

As every list.

### Safety

Reads only. Secret values are never read: the extension knows the name of
a Secret and its expiry from the status, nothing else.

## Tests (non-regression list)

- Unit: `database-roles.test.ts` (attributes, password and certificate
  facts at their edges, inline rival, overlays, inline roles).
- E2E fixtures: a login role with a password Secret, a membership and a
  client certificate (Applied, with an expiry); a role that is a member of
  a role that does not exist (Failed); a role whose password expired
  (warning); a role that `e2e-single` also declares inline (Failed, told in
  words); the `app` role of `e2e-main` adopted with `replication` for
  SPEC-0015. Cases: the list shows the four conditions; the drawer shows
  the certificate expiry and links the Secrets; the Cluster drawer lists
  the inline role.
- Manual verification: the M4 milestone review.

## Notes and deviations

- Approved on 2026-09-19 under the lead maintainer's standing delegation for
  the work inside a milestone; it is reviewed with the rest of M4 at the
  milestone review.
