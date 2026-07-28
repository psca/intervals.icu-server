# Split Reconciliation Across Ride Types

## Goal

Allow split-workout reconciliation when a planned cycling workout and the completed activity files differ between `Ride` and `VirtualRide`. This covers cases where an athlete planned an indoor session but chose to ride outdoors instead.

Completed activity intensity is useful context, but it must not block this calendar and pairing repair.

## Eligibility

Treat `Ride` and `VirtualRide` as one cycling family when detecting candidate activity clusters and matching them to a planned event. The planned event's `indoor` flag is not an eligibility gate.

Keep these hard safety requirements:

- The planned event is either `Ride` or `VirtualRide`.
- The planned duration is at least 60 minutes and can be allocated in five-minute units.
- The workout description is a deterministic sequence of timed steps.
- Repeat blocks, distance-based steps, untimed steps, and ambiguous structures remain unsupported.
- Every structured planned power target uses `%ftp` and is at or below 75% FTP.
- At least two completed cycling activities form the existing same-day, bounded-gap pairing candidate.

Do not add an override parameter. This behavior is the default for every eligible reconciliation.

## Intensity Handling

Completed activity intensity does not determine whether reconciliation is supported.

- Intensity above 80% becomes a non-blocking advisory containing the activity ID and measured value.
- Missing intensity also becomes a non-blocking advisory.
- Hard eligibility failures remain in `warnings`.
- Non-blocking context is returned separately in `advisories` so agents cannot mistake it for a refusal.

The existing `EASY_CONTINUOUS_RIDE` classification remains for compatibility. It describes the planned workout structure and targets, not whether every completed part stayed below a fixed execution-intensity ceiling.

## Replacement Events

Each replacement event must reflect its paired completed activity:

- Use the completed activity's `type` (`Ride` or `VirtualRide`) for that replacement event.
- Set `indoor` to `true` for `VirtualRide` and `false` for `Ride`.
- Preserve the proportional five-minute allocation, original total planned duration, workout step splitting, names, and warmup/cooldown placement.
- Continue using the existing event for the first replacement and creating subsequent events for later parts.

This means a planned `VirtualRide` completed as two outdoor rides becomes two outdoor `Ride` events after reconciliation.

## Preview and Apply Flow

The write workflow is unchanged:

1. Preview detects the candidate and returns replacement events, hard warnings, non-blocking advisories, ordered activity IDs, and a fingerprint.
2. The agent presents the proposed changes and advisories.
3. The athlete explicitly approves the preview.
4. Apply reloads the candidate, verifies its fingerprint and ordering, writes the replacement events, pairs and renames the activities, and verifies persisted state.
5. A failed partial write attempts the existing rollback.

Extend the fingerprint payload to cover event and activity type, indoor state, intensity, pairing, timing, names, and replacements so a material change requires a fresh preview and renewed approval.

## Coach Skill and Tooling

Update every maintained triathlon-training skill surface:

- `intervals.icu-coach/skills/triathlon-training/SKILL.md`, including the MCP tool map and split-workout route;
- `intervals.icu-coach/skills/triathlon-training/references/COACH.md`;
- `intervals.icu-coach/skills/triathlon-training/references/WORKOUT_PLANNING.md`;
- `intervals.icu-coach/docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md`;
- the workspace skill copy at `.agents/skills/triathlon-training`, keeping its tool map and relevant references synchronized with the canonical coach skill.

The updated tooling must:

- describe `Ride` and `VirtualRide` as one eligible cycling family;
- treat completed intensity above 80% or missing intensity as advisory only;
- present `advisories` before asking for approval;
- retain all preview, confirmation, fingerprint, ordering, and rollback safeguards.

## Tests

Add or update tests for:

- a planned `VirtualRide` paired with outdoor `Ride` activities;
- replacement events normalized to the completed activity type and indoor state;
- completed intensities of 80.1% and 80.6% producing advisories while remaining supported;
- missing completed intensity producing an advisory while remaining supported;
- genuinely hard planned-workout and structure failures still being rejected;
- stale fingerprints still preventing every write;
- existing outdoor-to-outdoor behavior remaining unchanged.

Run the focused split-reconciliation and tool-registration tests, then the full server test suite before completion.

## Out of Scope

- Reconciliation across non-cycling sports.
- Merging or deleting completed activity files.
- Relaxing planned power or workout-structure limits.
- Guaranteeing a particular compliance score after Intervals.icu recalculates it.
