# Split Reconciliation Safety Hardening Design

## Goal

Close the stale-write and rollback-verification gaps in split-workout reconciliation before deploying the relaxed `Ride` and `VirtualRide` behavior.

## Scope

This change will:

- revalidate the exact current event and activity details before the first mutation;
- prevent writes when protected activity or event state changed after preview;
- verify rollback results by reading restored records;
- report ambiguous event creation outcomes as incomplete rollback;
- add mixed `Ride` and `VirtualRide` coverage;
- update canonical and ChatGPT coaching wording from same-sport matching to same-cycling-family matching.

This change will not:

- add an override parameter;
- change the approved eligibility or advisory rules;
- add an upstream idempotency or operation-journal scheme;
- change completed activity files beyond the existing pairing and name writes;
- modify the local `.agents` skill layout or its broken `references/` paths;
- deploy the Worker.

## Pre-Write Revalidation

The apply tool will retain its current initial candidate lookup and preview-fingerprint check. Before any `PUT`, `POST`, or `DELETE`, it will then fetch:

- the current event through the single-event endpoint;
- each ordered activity through the single-activity endpoint.

It will rebuild the candidate from those detailed records in the approved activity order. The detailed candidate must:

- remain supported;
- contain the same event and ordered activity IDs;
- produce the exact approved preview fingerprint.

Fingerprint comparison will use normalized cycling metadata so semantically equivalent missing and false indoor values do not create false stale-preview failures. All currently protected fields remain protected, including name, pairing, timing, intensity, type, indoor state, workout structure, replacements, and eligibility/advisory results.

If the detailed candidate differs, apply returns the existing changed-after-preview error and performs zero mutations.

The detailed event and activities become the rollback snapshots and the detailed candidate becomes the source for replacement writes. This removes the avoidable gap where newer activity details could be fetched and then overwritten without comparison.

## Rollback Verification

Rollback will continue to attempt these operations:

1. delete every replacement event whose ID was received;
2. restore the original event;
3. restore each activity's original pairing and name.

After those writes, rollback will read the records again and verify:

- every known created event is absent;
- the original event has its original name, duration, description, type, and normalized indoor state;
- each activity has its original paired-event ID and name.

`rollback_complete` is true only when every rollback write and every verification succeeds.

If an event creation request fails before its created event ID is received, the outcome is ambiguous: the server may have created an event even though the client did not receive the response. The tool cannot prove cleanup without an idempotency marker, so it must return `rollback_complete: false`.

This design intentionally reports uncertainty instead of introducing an unverified external-ID or upsert convention.

## Cycling-Family Coverage

Tests will cover one candidate containing both:

- a completed outdoor `Ride`, producing a `Ride` replacement with `indoor: false`;
- a completed `VirtualRide`, producing a `VirtualRide` replacement with `indoor: true`.

Tests will also mutate completed activity cycling metadata between preview/list loading and detailed revalidation. Apply must reject that stale state before any mutation.

The existing behavior remains unchanged:

- planned and completed `Ride` and `VirtualRide` records form one cycling family;
- the planned indoor flag is not an eligibility gate;
- completed intensity above 80% or missing intensity is advisory only;
- hard planned-workout limits, explicit approval, activity ordering, and fingerprints remain mandatory.

## Test Strategy

The server changes will use test-driven development with focused failure cases:

1. Detailed activity state changes after the approved list snapshot:
   - apply returns changed-after-preview;
   - no mutation request is sent.
2. A partial apply fails after replacement writes:
   - rollback restores and verifies original event and activity state;
   - `rollback_complete` is true.
3. A rollback write returns success without restoring state:
   - verification detects the mismatch;
   - `rollback_complete` is false.
4. Event creation has an ambiguous failed response:
   - rollback is attempted;
   - `rollback_complete` is false.
5. Mixed completed `Ride` and `VirtualRide` parts:
   - one cycling candidate is produced;
   - replacements and persisted events use the correct type and indoor state.

After focused tests, the complete server test suite and TypeScript compiler must pass.

## Coaching Documentation

The canonical `WORKOUT_PLANNING.md` and derived ChatGPT Project source will describe preview clustering as:

> same-cycling-family, same-local-day activities

The local `.agents` skill copy is explicitly outside this change because its flat layout requires a separate local packaging decision.

## Deployment

The resulting server and coach changes will be committed locally. Production deployment requires a separate explicit approval after verification and review.
