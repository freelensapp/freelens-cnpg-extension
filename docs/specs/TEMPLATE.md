# SPEC-NNNN: Title

- **Status:** Draft | Approved | Implemented | Verified | Superseded
- **Milestone:** `M<n>` (see [ROADMAP.md](../development/ROADMAP.md))
- **CloudNativePG version reviewed:** `v<x.y.z>`
- **Author / date:**

## Goal

What the user can do when this is done, in one or two sentences.

## Upstream reference

Which CloudNativePG concepts, `kubectl cnpg` subcommands, documentation
pages or other user interfaces this feature relates to (links). Reminder:
functional and domain reference only, no code copying (see
ARCHITECTURE.md).

## Scope

What is included. What is explicitly excluded (and where it goes instead).

## Design

- **Standard or ad hoc view, and why.** State whether the task is best
  served by the Freelens list plus drawer vocabulary or by an ad hoc view
  (overview, topology, timeline, live panel), and what makes it the best
  possible experience for the task ([DESIGN.md](../development/DESIGN.md),
  "Ad hoc views"). For an ad hoc view, describe the grid (rows, cards,
  content, what each click leads to) and the data source of every card.
- CRDs and endpoints involved, fields read (from the CRD schemas and the
  instance manager or metrics contracts recorded in SPEC-0001).
- Freelens extension points used (pages, detail items, menus, actions).
- UI sketch or description of columns, panels, and states.
- Error and empty states.
- UI/UX conformance to [DESIGN.md](../development/DESIGN.md): column
  grammar, status classifier and badge mapping, drawer sections, the four
  non-happy states, both themes. Any deviation is declared here and
  updates DESIGN.md in the same PR (or is dropped).
- Safety: what the feature reads, what it writes (normally nothing), which
  confirmation it asks for, what it must never do (AGENTS.md, "Safety
  rules").

## Tests (non-regression list)

- Unit: `<test file>`: `<cases>`
- Integration: `<what the harness asserts>`
- E2E: `<Playwright scenario>`
- Manual verification (if any): exact steps, expected outcome, and the
  recorded result (date, tester).

## Notes and deviations

Filled during implementation when reality diverges from the plan.
