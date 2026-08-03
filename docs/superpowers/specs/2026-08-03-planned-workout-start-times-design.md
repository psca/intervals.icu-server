# Planned Workout Start Times Design

## Problem

Intervals.icu planned events support athlete-local start timestamps through the
upstream `start_date_local` field. The MCP `add_or_update_event` tool currently
exposes only a date-only `start_date` and always converts it to midnight. This
prevents callers from ordering multiple planned workouts on one calendar day.

The same behavior also means an update that omits `start_date` currently sends
today at midnight, which can move an existing event unexpectedly.

## Confirmed upstream contract

The Intervals.icu `EventEx` create and update request schema includes
`start_date_local` as a string. A live partial update accepted a value such as
`2026-08-04T19:00:00`, stored it unchanged, and calculated the event end time
from the planned duration.

`start_date_local` is an athlete-local wall-clock timestamp. It does not carry a
UTC offset or IANA timezone name. For an athlete configured for
`Europe/London`, `2026-08-04T19:00:00` means 19:00 in London.

## Tool contract

Add an optional `start_date_local` input to `add_or_update_event`:

- Format: `YYYY-MM-DDTHH:mm:ss`.
- Meaning: local time in the athlete's Intervals.icu timezone.
- The tool description must state that callers should not append `Z` or a UTC
  offset.
- Keep the existing `start_date` input for backward compatibility.
- When both inputs are supplied, `start_date_local` takes precedence.

The field applies to both creation and update because both upstream operations
accept the same event request field.

## Data flow

For event creation:

1. Use `start_date_local` when supplied.
2. Otherwise convert `start_date` to `${start_date}T00:00:00`.
3. If neither is supplied, use today's date at midnight, preserving current
   create behavior.

For event update:

1. Use `start_date_local` when supplied.
2. Otherwise convert `start_date` to `${start_date}T00:00:00` when supplied.
3. If neither is supplied, omit `start_date_local` from the upstream payload so
   an unrelated update preserves the event's existing timestamp.

All other event fields and the create/update endpoints remain unchanged.

## Validation and errors

Validate `start_date_local` as a zero-padded local ISO timestamp with seconds.
Reject date-only values, timezone suffixes, offsets, invalid months, invalid
days, and invalid clock times at the MCP schema boundary. Keep the existing
date-only contract for `start_date`.

## Tests

Extend `test/events.test.ts` with regression coverage that verifies:

- A timed create sends the exact `start_date_local` value upstream.
- A timed update sends the exact `start_date_local` value upstream.
- A date-only create/update still maps `start_date` to midnight.
- An update with neither date field omits `start_date_local`.
- `start_date_local` takes precedence when both fields are supplied.
- Invalid local timestamps are rejected before an upstream request.

Run the focused event tests followed by the full test suite and TypeScript
build/typecheck command defined by the project.

## Out of scope

- Converting between arbitrary IANA timezones.
- Fetching or changing the athlete timezone.
- Adding a separate `start_time` field.
- Renaming or removing the backward-compatible `start_date` field.
