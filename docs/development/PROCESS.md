# Development process (spec-driven)

This repository is developed spec-first. The process below is binding for
every contributor, human or agent (Claude, Copilot, or any other coding
agent). Agents discover it via [AGENTS.md](../../AGENTS.md) and
`.github/copilot-instructions.md`, which both point here.

## The loop

1. **Spec before code.** Every feature starts as a spec file in
   `docs/specs/`, numbered `SPEC-NNNN-short-slug.md`, written from
   [TEMPLATE.md](../specs/TEMPLATE.md). No implementation PR without an
   approved spec.
2. **Approval.** The lead maintainer of this extension approves the spec,
   in the PR that introduces it or by saying so in the tracking issue.
3. **Implementation.** One PR per feature slice. The PR links the spec. The
   implementation must not silently diverge from the spec: if reality forces
   a change, update the spec in the same PR and call the change out in the
   PR description.
4. **Tests are part of the feature.** See [TESTING.md](TESTING.md). A
   feature without its non-regression tests is not done.
5. **Docs updated in the same PR.** ROADMAP.md status, the spec's status
   field, and ARCHITECTURE.md (when structure changed) are updated in the
   same PR as the code. A PR that leaves docs stale is incomplete.
6. **Verification.** After merge, the spec status moves to Verified only
   when the non-regression tests run green in CI on main, plus a manual
   check when the spec requires one.
7. **Post-merge closure (do not skip).** Merging a feature PR is not the
   end of the loop: whoever merges immediately checks the CI runs on main
   and then lands a small follow-up (PR or docs commit) that moves the
   ROADMAP rows from "In PR" to "Done" and the spec Status to Verified.
   A milestone is closed only when the docs on main say so. An
   implementation PR can only write "In PR" about itself, so this step
   can never be folded into the feature PR; it exists precisely because
   it is otherwise the easiest thing to forget.

## Spec statuses

`Draft`, then `Approved`, then `Implemented`, then `Verified`. Superseded
specs get status `Superseded` with a pointer to the replacement; nothing is
deleted.

## The design question every spec answers

Freelens offers a standard vocabulary (list pages, detail drawers, menus)
and this extension uses it wherever a Kubernetes resource is the subject.
It is not the ceiling. For every task the user performs, the spec's Design
section states whether the view is **standard** (list plus drawer) or
**ad hoc** (an overview page, a topology, a timeline, a live panel) and why
the chosen one is the best possible experience for that task. See
[DESIGN.md](DESIGN.md), section "Ad hoc views".

## Manual testing escalation

Some behavior cannot be verified automatically (for example: the lived
experience of the live database view against a busy PostgreSQL, the psql
terminal on every desktop platform, a real failover on a production-like
cluster). In that case:

1. The spec lists the manual test steps under "Manual verification".
2. The agent or contributor asks the lead maintainer to run them, providing
   exact steps and expected outcomes.
3. The result is recorded in the spec (date, result, tester) before the
   feature is marked Verified.

## Milestone manual review gate

Automated tests prove behavior; they do not prove the experience. At the
end of every milestone (after the post-merge closure step), the lead
maintainer runs a manual review session in a real Freelens before the next
milestone starts:

0. Precondition: the pre-review agent pass has run and its report is in
   the reviewer's hands (see [TESTING.md](TESTING.md)): the agent has
   already verified everything automatable, so the human session covers
   only judgment calls, the report's "for human judgment" list, and what
   cannot be automated.
1. Bring up the demo environment (`pnpm demo:up`, procedure in
   [TRY-IT.md](TRY-IT.md) once it exists).
2. Walk through every view the milestone introduced, on both themes,
   asking of each one "is this the best possible view for the task?".
3. Record findings as issues (one per finding, or one umbrella issue per
   session) and the session outcome (date, tester, verdict) in the specs
   involved.
4. Blocking findings are fixed before the next milestone begins; the fixes
   follow the normal loop.

The review is per milestone, not once at the end: feedback on `M(n)` must
arrive before its patterns are replicated in `M(n+1)`.

## Upstream drift watch

CloudNativePG releases a minor version roughly every quarter and the
`postgresql.cnpg.io/v1` API gains fields, deprecations and new kinds with
each one. At the start of every milestone (and before every release of the
extension):

1. Check the latest CloudNativePG release and its release notes.
2. Diff the CRD schemas of the release manifest against the version the
   types were written from; record the reviewed CloudNativePG version in
   the affected specs.
3. File an issue for any breaking change or any newly deprecated field the
   extension still shows as current.

## Working agreements

- Branch names: short kebab-case (`add-cluster-views`, `bootstrap-e2e`);
  `claude/issue-N-slug` when starting from an issue (see AGENTS.md).
- Plain commit messages, no conventional-commit prefixes, no emoji, no em
  dash.
- PRs against `main`, squash merge, CI green required.
- External contributions follow the same spec-first loop; maintainers help
  contributors write the spec when needed.

## Reuse beyond this repository

These practices are shared with the other freelensapp extensions and are
meant to be generalized into a common repository. Keep this file
self-contained (no references to details that only exist in this repo,
except in examples) so extraction stays cheap.
