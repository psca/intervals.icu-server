# Update completed activities

The user requested an update tool so feedback, load, pairing, and session details
can be changed after a completed activity has been recorded.

## Approach

Add `update_completed_activity` alongside `create_completed_activity`. A separate
tool makes the intent to edit an existing activity explicit; adding an upsert mode
to creation would mix creation defaults with partial-update semantics. Planned
workouts continue to use `add_or_update_event`.

## Contract

- Require `activity_id` and at least one supported change. Reuse creation's field
  validation with all editable fields optional. Allow `paired_event_id: null` to
  unpair; other fields are set explicitly, not cleared with null.
- Read the target activity first. Reject a missing/mismatched activity ID or an
  explicit `icu_athlete_id` belonging to a different athlete.
- Submit only supplied supported changes plus the target `id` to
  `PUT /activity/{id}`. Omitted fields remain omitted; never apply creation's
  elapsed-time default or infer subjective feedback or load.
- If either duration changes, validate the effective moving/elapsed values using
  the supplied change and existing counterpart. Require positive integer seconds
  and elapsed >= moving; if the existing counterpart is unusable, require both.
- Return the upstream activity as structured and text output. Its ID must match
  the target. A failed write or unusable response reports an unknown outcome and
  advises inspection before retrying; never retry automatically.
- Do not modify Session A or any other live activity during implementation.

## Files and verification

Extend `src/tools/activities.ts`; both entry points share its registration. Add
focused HTTP contract tests in `test/update-activity.test.ts`, update stdio tests
to 32 tools, and update README.md and canonical AGENTS.md to 8 activity tools.
Run focused tests through RED/GREEN, the full suite, both TypeScript checks, diff
checks, and independent review. Deployment remains a separate action.
