# Split Reconciliation Across Ride Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make split-workout reconciliation work by default across `Ride` and `VirtualRide` plans and activities, while turning completed intensity above 80% into non-blocking advisory context.

**Architecture:** Keep candidate detection, preview, fingerprint protection, apply, verification, and rollback in the existing split-reconciliation module. Add a cycling-family normalization boundary, separate hard `warnings` from non-blocking `advisories`, and make each replacement event inherit the paired completed activity's type and indoor state. Update the canonical coach skill, its ChatGPT copy, and the workspace skill copy to consume the revised contract.

**Tech Stack:** TypeScript 5.9, Zod, MCP SDK, Vitest, Cloudflare Workers, Markdown skill sources.

## Global Constraints

- `Ride` and `VirtualRide` are one cycling family for candidate matching.
- The planned event's `indoor` flag is not an eligibility gate.
- No override parameter is added; relaxed cycling-family behavior is the default.
- Planned duration remains at least 60 minutes and allocatable in five-minute units.
- Planned workout steps remain sequential, timed, `%ftp`-based, and at or below 75% FTP.
- Repeat blocks, distance steps, untimed steps, ambiguous structures, and non-cycling sports remain unsupported.
- Completed intensity above 80% and missing intensity are non-blocking advisories.
- Replacement event type and indoor state match each paired completed activity.
- Preview, explicit approval, fingerprint, ordered activity IDs, final verification, and rollback safeguards remain mandatory.
- Completed activity files are never merged or deleted.
- Intervals.icu compliance is reported after recalculation without promising a specific score.

---

## File Structure

### Server repository: `intervals.icu-server`

- Modify `src/tools/split-reconciliation.ts`: cycling-family normalization, advisory separation, replacement type/indoor fields, fingerprint coverage, event writes, final verification, and tool copy.
- Modify `test/split-reconciliation.test.ts`: virtual-plan/outdoor-activity, high/missing-intensity advisory, type-normalized apply, and stale-fingerprint coverage.
- Modify `README.md`: describe both cycling types and advisory intensity behavior.

### Coach repository: `intervals.icu-coach`

- Modify `skills/triathlon-training/SKILL.md`: tool-map contract and route summary.
- Modify `skills/triathlon-training/references/COACH.md`: preview/apply sequence and safety rules.
- Modify `skills/triathlon-training/references/WORKOUT_PLANNING.md`: planning-side reconciliation guidance.
- Modify `docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md`: mirror all three canonical skill changes.

### Workspace skill copy

- Synchronize `.agents/skills/triathlon-training/SKILL.md` from the canonical skill.
- Synchronize `.agents/skills/triathlon-training/COACH.md` and `.agents/skills/triathlon-training/WORKOUT_PLANNING.md` from canonical references.
- Synchronize the remaining reference files at the same time so the workspace copy exactly matches the canonical skill package.

---

### Task 1: Make Cycling-Family Eligibility and Intensity Advisories Explicit

**Files:**

- Modify: `test/split-reconciliation.test.ts:23-120`
- Modify: `src/tools/split-reconciliation.ts:18-33`
- Modify: `src/tools/split-reconciliation.ts:197-325`
- Modify: `src/tools/split-reconciliation.ts:396-436`
- Modify: `README.md:106`

**Interfaces:**

- Produces: `type CyclingType = "Ride" | "VirtualRide"`
- Produces: `cyclingType(record: RecordValue): CyclingType | null`
- Produces: `Candidate.advisories: string[]`
- Preserves: `findCandidates(events, activities, maxGapMinutes): Candidate[]`
- Preserves: preview inputs `date` and optional `max_gap_minutes`; no new override input

- [ ] **Step 1: Replace the old combined hard-workout test with focused failing eligibility tests**

Add these cases inside `describe("split-workout reconciliation helpers", ...)`:

```ts
it("accepts a virtual plan completed as outdoor rides with high-intensity advisories", () => {
  const virtualEvent = { ...event, type: "VirtualRide", indoor: true };
  const outdoorActivities = activities.map((activity, index) => ({
    ...activity,
    type: "Ride",
    icu_intensity: index === 0 ? 80.1 : 80.6,
  }));

  const candidate = findCandidates([virtualEvent], outdoorActivities, 90)[0];

  expect(candidate.supported).toBe(true);
  expect(candidate.classification).toBe("EASY_CONTINUOUS_RIDE");
  expect(candidate.warnings).toEqual([]);
  expect(candidate.advisories).toEqual([
    "Activity i164875648 intensity is 80.1%, above the 80% easy-ride advisory threshold.",
    "Activity i164885877 intensity is 80.6%, above the 80% easy-ride advisory threshold.",
  ]);
});

it("keeps missing completed intensity advisory-only", () => {
  const withoutIntensity = activities.map(activity => ({ ...activity, icu_intensity: undefined }));
  const candidate = findCandidates([event], withoutIntensity, 90)[0];

  expect(candidate.supported).toBe(true);
  expect(candidate.warnings).toEqual([]);
  expect(candidate.advisories).toEqual([
    "Activity i164875648 has no intensity value.",
    "Activity i164885877 has no intensity value.",
  ]);
});

it("still refuses hard planned targets", () => {
  const hardEvent = {
    ...event,
    name: "Sprint workout",
    workout_doc: {
      duration: 7200,
      steps: [{ duration: 7200, power: { value: 120, units: "%ftp" } }],
    },
    description: "Main Set\n- 120m 120%",
  };
  const candidate = findCandidates([hardEvent], activities, 90)[0];

  expect(candidate.supported).toBe(false);
  expect(candidate.classification).toBeNull();
  expect(candidate.warnings.join(" ")).toMatch(/75% FTP/);
});

it("still refuses non-cycling activity clusters", () => {
  const runEvent = { ...event, type: "Run" };
  const runActivities = activities.map(activity => ({ ...activity, type: "Run" }));
  const candidate = findCandidates([runEvent], runActivities, 90)[0];

  expect(candidate.supported).toBe(false);
  expect(candidate.classification).toBeNull();
  expect(candidate.warnings.join(" ")).toMatch(/Ride or VirtualRide/);
});
```

- [ ] **Step 2: Run the helper tests and confirm the new contract fails**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: FAIL because `VirtualRide` and `indoor: true` are still hard refusals, intensity is still stored in `warnings`, and `advisories` does not exist.

- [ ] **Step 3: Add cycling-family and advisory types**

At the top of `src/tools/split-reconciliation.ts`, extend the existing types:

```ts
type CyclingType = "Ride" | "VirtualRide";

interface Candidate {
  event: RecordValue;
  activities: RecordValue[];
  replacements: Replacement[];
  classification: "EASY_CONTINUOUS_RIDE" | null;
  eligibility_signals: string[];
  supported: boolean;
  warnings: string[];
  advisories: string[];
}

function cyclingType(record: RecordValue): CyclingType | null {
  const type = stringField(record, "type");
  return type === "Ride" || type === "VirtualRide" ? type : null;
}
```

- [ ] **Step 4: Separate eligibility failures from advisory intensity**

Change the eligibility return type and implementation to this shape:

```ts
function easyRideEligibility(event: RecordValue, activities: RecordValue[], total: number): {
  eligible: boolean;
  signals: string[];
  warnings: string[];
  advisories: string[];
} {
  const warnings: string[] = [];
  const advisories: string[] = [];
  const signals: string[] = [];

  if (!cyclingType(event)) {
    warnings.push("Only Ride or VirtualRide workouts are eligible for split reconciliation.");
  }
  if (total < 3600) warnings.push("The original planned ride must be at least 60 minutes.");

  const workoutDoc = event.workout_doc as RecordValue | undefined;
  const docSteps = Array.isArray(workoutDoc?.steps) ? workoutDoc.steps as RecordValue[] : [];
  if (!docSteps.length) {
    warnings.push("Structured power steps are required to confirm an easy continuous ride.");
  } else {
    for (const step of docSteps) {
      const power = step.power as RecordValue | undefined;
      if (!power || power.units !== "%ftp") {
        warnings.push("Every planned step must use an FTP-relative power target.");
        break;
      }
      const targets = [power.value, power.start, power.end]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (!targets.length || Math.max(...targets) > 75) {
        warnings.push("Every planned power target must stay at or below 75% FTP.");
        break;
      }
    }
    if (!warnings.some(warning => warning.includes("power target") || warning.includes("FTP-relative"))) {
      signals.push("All planned power targets are at or below 75% FTP.");
    }
  }

  for (const activity of activities) {
    if (!cyclingType(activity)) {
      warnings.push(`Activity ${activity.id} is not a Ride or VirtualRide.`);
      continue;
    }
    const intensity = normalizedIntensity(activity);
    if (intensity == null) {
      advisories.push(`Activity ${activity.id} has no intensity value.`);
    } else if (intensity > 80) {
      advisories.push(
        `Activity ${activity.id} intensity is ${intensity.toFixed(1)}%, above the 80% easy-ride advisory threshold.`,
      );
    }
  }
  if (!advisories.length) {
    signals.push("Every completed activity part is at or below 80% intensity.");
  }

  const text = [event.name, ...(Array.isArray(event.tags) ? event.tags : [])].join(" ").toLowerCase();
  const cue = ["easy", "cafe", "endurance", "recovery", "social", "long", "base"]
    .find(word => text.includes(word));
  if (cue) signals.push(`Workout name/tags include the supporting cue “${cue}”.`);
  return { eligible: warnings.length === 0, signals, warnings, advisories };
}
```

In `buildCandidate`, return `advisories: eligibility.advisories` and keep `supported` dependent on hard warnings and valid split descriptions only.

- [ ] **Step 5: Group completed cycling types into one candidate stream**

Change `findCandidates` grouping:

```ts
const bySport = new Map<string, RecordValue[]>();
for (const activity of activities) {
  const type = stringField(activity, "type");
  if (!type) continue;
  const sport = cyclingType(activity) ? "Cycling" : type;
  bySport.set(sport, [...(bySport.get(sport) ?? []), activity]);
}
const candidates: Candidate[] = [];
for (const sameSport of bySport.values()) {
```

This allows `Ride` and `VirtualRide` activity parts to share one chronological cluster while preserving exact grouping for other sports, which are later rejected by hard eligibility.

- [ ] **Step 6: Return advisories from preview and update its description**

Use this tool description:

```ts
description: "Preview eligible easy continuous Ride or VirtualRide workouts split across same-day cycling activities. Requires a >=60-minute sequential workout at <=75% FTP. Completed intensity above 80% is advisory only. Read-only; default maximum gap is 90 minutes.",
```

Add this field to each preview candidate:

```ts
advisories: candidate.advisories,
```

Update `README.md`:

```md
| `preview_split_workout_reconciliation` | Read-only preview of eligible easy continuous `Ride` or `VirtualRide` workouts split across same-day cycling activities; completed intensity above 80% is advisory |
```

- [ ] **Step 7: Run the focused test file**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: all helper and preview tests PASS, including the virtual-plan and advisory cases.

- [ ] **Step 8: Commit the eligibility change**

```bash
git add src/tools/split-reconciliation.ts test/split-reconciliation.test.ts README.md
git commit -m "feat: relax split ride eligibility"
```

---

### Task 2: Make Replacement Events Match Completed Activity Type

**Files:**

- Modify: `test/split-reconciliation.test.ts:122-222`
- Modify: `src/tools/split-reconciliation.ts:18-23`
- Modify: `src/tools/split-reconciliation.ts:255-287`
- Modify: `src/tools/split-reconciliation.ts:327-394`
- Modify: `src/tools/split-reconciliation.ts:465-557`

**Interfaces:**

- Extends: `Replacement.type: CyclingType`
- Extends: `Replacement.indoor: boolean`
- Consumes: `cyclingType(record): CyclingType | null` from Task 1
- Preserves: `reconcile_split_workout` input schema with no override parameter
- Preserves: rollback result fields `rollback_attempted` and `rollback_complete`

- [ ] **Step 1: Extract an exact mutable API fixture for write-path tests**

Add this helper above the tool-test `describe` block and replace the existing successful apply test's inline fetch mock with it:

```ts
function installMutableApi(
  initialEvent: Record<string, unknown>,
  initialActivities: Array<Record<string, unknown>>,
) {
  const activityState = new Map(
    initialActivities.map(activity => [String(activity.id), { ...activity }]),
  );
  let eventState = { ...initialEvent };
  const createdEvents: Array<Record<string, unknown>> = [];
  let writeCount = 0;

  vi.stubGlobal("fetch", vi.fn().mockImplementation((urlString: string, init?: RequestInit) => {
    const url = new URL(urlString);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : {};
    if (method !== "GET") writeCount++;

    let response: unknown;
    if (method === "GET" && url.pathname.endsWith("/activities")) {
      response = [...activityState.values()].map(item => ({ ...item }));
    } else if (method === "GET" && url.pathname.endsWith("/events")) {
      response = [{ ...eventState }, ...createdEvents];
    } else if (method === "GET" && url.pathname.includes("/events/")) {
      const id = url.pathname.split("/").pop();
      response = id === String(initialEvent.id)
        ? eventState
        : createdEvents.find(item => String(item.id) === id);
    } else if (method === "GET" && url.pathname.startsWith("/api/v1/activity/")) {
      response = activityState.get(url.pathname.split("/").pop() ?? "");
    } else if (method === "PUT" && url.pathname.startsWith("/api/v1/activity/")) {
      const id = String(body.id);
      const updated = { ...(activityState.get(id) ?? {}), ...body };
      activityState.set(id, updated);
      response = updated;
    } else if (method === "PUT" && url.pathname.endsWith(`/events/${initialEvent.id}`)) {
      eventState = { ...eventState, ...body };
      response = eventState;
    } else if (method === "POST" && url.pathname.endsWith("/events")) {
      response = { id: 222, ...body };
      createdEvents.push(response as Record<string, unknown>);
    } else {
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(""),
    });
  }));

  return {
    activityState,
    createdEvents,
    get eventState() {
      return eventState;
    },
    setEventState(value: Record<string, unknown>) {
      eventState = value;
    },
    get writeCount() {
      return writeCount;
    },
  };
}
```

- [ ] **Step 2: Add failing apply and fingerprint tests for cycling metadata**

Use this setup in the successful apply test:

```ts
const virtualEvent = { ...event, type: "VirtualRide", indoor: true };
const outdoorActivities = activities.map((activity, index) => ({
  ...activity,
  type: "Ride",
  icu_intensity: index === 0 ? 80.1 : 80.6,
}));
const api = installMutableApi(virtualEvent, outdoorActivities);
```

After applying the current preview, assert:

```ts
expect(result.structuredContent.applied).toBe(true);
expect(api.eventState).toMatchObject({ type: "Ride", indoor: false });
expect(api.createdEvents[0]).toMatchObject({ type: "Ride", indoor: false });
expect(api.activityState.get("i164875648")?.paired_event_id).toBe(event.id);
expect(api.activityState.get("i164885877")?.paired_event_id).toBe(222);
```

Add this separate stale-preview test:

```ts
it("rejects a preview when cycling metadata changes before apply", async () => {
  const virtualEvent = { ...event, type: "VirtualRide", indoor: true };
  const api = installMutableApi(virtualEvent, activities);
  const server = await createStdioServer("test-key", "i388529");
  const preview = await callTool(server, "preview_split_workout_reconciliation", {
    date: "2026-07-12",
  });
  const candidate = preview.structuredContent.candidates[0];
  api.setEventState({ ...api.eventState, indoor: false });

  const writesBeforeApply = api.writeCount;
  const result = await callTool(server, "reconcile_split_workout", {
    date: "2026-07-12",
    event_id: String(event.id),
    activity_ids: activities.map(activity => activity.id),
    fingerprint: candidate.fingerprint,
    confirm: true,
  });

  expect(result.structuredContent.applied).toBe(false);
  expect(result.structuredContent.error).toMatch(/changed after preview/);
  expect(api.writeCount).toBe(writesBeforeApply);
});
```

- [ ] **Step 3: Run the tool tests and confirm both new cases fail**

Run:

```bash
npm test -- split-reconciliation.test.ts
```

Expected: FAIL because replacement writes still preserve the planned event's `VirtualRide`/indoor values and the fingerprint omits indoor metadata.

- [ ] **Step 4: Add type and indoor state to replacements**

Extend the interface:

```ts
interface Replacement {
  activity_id: string;
  name: string;
  moving_time: number;
  description: string;
  type: CyclingType;
  indoor: boolean;
}
```

In `buildCandidate`, create replacements with completed-activity metadata:

```ts
replacements: activities.map((activity, index) => {
  const type = cyclingType(activity) ?? "Ride";
  return {
    activity_id: stringField(activity, "id"),
    name: `${baseName} — ${partSuffix(index, activities.length)}`,
    moving_time: allocations[index] ?? 0,
    description: descriptions[index] ?? "",
    type,
    indoor: type === "VirtualRide",
  };
}),
```

The fallback is only present for preview construction; `supported` is false whenever an activity is outside the cycling family, so it cannot reach the write path.

- [ ] **Step 5: Extend fingerprint coverage**

Add `indoor` to the event payload, `type` and `indoor` to each activity, and `advisories` to the candidate payload:

```ts
event: {
  id: candidate.event.id,
  name: candidate.event.name,
  type: candidate.event.type,
  indoor: candidate.event.indoor ?? null,
  start_date_local: candidate.event.start_date_local,
  moving_time: plannedDuration(candidate.event),
  description: candidate.event.description,
  updated: candidate.event.updated ?? null,
},
activities: candidate.activities.map(activity => ({
  id: activity.id,
  type: activity.type,
  indoor: activity.indoor ?? null,
  start_date_local: activity.start_date_local,
  moving_time: activity.moving_time,
  elapsed_time: activity.elapsed_time,
  icu_intensity: activity.icu_intensity ?? null,
  paired_event_id: activity.paired_event_id ?? null,
  name: activity.name,
  updated: activity.analyzed ?? activity.updated ?? null,
})),
replacements: candidate.replacements,
classification: candidate.classification,
eligibility_signals: candidate.eligibility_signals,
advisories: candidate.advisories,
```

- [ ] **Step 6: Write replacement type and indoor state without copying over them**

Remove `"type"` and `"indoor"` from the copied-field list in `eventWritePayload`. Set them directly:

```ts
const fields = [
  "category", "target", "targets", "tags", "sub_type", "color",
  "carbs_per_hour", "hide_from_athlete", "athlete_cannot_edit", "structure_read_only",
  "not_on_fitness_chart", "show_as_note", "show_on_ctl_line", "for_week",
  "training_availability", "max_training_time", "can_train_sports", "external_id", "calendar_id",
];
const payload: RecordValue = {
  start_date_local: event.start_date_local,
  category: event.category ?? "WORKOUT",
  type: replacement.type,
  indoor: replacement.indoor,
  name: replacement.name,
  moving_time: replacement.moving_time,
  description: replacement.description,
};
```

Restore the original event with its original cycling metadata:

```ts
function originalEventWritePayload(event: RecordValue): RecordValue {
  const type = cyclingType(event) ?? "Ride";
  return eventWritePayload(event, {
    activity_id: "",
    name: stringField(event, "name"),
    moving_time: plannedDuration(event),
    description: stringField(event, "description"),
    type,
    indoor: event.indoor === true,
  });
}
```

- [ ] **Step 7: Verify persisted type and indoor state after writes**

Extend final event verification:

```ts
if (verifiedEvent.name !== candidate.replacements[index].name
  || numberField(verifiedEvent, "moving_time") !== candidate.replacements[index].moving_time
  || verifiedEvent.description !== candidate.replacements[index].description
  || stringField(verifiedEvent, "type") !== candidate.replacements[index].type
  || Boolean(verifiedEvent.indoor) !== candidate.replacements[index].indoor) {
  throw new Error(`Final verification failed for event ${eventIds[index]}.`);
}
```

- [ ] **Step 8: Run focused and registration tests**

Run:

```bash
npm test -- split-reconciliation.test.ts stdio.test.ts
```

Expected: both test files PASS and the MCP server still registers exactly 24 tools.

- [ ] **Step 9: Commit the replacement-event change**

```bash
git add src/tools/split-reconciliation.ts test/split-reconciliation.test.ts
git commit -m "fix: align split events with completed ride type"
```

---

### Task 3: Update Canonical Coach Skill and All Derived Copies

**Files:**

- Modify: `../intervals.icu-coach/skills/triathlon-training/SKILL.md:32-33`
- Modify: `../intervals.icu-coach/skills/triathlon-training/references/COACH.md:453-477`
- Modify: `../intervals.icu-coach/skills/triathlon-training/references/WORKOUT_PLANNING.md:238-250`
- Modify: `../intervals.icu-coach/docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md:50-51`
- Modify: `../intervals.icu-coach/docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md:580-604`
- Modify: `../intervals.icu-coach/docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md:1153-1165`
- Synchronize: `../.agents/skills/triathlon-training/*.md`

**Interfaces:**

- Consumes: preview candidate fields `supported`, `warnings`, `advisories`, `replacements`, `activity_ids`, and `fingerprint`
- Consumes: unchanged apply inputs `date`, `event_id`, ordered `activity_ids`, `fingerprint`, `max_gap_minutes`, and `confirm: true`
- Produces: consistent agent behavior across canonical, ChatGPT Project, and workspace skill surfaces

- [ ] **Step 1: Update the canonical tool map**

Use these rows in `SKILL.md`:

```md
| Preview split-workout repair | `preview_split_workout_reconciliation` | Read-only; matches `Ride` and `VirtualRide` as one cycling family, returns hard warnings and non-blocking intensity advisories |
| Apply split-workout repair | `reconcile_split_workout` | ⚠️ Write operation — requires the exact preview fingerprint and explicit athlete approval; no override parameter |
```

- [ ] **Step 2: Update the canonical coach workflow**

Replace the eligibility and presentation guidance in `references/COACH.md` with:

```md
3. If `supported` is false, report the returned hard warnings and stop. Do not improvise generic event/activity writes around the safety refusal.
   - `EASY_CONTINUOUS_RIDE` candidates may use planned or completed `Ride` and `VirtualRide` types in any combination.
   - Hard limits remain: at least 60 planned minutes, sequential timed steps, all planned power targets at or below 75% FTP, and a five-minute-compatible planned total.
   - Completed intensity above 80% or missing intensity is advisory only and never requires a separate override parameter.
   - Name/tag cues `easy`, `cafe`, `endurance`, `recovery`, `social`, `long`, and `base` support classification but do not override hard plan and structure limits.
4. Show the proposed replacement names, types, indoor states, activity IDs, allocated durations, step summaries, and every advisory. Explain that each replacement matches its completed activity type and that planned duration is allocated by recorded moving-time share in five-minute units while preserving the original total.
```

Add this safety rule:

```md
- Never treat `advisories` as a refusal. Present them before approval; only `supported: false` and hard `warnings` stop the workflow.
```

- [ ] **Step 3: Update workout-planning guidance**

Use this contract in `references/WORKOUT_PLANNING.md`:

```md
- Treat planned and completed `Ride` and `VirtualRide` as one cycling family. The planned indoor flag is not an eligibility gate, and replacement events match their completed activity type and indoor state.
- Require the `EASY_CONTINUOUS_RIDE` classification: at least 60 planned minutes, sequential timed steps, and every planned power target at or below 75% FTP.
- Completed intensity above 80% or missing intensity is advisory only. Present every returned `advisory`; do not ask for or invent an override parameter.
- Present the exact proportional five-minute allocation, replacement descriptions, names, types, indoor states, ordered activity IDs, hard warnings, and advisories.
```

- [ ] **Step 4: Mirror the canonical changes in the ChatGPT Project source**

Update the corresponding MCP tool-map rows, `Reconcile a Split Workout` workflow, safety rule, and `Post-Activity Split Reconciliation` bullets in `docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md` using the exact wording from Steps 1-3.

- [ ] **Step 5: Validate canonical and generated skill wording**

Run from `intervals.icu-coach`:

```bash
rg -n "Ride.*VirtualRide|advisories|no override parameter|Never treat `advisories`" \
  skills/triathlon-training/SKILL.md \
  skills/triathlon-training/references/COACH.md \
  skills/triathlon-training/references/WORKOUT_PLANNING.md \
  docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md
git diff --check
```

Expected: all four files contain the revised contract and `git diff --check` prints nothing.

- [ ] **Step 6: Commit the canonical and ChatGPT skill update**

Run from `intervals.icu-coach`:

```bash
git add skills/triathlon-training/SKILL.md \
  skills/triathlon-training/references/COACH.md \
  skills/triathlon-training/references/WORKOUT_PLANNING.md \
  docs/chatgpt-projects/TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md
git commit -m "docs: relax split ride reconciliation guidance"
```

- [ ] **Step 7: Synchronize the workspace skill copy**

Run from the workspace root:

```bash
cp intervals.icu-coach/skills/triathlon-training/SKILL.md .agents/skills/triathlon-training/SKILL.md
cp intervals.icu-coach/skills/triathlon-training/references/BLOCK_TEMPLATES.md .agents/skills/triathlon-training/BLOCK_TEMPLATES.md
cp intervals.icu-coach/skills/triathlon-training/references/COACH.md .agents/skills/triathlon-training/COACH.md
cp intervals.icu-coach/skills/triathlon-training/references/METRICS_REFERENCE.md .agents/skills/triathlon-training/METRICS_REFERENCE.md
cp intervals.icu-coach/skills/triathlon-training/references/WORKOUT_LIBRARY.md .agents/skills/triathlon-training/WORKOUT_LIBRARY.md
cp intervals.icu-coach/skills/triathlon-training/references/WORKOUT_PLANNING.md .agents/skills/triathlon-training/WORKOUT_PLANNING.md
```

The workspace copy is not a Git repository, so it is verified rather than committed.

- [ ] **Step 8: Verify the workspace copy exactly matches canonical sources**

Run from the workspace root:

```bash
cmp intervals.icu-coach/skills/triathlon-training/SKILL.md .agents/skills/triathlon-training/SKILL.md
cmp intervals.icu-coach/skills/triathlon-training/references/BLOCK_TEMPLATES.md .agents/skills/triathlon-training/BLOCK_TEMPLATES.md
cmp intervals.icu-coach/skills/triathlon-training/references/COACH.md .agents/skills/triathlon-training/COACH.md
cmp intervals.icu-coach/skills/triathlon-training/references/METRICS_REFERENCE.md .agents/skills/triathlon-training/METRICS_REFERENCE.md
cmp intervals.icu-coach/skills/triathlon-training/references/WORKOUT_LIBRARY.md .agents/skills/triathlon-training/WORKOUT_LIBRARY.md
cmp intervals.icu-coach/skills/triathlon-training/references/WORKOUT_PLANNING.md .agents/skills/triathlon-training/WORKOUT_PLANNING.md
```

Expected: every `cmp` exits 0 with no output.

---

### Task 4: Full Verification and Deployment Handoff

**Files:**

- Verify: all modified files in `intervals.icu-server`
- Verify: all modified files in `intervals.icu-coach`
- Verify: all synchronized files in `.agents/skills/triathlon-training`

**Interfaces:**

- Consumes: the complete server and skill behavior from Tasks 1-3
- Produces: a tested pair of local commits and an exact deployment candidate

- [ ] **Step 1: Run the complete server test suite**

Run from `intervals.icu-server`:

```bash
npm test
```

Expected: every Vitest file and test passes with zero failures.

- [ ] **Step 2: Run static and repository checks**

Run from `intervals.icu-server`:

```bash
npx tsc --noEmit
git diff --check
git status --short
```

Expected: TypeScript exits 0, `git diff --check` prints nothing, and status contains no uncommitted server changes.

Run from `intervals.icu-coach`:

```bash
git diff --check
git status --short
```

Expected: both commands produce no uncommitted coach changes.

- [ ] **Step 3: Re-run the skill synchronization checks**

Run the six `cmp` commands from Task 3 Step 8.

Expected: all commands exit 0 with no output.

- [ ] **Step 4: Inspect the resulting commits**

Run:

```bash
git -C intervals.icu-server log -3 --oneline
git -C intervals.icu-coach log -1 --oneline
```

Expected: the server log includes `feat: relax split ride eligibility` and `fix: align split events with completed ride type`; the coach log includes `docs: relax split ride reconciliation guidance`.

- [ ] **Step 5: Request deployment approval**

Report the exact test counts, commit IDs, and that the currently deployed Worker still has the previous behavior. Ask the athlete to approve a new `intervals-mcp` production deployment. Do not run `wrangler deploy` without that confirmation.
