# Instructions for GitHub Copilot and other coding agents

The canonical agent guide for this repository is [AGENTS.md](../AGENTS.md)
in the repository root. Read it first and follow it strictly, in particular:

- the licensing and provenance constraints: this extension is MIT and written
  from scratch; other CloudNativePG user interfaces and tools are references
  only, never copy code, styles or UI strings from them;
- the safety rules: read-only first, write actions only behind an explicit
  confirmation that names the cluster and the Kubernetes context, no
  user-supplied SQL in the programmatic path, no stored database credentials;
- the spec-driven process and the testing requirements documented under
  `docs/development/` once present: no feature without an approved spec,
  every feature ships with unit, integration and end-to-end tests;
- the CRD KubeObject pattern, the code style and the text rules in AGENTS.md.
