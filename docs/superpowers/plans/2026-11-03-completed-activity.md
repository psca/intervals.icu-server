# Completed Activity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline. Steps use checkbox syntax for tracking.

**Goal:** Add `create_completed_activity` for finished sessions, including strength workouts.

**Architecture:** Register the tool in the existing shared activity registration. Use the existing JSON client, local timestamp schema, and structured/text result helpers.

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest, Cloudflare Workers and Node stdio.

**Spec:** `docs/superpowers/specs/2026-11-03-completed-activity-design.md`

## Global Constraints

- Do not reimport Session A or deploy as part of implementation.
- Require name, sport type, athlete-local timestamp, and positive integer moving time.
- Optional elapsed time must be a positive integer at least moving time; default to moving time.
- Optional description, nonnegative distance in metres, and nonempty external ID.
- Send only supported fields; never infer RPE, calories, or training load.
- Preserve CLAUDE.md as a symlink to AGENTS.md.

## Review Focus

- Missing or whitespace-only required text must cause no write.
- Invalid calendar dates and timezone suffixes must cause no write.
- Zero, fractional, nonfinite, or inverted durations must cause no write.
- Successful HTTP responses without usable activity IDs must report an unknown outcome.
- Network and API failures must produce MCP errors without retrying writes.

### Task 1: Completed activity tool and contract tests

**Files:** Modify `src/tools/activities.ts`, `test/activities.test.ts`, `test/stdio.test.ts`.

**Interfaces:** Consume `localTimestampSchema`, `IntervalsClient.post`, and existing result helpers. Produce registered tool `create_completed_activity`, returning `{ activity: Record<string, unknown> }` in structured and text output.

- [x] Add tests for a 2,760-second WeightTraining Session A with description preserved, minimal creation and elapsed-time default, explicit distance/elapsed time, validation failures from Review Focus, API/network failures, and malformed creation responses. Mock fetch so the real client and serialization run.
- [x] Update expected tool count to 31 and names to include `create_completed_activity`.
- [x] Run `npm test -- test/activities.test.ts test/stdio.test.ts`; expect failures because the tool is missing.
- [x] Implement input validation before writing, one POST to `/athlete/{athleteId}/activities/manual`, supported-field projection, ID validation, and unknown-outcome guidance for write failures.
- [x] Run `npm test -- test/activities.test.ts test/stdio.test.ts`; expect all tests passing.

### Task 2: Documentation and verification

**Files:** Modify `README.md`, `AGENTS.md` and update this plan's checkboxes.

**Interfaces:** Document the Task 1 tool name, fields, description semantics, and retry limitation.

- [x] Update inventories to 31 tools / 7 activity tools and document completed activity creation with a generic example.
- [x] Run `npm test`, `npx tsc --noEmit`, `npx tsc -p tsconfig.stdio.json --noEmit`, and `git diff --check`; expect all successful. Verify the CLAUDE.md symlink.
- [x] Review the complete diff, resolve material findings, and leave changes available for user review without deployment.

## Execution evidence

- RED: 34 failures / 14 passes before implementation; failures were the missing tool and registration expectations.
- GREEN: focused activity/stdio checks passed, 48/48 tests.
- Full suite: 299/299 tests passed. Both TypeScript configurations passed.
- Independent final review found no material issues.
- CLAUDE.md remains a symlink to AGENTS.md. Session A was not imported again.
- Changes remain uncommitted on `feat/completed-activity-tool`; no deployment was performed.

## Follow-up: feedback, pairing, and supplied load

- [x] Add failing contracts for `icu_rpe`, `feel`, `paired_event_id`, and supplied
  `icu_training_load`; verify that invalid values cause no writes, zero manual
  load is preserved, and omitted load is never derived from RPE.
- [x] Add the four optional fields to the existing input schema and document the
  distinction between `session_rpe` and fitness/fatigue training load.
- [x] Run the full test suite, both TypeScript configurations, and diff checks.
- [x] Review the follow-up without modifying Session A or deploying it.

Follow-up evidence: 16 expected failures before implementation; 315/315 tests
passed afterwards. Both TypeScript configurations and diff checks passed.
Independent review found no material issues. Feedback/load/pairing fields have
contract-test coverage; no new live activity was created to test these fields.
