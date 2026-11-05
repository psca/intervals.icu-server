# Completed activity creation

Status: approved for implementation on 2026-11-03.

## Intent

Allow MCP clients to record finished sessions, including strength training, as
completed activities. Existing event tools handle planned workouts, while activity
tools currently only read data. Intervals.icu documents JSON creation at
`POST /api/v1/athlete/{id}/activities/manual`.

## Approaches

1. **General `create_completed_activity` tool (recommended).** Use the existing
   client and activity registration shared by Worker and stdio. Preserve strength
   sets in the description. This covers the supplied session with a small change.
2. **Dedicated strength import tool.** Accept structured exercises and sets and
   generate a description. This adds a separate input model and formatting rules;
   the upstream Activity schema does not expose structured strength sets.

The user approved the general tool approach.

## Proposed contract

- Required: nonempty `name`, nonempty sport `type`, valid athlete-local
  `start_date_local` (`YYYY-MM-DDTHH:mm:ss`, no offset), and positive integer
  `moving_time` in seconds. Strength sessions use `WeightTraining`.
- Optional: `description`, positive integer `elapsed_time` (at least
  `moving_time`), nonnegative `distance` in metres, and nonempty `external_id`.
- Follow-up: optional athlete-reported `icu_rpe` (integer 1–10), `feel` (integer
  1–5, 1=strong/3=normal/5=weak), and `paired_event_id` (positive integer calendar
  event ID). An optional explicit `icu_training_load` (nonnegative integer) is
  also supported for supplying a known manual load. These fields are passed
  through on the existing POST; its returned activity is authoritative. Do not
  convert the separate `session_rpe` score to training load or copy planned load
  when pairing. This follow-up does not update the already uploaded Session A.
- Reuse the existing local timestamp validation. Default omitted `elapsed_time`
  to `moving_time`. Submit only the supported fields through `client.post`.
- Return the upstream activity in matching structured and text output, following
  the existing activity tools. Require a usable returned activity ID before
  reporting creation as successful.
- Never infer RPE, calories, active lifting time, or training load from set data.
  The supplied session uses its recorded 46-minute session duration.
- No automatic retries or promise of upstream idempotency. A failed write may
  have succeeded upstream; instruct clients to inspect activities before retrying.

## Scope and validation

Add the tool to `src/tools/activities.ts`; both entry points already use that
registration function. Add meaningful contract tests for the supplied strength
session, minimal creation, invalid timestamps/durations, API errors, and missing
response IDs. Update stdio registration expectations from 30 to 31 tools and
update the tool inventory and semantics in README.md and canonical AGENTS.md.
Keep CLAUDE.md as its existing symlink.

Run the affected tests, full Vitest suite, and both TypeScript configurations.
Deployment is a separate action from this proposed implementation.

CSV parsing, file uploads, native per-set storage, activity editing/deletion,
library management, and planned workout behavior are outside this change.

## Supplied session

The requested Session A has already been created and read back successfully:
the activity, `WeightTraining`, its recorded local start,
duration 2,760 seconds. Its description preserves all 15 supplied sets across six
exercises, including the 0 kg step-up set. Implementation must not import it again.
