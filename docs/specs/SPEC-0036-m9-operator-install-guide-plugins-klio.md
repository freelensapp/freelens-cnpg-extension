# SPEC-0036: Operator page: install guide, plugin capabilities and Klio

- **Status:** Implemented
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1` (Barman Cloud plugin `v0.15.1`)
- **Author / date:** freelensapp core team, 2026-10-28
- **Issue:** #101

## Goal

On a cluster without CloudNativePG, or without what backups need, the Operator page says what is
missing and how to install it; with it, the page shows what each CNPG-I plugin can do, Klio included.

## Upstream reference

- Installation of CloudNativePG (manifest of the release, or the `cloudnative-pg` Helm chart of
  `https://cloudnative-pg.github.io/charts`), cert-manager (required by the Barman Cloud plugin),
  the Barman Cloud plugin (manifest of its release).
- CNPG-I plugins: services labelled `cnpg.io/pluginName`; `Cluster.status.pluginStatus[]` with
  `capabilities` and, new in v1.30.1, `postgresCapabilities`.
- Klio: a CNPG-I backup plugin with its `PluginConfiguration` (`klio.cnpg.io/v1alpha1`).
- Other UIs: another interface has an install guide and basic Klio support. Functional reference
  only (AGENTS.md).

## Scope

Included: the guide on the Operator page and on the "not installed" state of every page; the
capabilities of each plugin; Klio as a known plugin, its PluginConfiguration list and drawer
(read-only). Excluded: installing anything from the extension (the guide gives commands and links;
the host's Helm Charts page installs charts).

## Design

- Not installed: the state of SPEC-0016 becomes a guide with three steps, each with its state
  (missing, installed with version, not needed): the operator, cert-manager, the Barman Cloud plugin;
  each with the command for the pinned release to copy, a link to the upstream documentation (opened
  in the browser), and for the operator a link to the host's Helm Charts page.
- Plugins: per plugin, version, the capabilities it declares (backup, WAL archiving, restore,
  metrics, lifecycle, PostgreSQL capabilities) and the clusters that use it.
- Klio: recognised by name, capabilities in words; its `PluginConfiguration` objects listed and shown
  read-only when the CRD exists; the cluster drawer names Klio as the backup method where used.

### Safety

Reads only; commands are shown to copy, never run.

## Tests (non-regression list)

- Unit: the guide's states from detected components; capabilities in words; Klio recognition from a
  recorded service and status.
- E2E: on the kind cluster, the plugins section shows Barman Cloud with its capabilities; on a
  cluster without CloudNativePG (a second kind cluster of the suite, or the CRDs removed in a
  dedicated run) the guide shows the three steps as missing.

## Notes and deviations

- Implemented on 2026-10-29 with the port to Freelens v2 (SPEC-0030): `install-guide.ts` (pure),
  `api/operator/components.ts` (the probe), `install-guide-view.tsx`, the plugin section of the
  Operator page, `klio.ts` with the Klio Configurations list and drawer.
- **Where the guide shows.** On a cluster without CloudNativePG every page of the extension, the
  Operator page included, is the "Not available" page of its kind: the guide is under its message. On
  a cluster with it, the Operator page has an Installation card, one line while every step is done, and
  a warning when a component is older than the release this extension was reviewed with.
- **The pinned releases** of the commands are the pins of `e2e/scripts/lib.sh` (CloudNativePG 1.30.1,
  cert-manager v1.21.2, Barman Cloud v0.15.1); a unit test keeps them equal.
- **Not needed.** Barman Cloud and cert-manager are "not needed" where Klio is installed and Barman
  Cloud is not: cert-manager is needed by the Barman Cloud plugin.
- **The probe** lists the CRDs filtered on their name rather than getting them one by one: a missing CRD
  is then an empty list, not a 404 that the console of the renderer would log on every cluster without
  the optional plugins. A refused list leaves a step "unknown", never "missing". The versions come from
  the images of the deployments: the operator by its label, cert-manager by its controller, a plugin
  through the selector of its service.
- **Helm.** The step of the operator links to the host's Helm Charts page and says which repository to
  add there first; nothing is installed from the extension.
- **Plugin capabilities.** The Barman Cloud plugin v0.15.1 declares only identity capabilities to the
  operator (reconciler hooks, lifecycle, sidecar): its WAL archiving and its backups run in its sidecar.
  So each plugin shows, besides what it provides, what the clusters use it for, read from their spec
  (`plugins[].isWALArchiver`, `externalClusters[].plugin`) and from the Backup objects of the selected
  namespaces. The per-service capability lists of the status, `postgresCapabilities` included, are
  shown when a plugin reports them.
- **Klio** (Apache-2.0) is not installed on the lab, as decided in phase 2. Its kind is typed from its
  published CRD (`klio.cnpg.io/v1alpha1`), with unit tests on its repository's sample. The cluster drawer
  names Klio as the backup plugin and links its PluginConfiguration (`pluginConfigurationRef`).
- **E2E on a cluster without CloudNativePG**: `pnpm e2e:bare:up` creates `cnpg-bare`, one node, and
  `cnpg-bare.tests.ts` runs against it (it skips on the lab). Run once on 2026-10-29, 3/3, and the
  cluster was deleted afterwards. It is not part of the CI workflow: a second kind cluster for three
  cases.
- **Copy** says "Could not copy" when the clipboard refuses the text, instead of nothing.
