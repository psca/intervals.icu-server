# Update Completed Activity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with TDD and final independent review.

**Goal:** Edit an existing completed activity while preserving omitted fields.

**Architecture:** Reuse creation field schemas as optional inputs, read the
existing target, validate effective durations, and make one partial PUT.

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-update-activity-design.md`

## Global Constraints

- No creation defaults or guessed feedback/load on updates.
- No live activity mutations or deployment during implementation.
- Keep CLAUDE.md as the AGENTS.md symlink; preserve existing uncommitted changes.

## Review Focus

- Feedback-only edits must not overwrite descriptions, pairing, or durations.
- An omitted pairing must stay omitted; explicit null must unpair.
- One-field duration changes must be validated against current values.
- Invalid inputs, missing targets, and different-athlete targets must not write.
- Ambiguous writes/malformed response IDs must not report success or retry.

### Task 1: Tool and contracts

**Files:** `src/tools/activities.ts`, `test/update-activity.test.ts`, `test/stdio.test.ts`.

**Interfaces:** Register `update_completed_activity` with required `activity_id`,
optional creation fields, nullable pairing, and `{ activity }` output.

- [x] Write HTTP contract tests for partial edits, clearing descriptions/unpairing,
  explicit zero distance/load, validation, effective durations, target checks,
  preflight failure, write failure, and response-ID mismatches.
- [x] Change expected registration to 32 tools; run focused tests and observe RED.
- [x] Implement schema reuse, read preflight, supported-field PUT, and error handling.
- [x] Run focused tests and observe GREEN.

### Task 2: Documentation and verification

**Files:** `README.md`, `AGENTS.md`, this plan.

**Interfaces:** Document Task 1 fields, partial-write semantics, and error behavior.

- [x] Update inventories and document an example feedback-only update.
- [x] Run `npm test`, `npx tsc --noEmit`,
  `npx tsc -p tsconfig.stdio.json --noEmit`, and `git diff --check`.
- [x] Obtain independent review, address material findings, and record results.

## Execution evidence

- RED: 33 expected failures before the tool was registered (31 new contracts and
  2 registration expectations); existing credential checks still passed.
- GREEN: 95/95 focused activity/update/stdio tests passed.
- Full suite: 346/346 tests passed. Both TypeScript configurations and diff checks
  passed. CLAUDE.md remains the AGENTS.md symlink.
- Independent review found no material issues.
- The update implementation remains local and uncommitted. No live activity was
  modified, and this tool has not been deployed.
