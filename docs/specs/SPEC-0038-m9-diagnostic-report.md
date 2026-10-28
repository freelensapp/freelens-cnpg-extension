# SPEC-0038: Diagnostic report of a cluster

- **Status:** Approved
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28

## Goal

One action saves everything needed to diagnose a cluster in one file the user can attach to an issue
or a support case, with no secret in it.

## Upstream reference

`kubectl cnpg report cluster` (v1.30.1, `internal/cmd/plugin/report/`): a ZIP with the cluster, its
pods, jobs, PVCs and the events of the namespace, optionally the logs of the pods and jobs; YAML or
JSON; the operator report redacts Secrets and ConfigMaps.

## Scope

Included: "Save diagnostic report" on the Cluster: the cluster and its owned objects, the related
CNPG objects, events, optionally logs and the live status of each instance. Excluded: the operator
report (a later addition on the Operator page if wanted).

## Design

- Content, in folders of a ZIP: the `Cluster`; its pods, jobs, PVCs, services, PodDisruptionBudgets;
  its backups, scheduled backups, poolers, databases, roles, publications, subscriptions, failover
  quorum; the ObjectStores it refers to; the events of these objects; the instance manager status of
  each instance (SPEC-0006); optionally the logs of the instances (last N lines, chosen in the dialog).
  `managedFields` removed.
- Redaction: no Secret is read; references to Secrets keep their names; any value under a key named
  like a password, token or key in a ConfigMap is replaced. A `README.txt` lists what is in and what
  was left out.
- The renderer collects through the host's stores and the pod proxy, as the views do; main writes
  the file the user chose in Electron's save dialog (`<cluster>-<namespace>-<timestamp>.zip`) and
  answers with its path or the error. Nothing is written elsewhere.

### Safety

Reads only from the cluster; one file written where the user chose. The dialog says what the file
contains and that it holds no Secret values.

## Tests (non-regression list)

- Unit: the list of objects for a cluster; redaction; the ZIP layout (a fake writer).
- E2E: the report of `e2e-main` (save dialog answered by the test) holds the cluster, its three pods,
  their status and no Secret data.

## Notes and deviations

Filled during implementation.
