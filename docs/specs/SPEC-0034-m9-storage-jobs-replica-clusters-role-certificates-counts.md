# SPEC-0034: Storage, jobs, replica clusters, role certificates and the counts of the cluster list

- **Status:** Draft
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

The drawer of a cluster shows its volumes as one table and the jobs that bootstrapped or joined its
instances, and a replica cluster says what it replicates and how it would be promoted; a role says
which client certificate it has; the cluster list says how many clusters need attention.

## Upstream reference

- PVCs of an instance: labels `cnpg.io/cluster`, `cnpg.io/instanceName`, `cnpg.io/pvcRole`
  (`PG_DATA`, `PG_WAL`, `PG_TABLESPACE`, with `cnpg.io/tablespaceName`); `status.healthyPVC`,
  `danglingPVC`, `resizingPVC`, `initializingPVC`, `unusablePVC`.
- Jobs: label `cnpg.io/cluster`, `cnpg.io/jobRole` (`initdb`, `join`, `full-recovery`, `pgbasebackup`,
  `snapshot-recovery`, `major-upgrade`), `cnpg.io/instanceName`.
- Replica cluster: `spec.replica` (`enabled`, `source`, `primary`, `promotionToken`,
  `minApplyDelay`), `status.demotionToken`, `spec.externalClusters`; `kubectl cnpg status` prints the
  designated primary, the source and the tokens.
- DatabaseRole client certificate (v1.30): `spec.clientCertificate.enabled` asks the operator to issue
  and renew a certificate signed by the cluster's client CA, stored in the Secret
  `<databaserole>-client-cert`; `status.clientCertificate` reports its `expiration` and a `message`.
- Jobs live only while they work: the operator removes a finished bootstrap or join job.
- Other UIs: the Headlamp plugin has a storage tab, a jobs table, list counts and a role certificate
  section. Functional reference only (AGENTS.md).

## Scope

Included: the four drawer sections and the counts above the PostgreSQL Clusters list. Excluded:
promoting or demoting a replica cluster (a write, a later spec if wanted).

## Design

- **Storage** (cluster drawer, replaces the PVC lists of SPEC-0003 by state, which become a column):
  PVC, instance, role (data, WAL, tablespace name), state (healthy, resizing, initializing, dangling,
  unusable), capacity requested and actual, storage class, links to the host's PVC.
- **Jobs** (cluster drawer, only while any exists): job, role in words, instance, status, start and
  duration, links to the host's job and its pod logs.
- **Replica cluster** (cluster drawer, only when `spec.replica.enabled`): the source and its external
  cluster entry, the designated primary, the minimum apply delay, the promotion token when set and the
  demotion token in status, each with one line on what it is for; the topology of SPEC-0006 labels the
  designated primary.
- **Client certificate** (DatabaseRole drawer): asked or not, the Secret's name (a link to the host's
  Secret), the expiry from `status.clientCertificate.expiration` with the expiry levels of the cluster
  certificates, and the operator's message; not asked: "This role has no client certificate".
- **Counts** (PostgreSQL Clusters list): clusters, healthy, hibernated, needing attention (any level
  but healthy, the health model of SPEC-0001), instances ready of total; each count filters the list.

### Safety

Reads only; no Secret is read (the certificate's expiry comes from the role's status).

## Tests (non-regression list)

- Unit: the storage rows from labels and status; job roles; the replica section's facts; the
  certificate's state from the role's status; the counts against the health model.
- E2E: `e2e-snapshots` shows data and tablespace volumes; while `e2e-actions` scales from 2 to 3
  instances its join job is listed with its role, and the section goes when the operator removes it;
  a replica cluster fixture (new) shows its source and designated primary; a role fixture with a client certificate (new) shows its expiry; the counts match the fixtures and filter the list.

## Notes and deviations

Filled during implementation. The replica cluster needs a new fixture: a second cluster replicating
`e2e-main` from its object store.
