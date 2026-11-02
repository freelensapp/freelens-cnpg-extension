# SPEC-0038: Diagnostic report of a cluster

- **Status:** Implemented
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1`
- **Author / date:** freelensapp core team, 2026-10-28
- **Issue:** #103

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

- **Who does what.** The renderer lists the objects from the API server (pods, jobs, PVCs, services and
  PDBs by the `cnpg.io/cluster` label; the CNPG kinds by `spec.cluster`; the failover quorum by name; the
  ObjectStores the plugins and the external clusters name), the events of the namespace about them, the
  `/pg/status` of each instance (scheme of its status port read from the pod) and, when asked, the last
  N lines (1 to 10000, 500 by default) of the `postgres` container of each instance. `components/report.ts`
  cleans and lays them out (YAML per object, `events.yaml`, `status/<instance>.json`, `logs/<pod>.log`,
  `README.txt` first, with what is in, what is left out and what could not be read). Main checks the
  request (safe relative paths, no duplicate, at most 2000 files and 256 MiB), asks Electron's save
  dialog with `<cluster>-<namespace>-<timestamp>.zip`, deflates the files into a ZIP of its own (no new
  dependency: `zlib` and a CRC-32) and writes the one file chosen; a closed dialog writes nothing.
- **Redaction.** No Secret is read. Every object loses `managedFields` and the
  `kubectl.kubernetes.io/last-applied-configuration` annotation; an `env` value and a ConfigMap data value
  under a name like password, secret, token, key, private or credential reads `<redacted>`. The dialog
  warns that logs may hold what applications wrote into them.
- **The dialog** is the action dialog with no write listed (`ActionFactsBlock` now leaves the list out
  when it is empty): it says nothing is written to the Kubernetes cluster and what goes into the file.
- **E2E.** The save dialog is answered by the test: it reaches the main process of Freelens dev through
  its inspector (`--inspect`, port 5858) and stands in for `dialog.showSaveDialog`, as
  freelens-velero-extension does with Playwright's Electron application. The archive is read back with
  Python's `zipfile` (`testzip` included): README first, the cluster, the three pods with their status
  and logs, the poolers, no Secret file, and the password of the application user in no file (compared,
  never printed). A closed dialog writes nothing.
- **Manual verification still to do**: the real save dialog of the system on Linux, Windows and macOS
  (title, suggested name, the ZIP filter).
