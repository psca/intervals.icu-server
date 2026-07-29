# Split Reconciliation Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale detailed activity state from being overwritten and make `rollback_complete` mean the original state was read back and verified.

**Architecture:** Keep the existing preview, apply, and rollback flow in `src/tools/split-reconciliation.ts`. Add a normalized cycling-state boundary, rebuild the approved candidate from current single-record responses before the first write, and add a rollback verifier that reads every affected record. Extend the stateful API test fixture to model stale list/detail views, partial failures, silent restore mismatches, and ambiguous event creation.

**Tech Stack:** TypeScript 5.9, Zod, MCP SDK, Vitest, Cloudflare Workers, Markdown coach sources.

## Global Constraints

- Keep the approved `Ride` and `VirtualRide` cycling-family behavior.
- Keep completed intensity above 80% and missing intensity advisory-only.
- Do not add an override parameter.
- Perform zero mutations when detailed revalidation differs from the approved preview.
- Set `rollback_complete: true` only after every rollback write and read-back verification succeeds.
- Treat an event creation whose response fails before an ID is received as ambiguous and therefore incomplete rollback.
- Do not add an upstream idempotency or external-ID convention.
- Do not modify the local `.agents` skill layout or files.
- Do not deploy the Worker without separate explicit approval.

---

## File Structure

### Server repository: `intervals.icu-server`

- Modify `src/tools/split-reconciliation.ts`: normalize indoor state, revalidate detailed records, track ambiguous creates, and verify rollback.
- Modify `test/split-reconciliation.test.ts`: extend the stateful API fixture and cover detail drift, rollback outcomes, and mixed cycling types.

### Coach repository: `intervals.icu-coach`

- Modify `skills/triathlon-training/references/WORKOUT_PLANNING.md`: replace same-sport wording with same-cycling-family wording.
- Modify `docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md`: mirror the canonical wording.

---

### Task 1: Revalidate Detailed State Before the First Write

**Files:**

- Modify: `test/split-reconciliation.test.ts:20-120`
- Modify: `test/split-reconciliation.test.ts:252-305`
- Modify: `src/tools/split-reconciliation.ts:45-52`
- Modify: `src/tools/split-reconciliation.ts:292-303`
- Modify: `src/tools/split-reconciliation.ts:345-373`
- Modify: `src/tools/split-reconciliation.ts:491-507`

**Interfaces:**

- Produces: `normalizedIndoor(record: RecordValue): boolean`
- Preserves: `fingerprint(candidate: Candidate): Promise<string>`
- Preserves: apply input schema and changed-after-preview error
- Guarantees: the single-event and single-activity records are fingerprinted before mutation

- [ ] **Step 1: Separate list snapshots from detailed state in the mutable API fixture**

In `installMutableApi`, keep immutable list responses and mutable detail records:

```ts
const eventListState = { ...initialEvent };
const activityListState = initialActivities.map(activity => ({ ...activity }));
const activityState = new Map(
  initialActivities.map(activity => [String(activity.id), { ...activity }]),
);
let eventState = { ...initialEvent };
```

Return a detail-only activity mutator:

```ts
setActivityState(id: string, value: Record<string, unknown>) {
  activityState.set(id, value);
},
```

Use `eventListState` and `activityListState` for collection endpoint responses. Continue using `eventState` and `activityState` for single-record endpoints.

This fixture deliberately models the reviewed failure: the collection snapshot can remain stale while the detail endpoint already exposes newer state.

- [ ] **Step 2: Add a failing zero-write test for detailed activity drift**

Add:

```ts
it("rejects changed activity details before making any writes", async () => {
  const api = installMutableApi(event, activities);
  const server = await createStdioServer("test-key", "i388529");
  const preview = await callTool(server, "preview_split_workout_reconciliation", {
    date: "2026-07-12",
  });
  const candidate = preview.structuredContent.candidates[0];
  api.setActivityState("i164885877", {
    ...api.activityState.get("i164885877"),
    type: "VirtualRide",
    indoor: true,
    name: "Changed after preview",
  });

  const result = await callTool(server, "reconcile_split_workout", {
    date: "2026-07-12",
    event_id: String(event.id),
    activity_ids: activities.map(activity => activity.id),
    fingerprint: candidate.fingerprint,
    confirm: true,
  });

  expect(result.structuredContent.applied).toBe(false);
  expect(result.structuredContent.error).toMatch(/changed after preview/);
  expect(api.writeCount).toBe(0);
});
```

Production change caught by this test: removing detailed-candidate fingerprint comparison would allow the first unpairing `PUT`.

- [ ] **Step 3: Run the focused test and verify the expected failure**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: the new test fails because current apply accepts the old collection fingerprint and starts writing after fetching the changed detail.

- [ ] **Step 4: Normalize indoor state for replacements and fingerprints**

Add:

```ts
function normalizedIndoor(record: RecordValue): boolean {
  if (typeof record.indoor === "boolean") return record.indoor;
  return cyclingType(record) === "VirtualRide";
}
```

Use it in replacements:

```ts
indoor: normalizedIndoor(activity),
```

Use it in fingerprint payloads:

```ts
event: {
  // existing fields
  indoor: normalizedIndoor(candidate.event),
},
activities: candidate.activities.map(activity => ({
  // existing fields
  indoor: normalizedIndoor(activity),
})),
```

Use it in `originalEventWritePayload`:

```ts
indoor: normalizedIndoor(event),
```

This makes missing and false indoor values equivalent while retaining `VirtualRide` fallback behavior.

- [ ] **Step 5: Rebuild and fingerprint the detailed candidate**

Replace the current post-fingerprint detail loading with:

```ts
const detailedEvent = await client.get<RecordValue>(
  `/athlete/${client.athleteId}/events/${event_id}`,
);
const detailedActivities = await Promise.all(
  activity_ids.map(id => client.get<RecordValue>(`/activity/${id}`)),
);
const detailedCandidate = buildCandidate(detailedEvent, detailedActivities);
const detailedIds = detailedCandidate.activities.map(activity => String(activity.id));
if (!detailedCandidate.supported
  || String(detailedCandidate.event.id) !== event_id
  || detailedIds.join(",") !== activity_ids.join(",")
  || await fingerprint(detailedCandidate) !== expectedFingerprint) {
  throw new Error("The workout or activities changed after preview. Run the preview again.");
}

originalEvent = detailedEvent;
originalActivities = detailedActivities;
```

Use `detailedCandidate.replacements` for event writes, activity names, and final verification after this point. Rename the collection candidate to `previewCandidate` so the write source is unambiguous.

Do not assign `originalEvent` or `originalActivities` until detailed authorization succeeds. A stale rejection must not enter rollback because no mutation occurred.

- [ ] **Step 6: Add mixed completed cycling types to the successful apply test**

Change the successful activity fixture so the second completed part is virtual:

```ts
const mixedActivities = activities.map((activity, index) => index === 0
  ? { ...activity, type: "Ride", indoor: false, icu_intensity: 80.1 }
  : { ...activity, type: "VirtualRide", indoor: true, icu_intensity: 80.6 });
```

Assert the preview remains one supported candidate and the persisted events match each part:

```ts
expect(candidate.replacements).toMatchObject([
  { type: "Ride", indoor: false },
  { type: "VirtualRide", indoor: true },
]);
expect(api.eventState).toMatchObject({ type: "Ride", indoor: false });
expect(api.createdEvents[0]).toMatchObject({ type: "VirtualRide", indoor: true });
```

This is a characterization test for already intended family grouping and a regression test for per-part write metadata.

- [ ] **Step 7: Run the focused tests**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: every split reconciliation test passes, including zero-write detailed drift and mixed activity types.

- [ ] **Step 8: Commit detailed revalidation**

Run:

```bash
git diff --check
git add src/tools/split-reconciliation.ts test/split-reconciliation.test.ts
git commit -m "fix: revalidate split details before writes"
```

---

### Task 2: Verify Rollback and Report Ambiguous Creation

**Files:**

- Modify: `test/split-reconciliation.test.ts:20-120`
- Modify: `test/split-reconciliation.test.ts:305-end`
- Modify: `src/tools/split-reconciliation.ts:389-419`
- Modify: `src/tools/split-reconciliation.ts:491-585`

**Interfaces:**

- Produces: `eventMatchesReplacement(event: RecordValue, replacement: Replacement): boolean`
- Produces: `activityMatchesSnapshot(activity: RecordValue, snapshot: RecordValue): boolean`
- Produces: `verifyRollback(client, eventId, originalEvent, originalActivities, createdEventIds): Promise<boolean>`
- Preserves: apply result schema
- Tightens: `rollback_complete` semantics

- [ ] **Step 1: Extend the mutable API fixture for failure injection and deletion**

Add optional fixture controls:

```ts
interface MutableApiOptions {
  failPairingActivityId?: string;
  ignoreRollbackEventRestore?: boolean;
  ambiguousCreateFailure?: boolean;
}
```

Track event updates:

```ts
let eventPutCount = 0;
let rollbackStarted = false;
let rollbackVerificationReadCount = 0;
```

For event `PUT`, increment the count. When `eventPutCount > 1`, set `rollbackStarted = true`. When `ignoreRollbackEventRestore` is true and `eventPutCount > 1`, return success without changing `eventState`.

For activity pairing `PUT`, throw when all conditions match:

```ts
if (options.failPairingActivityId === id && body.paired_event_id != null) {
  return Promise.reject(new Error("Injected pairing failure"));
}
```

For created events, assign unique IDs:

```ts
const created = { id: 222 + createdEvents.length, ...body };
createdEvents.push(created);
```

When `ambiguousCreateFailure` is true, push the created event and then reject the response:

```ts
if (options.ambiguousCreateFailure) {
  return Promise.reject(new Error("Injected ambiguous create failure"));
}
```

Add `DELETE /events/{id}` handling that removes the matching created event.
Set `rollbackStarted = true` when handling this delete.

For a single-event `GET` whose ID is neither the original event nor a known created event, return a mock `404` response:

```ts
return Promise.resolve({
  ok: false,
  status: 404,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve("Not found"),
});
```

While `rollbackStarted` is true, increment `rollbackVerificationReadCount` only for:

- the original event's single-record `GET`;
- each activity's single-record `GET`.

Do not count the created-event absence check. Return `rollbackVerificationReadCount` with the other fixture accessors.

- [ ] **Step 2: Add a failing test for verified successful rollback**

Add:

```ts
it("verifies restored event and activity state after a partial apply failure", async () => {
  const virtualEvent = { ...event, type: "VirtualRide", indoor: true };
  const api = installMutableApi(virtualEvent, activities, {
    failPairingActivityId: "i164885877",
  });
  const server = await createStdioServer("test-key", "i388529");
  const preview = await callTool(server, "preview_split_workout_reconciliation", {
    date: "2026-07-12",
  });
  const candidate = preview.structuredContent.candidates[0];

  const result = await callTool(server, "reconcile_split_workout", {
    date: "2026-07-12",
    event_id: String(event.id),
    activity_ids: activities.map(activity => activity.id),
    fingerprint: candidate.fingerprint,
    confirm: true,
  });

  expect(result.structuredContent.applied).toBe(false);
  expect(result.structuredContent.rollback_attempted).toBe(true);
  expect(result.structuredContent.rollback_complete).toBe(true);
  expect(api.createdEvents).toEqual([]);
  expect(api.eventState).toMatchObject({
    name: virtualEvent.name,
    type: "VirtualRide",
    indoor: true,
    moving_time: 7200,
    description: virtualEvent.description,
  });
  expect(api.activityState.get("i164875648")).toMatchObject({
    paired_event_id: event.id,
    name: event.name,
  });
  expect(api.activityState.get("i164885877")).toMatchObject({
    paired_event_id: null,
    name: "Singapore Road Cycling",
  });
});
```

The existing implementation may return true, but it has no verification GETs. To make the test fail for the missing behavior, also assert the fixture's single-record read count increases during rollback verification:

```ts
expect(api.rollbackVerificationReadCount).toBe(3);
```

Count only the original event and two activity GETs performed after rollback writes.

- [ ] **Step 3: Add failing tests for silent restore mismatch and ambiguous creation**

Add:

```ts
it("marks rollback incomplete when restored state does not match", async () => {
  const api = installMutableApi(event, activities, {
    failPairingActivityId: "i164885877",
    ignoreRollbackEventRestore: true,
  });
  // preview and apply using its fingerprint
  expect(result.structuredContent.applied).toBe(false);
  expect(result.structuredContent.rollback_attempted).toBe(true);
  expect(result.structuredContent.rollback_complete).toBe(false);
});
```

Add:

```ts
it("marks rollback incomplete when event creation outcome is ambiguous", async () => {
  const api = installMutableApi(event, activities, {
    ambiguousCreateFailure: true,
  });
  // preview and apply using its fingerprint
  expect(result.structuredContent.applied).toBe(false);
  expect(result.structuredContent.rollback_attempted).toBe(true);
  expect(result.structuredContent.rollback_complete).toBe(false);
  expect(api.createdEvents).toHaveLength(1);
});
```

Production changes caught:

- removing read-back verification makes the silent mismatch return true;
- removing ambiguous-create tracking makes an unknown orphan return true.

- [ ] **Step 4: Run focused tests and verify the failures**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: rollback verification count and incomplete-result assertions fail against the current response-only rollback implementation.

- [ ] **Step 5: Extract state comparison helpers**

Add:

```ts
function eventMatchesReplacement(event: RecordValue, replacement: Replacement): boolean {
  return event.name === replacement.name
    && numberField(event, "moving_time") === replacement.moving_time
    && event.description === replacement.description
    && stringField(event, "type") === replacement.type
    && normalizedIndoor(event) === replacement.indoor;
}

function activityMatchesSnapshot(activity: RecordValue, snapshot: RecordValue): boolean {
  return String(activity.paired_event_id ?? "") === String(snapshot.paired_event_id ?? "")
    && activity.name === snapshot.name;
}
```

Use `eventMatchesReplacement` in successful final verification to keep forward and rollback comparisons consistent.

- [ ] **Step 6: Add rollback read-back verification**

Add:

```ts
async function createdEventIsAbsent(
  client: IntervalsClient,
  eventId: string,
): Promise<boolean> {
  try {
    await client.get<RecordValue>(`/athlete/${client.athleteId}/events/${eventId}`);
    return false;
  } catch (error) {
    return error instanceof Error && error.message.startsWith("404:");
  }
}
```

Add:

```ts
async function verifyRollback(
  client: IntervalsClient,
  eventId: string,
  originalEvent: RecordValue,
  originalActivities: RecordValue[],
  createdEventIds: string[],
): Promise<boolean> {
  for (const createdId of createdEventIds) {
    if (!await createdEventIsAbsent(client, createdId)) return false;
  }

  const restoredEvent = await client.get<RecordValue>(
    `/athlete/${client.athleteId}/events/${eventId}`,
  );
  const originalReplacement: Replacement = {
    activity_id: "",
    name: stringField(originalEvent, "name"),
    moving_time: plannedDuration(originalEvent),
    description: stringField(originalEvent, "description"),
    type: cyclingType(originalEvent) ?? "Ride",
    indoor: normalizedIndoor(originalEvent),
  };
  if (!eventMatchesReplacement(restoredEvent, originalReplacement)) return false;

  for (const snapshot of originalActivities) {
    const restored = await client.get<RecordValue>(`/activity/${snapshot.id}`);
    if (!activityMatchesSnapshot(restored, snapshot)) return false;
  }
  return true;
}
```

Catch any verification error in the rollback block and set completion false.

- [ ] **Step 7: Track ambiguous event creation**

Add outside the main `try`:

```ts
let eventCreationInFlight = false;
let ambiguousEventCreation = false;
```

Wrap each event creation:

```ts
eventCreationInFlight = true;
try {
  const created = await client.post<RecordValue>(/* existing arguments */);
  eventCreationInFlight = false;
  const createdId = String(created.id);
  createdEventIds.push(createdId);
  eventIds.push(createdId);
} catch (error) {
  if (eventCreationInFlight) ambiguousEventCreation = true;
  eventCreationInFlight = false;
  throw error;
}
```

Initialize rollback state conservatively:

```ts
let rollbackComplete = !ambiguousEventCreation;
```

After rollback writes, always run `verifyRollback`. Combine its result without erasing earlier failure:

```ts
try {
  rollbackComplete = await verifyRollback(
    client,
    event_id,
    originalEvent,
    originalActivities,
    createdEventIds,
  ) && rollbackComplete;
} catch {
  rollbackComplete = false;
}
```

- [ ] **Step 8: Run focused and registration tests**

Run:

```bash
npm test -- split-reconciliation.test.ts stdio.test.ts
```

Expected: all split reconciliation and MCP registration tests pass.

- [ ] **Step 9: Commit verified rollback**

Run:

```bash
git diff --check
git add src/tools/split-reconciliation.ts test/split-reconciliation.test.ts
git commit -m "fix: verify split reconciliation rollback"
```

---

### Task 3: Correct Cycling-Family Coaching Wording

**Files:**

- Modify: `../intervals.icu-coach/skills/triathlon-training/references/WORKOUT_PLANNING.md:242`
- Modify: `../intervals.icu-coach/docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md:1160`

**Interfaces:**

- Preserves: all tool names, inputs, warnings, advisories, and approval rules
- Produces: consistent candidate-clustering terminology
- Excludes: `.agents/skills/triathlon-training`

- [ ] **Step 1: Update canonical wording**

Replace:

```md
- Preview first; it is read-only and defaults to a 90-minute maximum elapsed gap between same-sport, same-local-day activities.
```

With:

```md
- Preview first; it is read-only and defaults to a 90-minute maximum elapsed gap between same-cycling-family, same-local-day activities.
```

- [ ] **Step 2: Mirror the exact wording in the ChatGPT Project source**

Make the identical replacement in `docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md`.

Do not synchronize or edit the local `.agents` copy.

- [ ] **Step 3: Validate and commit the coach change**

Run:

```bash
rg -n "same-cycling-family|same-sport" \
  skills/triathlon-training/references/WORKOUT_PLANNING.md \
  docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md
git diff --check
git add skills/triathlon-training/references/WORKOUT_PLANNING.md \
  docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md
git commit -m "docs: clarify split cycling-family matching"
```

Expected: both changed lines use `same-cycling-family`; no changed split-reconciliation guidance uses `same-sport`.

---

### Task 4: Full Verification, Review, and Deployment Handoff

**Files:**

- Verify: all modified server files
- Verify: both modified coach files
- Do not modify: `.agents/skills/triathlon-training`

**Interfaces:**

- Produces: reviewed local commits ready for a deployment decision
- Preserves: current production Worker until separately approved

- [ ] **Step 1: Run the complete server verification**

Run from `intervals.icu-server`:

```bash
npm test
npx tsc --noEmit
git diff --check
git status --short
```

Expected: all tests and TypeScript pass, diff check prints nothing, and the server worktree is clean.

- [ ] **Step 2: Verify the coach repository**

Run from `intervals.icu-coach`:

```bash
git diff --check
git status --short
```

Expected: both commands show a clean coach worktree.

- [ ] **Step 3: Inspect the resulting commits**

Run from the workspace root:

```bash
git -C intervals.icu-server log -5 --oneline
git -C intervals.icu-coach log -2 --oneline
```

Expected server commits include:

- `fix: revalidate split details before writes`
- `fix: verify split reconciliation rollback`

Expected coach commit includes:

- `docs: clarify split cycling-family matching`

- [ ] **Step 4: Request an independent code review**

Use `superpowers:requesting-code-review` with:

- server base: `40b60ee`
- server head: current `HEAD`
- coach base: `b80c138`
- coach head: current `HEAD`
- requirements: `docs/superpowers/specs/2026-07-29-split-reconciliation-safety-hardening-design.md`

Fix every Critical or Important finding using a new failing test before changing production code. Re-run the complete verification after any review fix.

- [ ] **Step 5: Request deployment approval**

Report:

- exact server and coach commit IDs;
- exact test file and test counts;
- TypeScript result;
- independent review verdict;
- that the local `.agents` issue was intentionally untouched;
- that production still has the previous deployed version.

Do not run `npm run deploy` or `wrangler deploy` without explicit approval.
