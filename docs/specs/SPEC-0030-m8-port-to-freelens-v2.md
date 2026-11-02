# SPEC-0030: Port to the Freelens v2 extension API

- **Status:** Implemented
- **Milestone:** `M8` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v1.30.1` (Barman Cloud plugin `v0.15.1`)
- **Author / date:** freelensapp core team, 2026-10-28
- **Issue:** #90 (migration), with the port features #91 data access, #92 views, #93 writes and forms, #94 terminal and logs, #95 test suites

## Goal

The extension runs on Freelens 2 with everything version 1.0.0 does on Freelens 1.10.3, built and
tested on the stack of Freelens 2, so that the features of M9 are built on it.

## Upstream reference

- Freelens: `docs/extensions/migrating-from-v1.md`, `docs/extensions/api.md` (contracts C1 to C15)
  and `docs/extensions/binaries.md` of freelensapp/freelens, at the `v2.0.0` tag, which
  `@freelensapp/extensions` 2.0.0 was built from (the port started on the nightly of 2026-10-26),
  and the skill `port-freelens-extension-to-v2` of freelensapp/freelens-example-extension with its
  migration issue template.
- CloudNativePG: the CRD schemas of v1.30.1 against v1.30.0, which the types were written from:
  additions only (`Cluster.status.pluginStatus[].postgresCapabilities`, pod template fields of the
  Pooler, `restoreAdditionalCommandArgs`, projected volume `user` fields); the `ObjectStore` schema of
  Barman Cloud v0.15.1 is the one of v0.15.0. Nothing the extension shows changed meaning.

## Scope

Included:

- Manifest, dependencies and toolchain of Freelens 2 (`engines.freelens: ^2.0.0`, ESM, React 19,
  mobx 7, TypeScript 7, Vitest 5, Vite, pnpm 12), version `2.0.0-0`.
- The source on the v2 API: every page, drawer, menu, action, form and the live view of M1 to M7.
- The data paths of ARCHITECTURE.md on v2: CRD stores, the host's core stores, the pod proxy through
  the host's Kubernetes JSON client, the status patches and the access reviews through the cluster
  proxy, the pod log API, the psql terminal tab.
- The unit tests per environment; the E2E and pre-review suites on the template's harness (Freelens
  dev over CDP) against the kind cluster of the repository; the workflows of the template.
- The docs of the repository for v2.

Excluded:

- Supporting Freelens 1.x from the same release: 1.0.0 stays on npm for it.
- New features: M9 (SPEC-0031 to SPEC-0038), built on this port in the same pull request.

## Design

### Requirements

- **V1.** `engines.freelens: ^2.0.0`; the extension activates in both processes of Freelens 2 with no
  error in the main log or in DevTools.
- **V2.** Every behaviour of SPEC-0003 to SPEC-0029 keeps holding on Freelens 2, unless this spec or
  the spec of the feature says otherwise in its "Notes and deviations".
- **V3.** Every Kubernetes request of the extension goes through Freelens: the host's stores and
  Kubernetes JSON client, the cluster proxy, and in main (from M9) `Main.K8s` or the host's
  `kubectl` through `Main.Shell` with its environment. No code path builds a client from a
  kubeconfig file.
- **V4.** Styles apply to the extension's own views only (CSS modules), in both themes.
- **V5.** A deactivation or a rebuild of the development loop leaves no poller, watch, timer,
  listener or (from M9) child process of the previous instance.
- **V6.** The tests and the scripts use only the clusters and kubeconfig files they create; they
  refuse any other context and any API server that is not local, and leave the developer's
  kubeconfig unchanged.
- **V7.** The write rules W1 to W12 of SPEC-0020 hold on v2: confirmation naming the cluster and the
  Kubernetes context, access review before an action is offered, no optimistic UI, failures
  reported, and a read-back test for every write.

### Process model

Unchanged for M1 to M7: everything in the renderer. Main keeps an empty `Main.LensExtension` until
M9 needs it (SPEC-0031 port-forward, SPEC-0034 configuration through `exec`, SPEC-0037 report file),
and then gets its own spec section there.

### Migration steps

The steps 0 to 7 of the skill's migration issue, one commit each, with the port's feature issues:
A data access, B views, C writes and forms, D terminal and logs, E test suites and lab. Every step
and feature reports what it checked.

### Safety

The port changes no write: the M6 and M7 writes keep their bodies, patch types and confirmations, and
each is read back on the kind cluster before and after the port.

## Tests (non-regression list)

- Unit: every test of 1.0.0 on the v2 stack (Vitest 5, React 19 testing); environment tests that
  prove `src/main`, `src/renderer` and `src/common` type-check as programs of their own.
- Built output: no `require(` or `global.` host reference, no bare host module import, no Node
  builtin in the renderer, no unlowered decorator, one CSS file next to the renderer entry,
  `dist/main.js` loads in Node with a stand-in host.
- E2E: the 52 scenarios of `cnpg-e2e.tests.ts` of 1.0.0 (now `integration/__tests__/cnpg-*.tests.ts`)
  and the pre-review pass green against Freelens dev of freelensapp/freelens `main` (then `v2.0.0`), on
  the kind cluster of `pnpm e2e:cluster:up`, locally and in CI.
- Baseline: every page, drawer, dialog and form in both themes against the screenshots of 1.0.0 on
  Freelens 1.10.3 on the same cluster; differences listed in "Notes and deviations".
- Manual verification: the development loop (directory install, a rebuild reloads once), a cluster
  without CloudNativePG, psql on Windows and macOS (lead maintainer).

## Notes and deviations

- **Dialogs follow the theme (feature C).** In Freelens 1.x the box of `ConfirmDialog` was white in both
  themes, so the action dialogs and the creation forms carried a dark ink of their own, light selects
  (`themeName="light"`) and a light YAML pane (`theme="vs"`). Freelens 2 paints the box with the theme
  (`--dialogBackground`, freelensapp/freelens#2257) and moved its own dialogs to `themeName="lens"`: on
  the dark theme the forms showed black text and white controls on a dark box. The dialogs now take
  their ink from the theme's tokens (`--textColorAccent`, `--textColorSecondary`, `--borderFaintColor`,
  fills mixed from the ink), the selects use the `lens` theme, the YAML pane follows the theme, and the
  warning ink stays the darker orange of 1.0.0 on the light theme only. On the light theme the dialogs
  look as in 1.0.0. DESIGN.md (creation forms) describes the new rule; SPEC-0020 and SPEC-0027 keep
  their facts of Freelens 1.10.3.
- **The width of a creation form (F3, feature C).** Freelens 2 renamed the inner box of `Dialog` from
  `.box` to `.dialog-content`: the rule that widens it while it holds a form matched nothing and the
  forms stopped at half the window. The rule names `.dialog-content`.
- **The re-read of W6 (feature C).** The retry after a conflict re-read the cluster with the store's
  `load`, which returns the object the store holds without asking the API server, so every attempt sent
  the version that was refused. Seen as a random failure of the lift of a fence (SPEC-0024, notes); the
  switchover and the restart of the primary shared it. The re-read now asks the API server.
- **Reload of the cluster frame (feature B).** A reload of the cluster frame on a page of the extension
  lands on the cluster's Overview after a few seconds, as on Freelens 1.10.3: the host redirects to its
  start URL before the extensions register their routes. Not a requirement of any spec; a question for
  the host.
- **The E2E suite on v2 (feature C, then E).** The scenarios run on the template's harness: Vitest
  attaches over CDP to Freelens dev (`integration/`, `vitest.integration.config.ts`,
  `pnpm test:integration`), with the lab's kubeconfig only, refused when it names a server that is not
  local. The write cases of M6 and M7 moved first (`cnpg-writes.tests.ts`), then the terminal and the
  logs (`cnpg-terminal-logs.tests.ts`), then the views (`cnpg-views.tests.ts`) and the pre-review pass
  (`pre-review.tests.ts`, out of the default run): the 52 scenarios of 1.0.0, unchanged but for the
  bootstrap, the theme switch and the versions. A `409` on a cluster, the conflict of W6 that the
  action retries, is not counted as an error of the run. The versions the cases expect (operator,
  Barman Cloud plugin) come from `e2e/scripts/lib.sh`, now at CloudNativePG 1.30.1 and the plugin
  v0.15.1. `pnpm e2e:freelens` (`e2e/scripts/freelens-dev.sh`) starts Freelens dev on a fresh profile
  that syncs the lab's kubeconfig alone; `pnpm e2e` and `run-suite.sh`, which ran the suite inside a
  Freelens 1.x checkout, are gone. The integration workflow is proposed in `github-workflow-fix/`
  and replaces `e2e-tests.yaml` and `integration-tests.yaml`.
- **The themes of the pre-review (feature E).** The theme switch is checked on the cluster frame
  (`theme-light` on its body). In 1.0.0 the dark walk ran on the default theme of the profile, the
  light one, so its "dark" screenshots were light and the dark theme was never reviewed by the pass.
- **psql and the logs (feature D).** Unchanged on v2. On a fresh profile the host downloads its kubectl
  for the cluster's version before the terminal starts, and the command the extension sends waits for
  the shell (freelensapp/freelens#2817): psql reaches its prompt on the primary and on a standby. The
  Logs page follows, pauses and filters, and its door opens the host's log viewer (`logTabStore`) on
  the primary. The tab of psql is titled `psql: <pod> (2)` because the host numbers the terminal
  tabs after its own, as in 1.10.3.
