# SPEC-0036: Operator page: install guide, plugin capabilities and Klio

- **Status:** Draft
- **Milestone:** `M9` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1` (Barman Cloud plugin `v0.15.1`)
- **Author / date:** freelensapp core team, 2026-10-28

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
- Other UIs: the Headlamp plugin has an install guide and basic Klio support. Functional reference
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

Filled during implementation. Klio is checked against its published CRD; it is not installed in the
kind cluster unless its license allows it in CI.
