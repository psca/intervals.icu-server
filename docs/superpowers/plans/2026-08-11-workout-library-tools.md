# Workout Library Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six compact MCP tools for discovering, maintaining, deleting, and scheduling the athlete's private Intervals.icu workout library.

**Architecture:** A new `src/tools/library.ts` module owns the library domain, including compact projections, write-payload construction, plan date expansion, and six tool registrations. `IntervalsClient` gains backward-compatible query-parameter support for POST and typed DELETE responses; both Worker and stdio entry points register the same library tools.

**Tech Stack:** TypeScript 5.9 strict mode, Cloudflare Workers, `@modelcontextprotocol/sdk` 1.27, Zod, Vitest 3.2, Intervals.icu REST API.

## Global Constraints

- Support only the authenticated athlete's own private library; shared and public libraries remain out of scope.
- Expose exactly six new tools: `search_workout_library`, `get_library_workout`, `save_library_container`, `save_library_workout`, `delete_library_item`, and `schedule_library`.
- Do not accept model-authored `workout_doc` on any write or return it from compact search results.
- Treat folders as flat categories and plans as progressive containers with zero-based `day` offsets.
- Use athlete-local timestamps in `YYYY-MM-DDTHH:mm:ss` format without `Z` or an offset.
- Cap scheduling batches at 100 items and complete all validation before the single bulk calendar write.
- Do not claim upstream bulk scheduling is transactional; a failed bulk response has an unknown creation outcome.
- Require `confirm: true` for deletion; deleting a folder or plan inherently deletes all contained workouts.
- Use `others=false` when deleting one workout so other plan workouts are not intentionally cascaded.
- Do not add dependencies, nested folders, recurring rules, automatic progression, or deployment steps.

---

### Task 1: Add POST query parameters and typed DELETE responses

**Files:**
- Modify: `src/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Produces: `IntervalsClient.post<T>(path: string, body: unknown, params?: Record<string, string>): Promise<T>`
- Produces: `IntervalsClient.delete<T = void>(path: string, params?: Record<string, string>): Promise<T>`
- Preserves: every existing two-argument `post` call and one-argument `delete` call.

- [ ] **Step 1: Write failing client tests**

Add tests that verify POST query parameters and JSON DELETE responses:

```ts
it("appends query params to POST requests", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify([]), { status: 200 })
  ));
  const client = new IntervalsClient("key", "i12345");

  await client.post("/athlete/i12345/events/bulk", [], {
    upsertOnUid: "false",
    updatePlanApplied: "true",
  });

  const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
  expect(calledUrl).toContain("upsertOnUid=false");
  expect(calledUrl).toContain("updatePlanApplied=true");
});

it("returns a JSON body from DELETE when present", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify([41]), { status: 200 })
  ));
  const client = new IntervalsClient("key", "i12345");

  await expect(client.delete<number[]>("/athlete/i12345/workouts/41", { others: "false" }))
    .resolves.toEqual([41]);
});
```

- [ ] **Step 2: Run the focused client tests and verify failure**

Run: `npm test -- --run test/client.test.ts`

Expected: FAIL because `post` and `delete` do not accept query parameters and `delete` returns no parsed body.

- [ ] **Step 3: Implement one URL builder and the compatible methods**

Add a private URL helper and use it from `get`, `post`, and `delete`:

```ts
private url(path: string, params?: Record<string, string>): URL {
  const url = new URL(IntervalsClient.BASE_URL + path);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

async post<T>(path: string, body: unknown, params?: Record<string, string>): Promise<T> {
  const res = await fetch(this.url(path, params), {
    method: "POST",
    headers: {
      Authorization: this.authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async delete<T = void>(path: string, params?: Record<string, string>): Promise<T> {
  const res = await fetch(this.url(path, params), {
    method: "DELETE",
    headers: { Authorization: this.authHeader, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
```

Keep `put` behavior unchanged and use the same URL helper without query parameters.

- [ ] **Step 4: Run client and event regression tests**

Run: `npm test -- --run test/client.test.ts test/events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the client enhancement**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: support library API request options"
```

---

### Task 2: Implement compact library discovery

**Files:**
- Create: `src/tools/library.ts`
- Create: `test/library.test.ts`

**Interfaces:**
- Produces: `registerLibraryTools(server: McpServer, client: IntervalsClient): void`
- Produces internally: `compactWorkout(workout, containers): CompactWorkout`
- Produces internally: `ownContainers(folders, athleteId): LibraryContainer[]`
- Registers: `search_workout_library` and `get_library_workout` in this task; later tasks extend the same function.

- [ ] **Step 1: Create the test harness and failing compact-search tests**

In `test/library.test.ts`, mock the stdio transport only if using `createStdioServer`; preferably instantiate `McpServer`, call `registerLibraryTools`, and invoke `_registeredTools[name].handler` with the same documented test-only access pattern as `test/events.test.ts`.

Cover a folder, a plan, and workouts whose raw data contain descriptions, attachments, and `workout_doc`:

```ts
expect(result.structuredContent.items).toContainEqual(expect.objectContaining({
  item_type: "WORKOUT",
  id: 11,
  name: "SS-3x10",
  container_name: "Bike — Sweet Spot",
  container_type: "FOLDER",
  moving_time: 4200,
  training_load: 68,
  intensity: 0.87,
}));
expect(JSON.stringify(result.structuredContent)).not.toContain("Main Set");
expect(JSON.stringify(result.structuredContent)).not.toContain("workout_doc");
expect(JSON.stringify(result.structuredContent)).not.toContain("attachments");
```

Add cases for case-insensitive name query, `item_type`, sport, `container_id`, default limit 50, maximum limit 100, and exclusion of records whose `athlete_id` differs from `client.athleteId`.

- [ ] **Step 2: Run the library tests and verify failure**

Run: `npm test -- --run test/library.test.ts`

Expected: FAIL because `src/tools/library.ts` and its registration function do not exist.

- [ ] **Step 3: Implement shared records, projections, and search**

Define focused internal types rather than reproducing the entire upstream schema:

```ts
type RecordValue = Record<string, unknown>;
type ContainerType = "FOLDER" | "PLAN";
type ItemType = "ALL" | "WORKOUT" | ContainerType;

type CompactWorkout = {
  item_type: "WORKOUT";
  id: number;
  name: string;
  type: string | null;
  container_id: number | null;
  container_name: string | null;
  container_type: ContainerType | null;
  moving_time: number | null;
  training_load: number | null;
  intensity: number | null;
  indoor: boolean | null;
  targets: string[];
  tags: string[];
};
```

Fetch `/athlete/{id}/folders` and `/athlete/{id}/workouts` concurrently. Use folders for container metadata and the workouts endpoint as the source of the athlete's owned workouts. Normalize missing scalar values to `null`, arrays to `[]`, and never spread upstream objects into compact results.

Register `search_workout_library` with `query`, `item_type`, `sport`, `container_id`, and `limit` inputs. Apply filters before slicing to the validated limit.

- [ ] **Step 4: Add a failing full-workout retrieval test**

Verify that `get_library_workout` calls `/athlete/i123/workouts/11`, returns `description`, and omits `workout_doc`:

```ts
expect(result.structuredContent.workout).toEqual(expect.objectContaining({
  id: 11,
  name: "SS-3x10",
  description: "Warmup\n- 10m Z2",
}));
expect(result.structuredContent.workout).not.toHaveProperty("workout_doc");
```

- [ ] **Step 5: Implement explicit full-workout projection**

Create a projection that lists supported fields by name, including ID, folder ID, name, description, sport, indoor, color, duration, load, intensity, day, saved time, targets, tags, nutrition, subtype, distance, and updated time. Do not return attachments or `workout_doc`.

- [ ] **Step 6: Run the discovery tests**

Run: `npm test -- --run test/library.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit discovery**

```bash
git add src/tools/library.ts test/library.test.ts
git commit -m "feat: add workout library discovery"
```

---

### Task 3: Implement folder and plan writes

**Files:**
- Modify: `src/tools/library.ts`
- Test: `test/library.test.ts`

**Interfaces:**
- Extends: `registerLibraryTools`
- Produces internally: `findContainer(client, containerId): Promise<RecordValue>`
- Registers: `save_library_container`

- [ ] **Step 1: Write failing create and update tests**

Test `CREATE` posts to `/athlete/i123/folders` with only supplied fields:

```ts
await callTool(server, "save_library_container", {
  action: "CREATE",
  type: "PLAN",
  name: "BMP — Base Phase",
  description: "Eight-week aerobic base block",
  rollout_weeks: 2,
});
expect(requestBody).toEqual({
  type: "PLAN",
  name: "BMP — Base Phase",
  description: "Eight-week aerobic base block",
  rollout_weeks: 2,
});
```

Test `UPDATE` requires `container_id`, resolves the current container, rejects a supplied type mismatch, sends only editable fields to `/folders/{id}`, and does not include `children`, owner, counts, or sharing metadata. Test that a `FOLDER` rejects plan-only fields such as `rollout_weeks`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --run test/library.test.ts -t "library container"`

Expected: FAIL because `save_library_container` is not registered.

- [ ] **Step 3: Implement container validation and payload construction**

Use explicit editable-field selection:

```ts
function containerPayload(input: RecordValue): RecordValue {
  return stripUndefined({
    type: input.type,
    name: input.name,
    description: input.description,
    visibility: input.visibility,
    start_date_local: input.start_date_local,
    rollout_weeks: input.rollout_weeks,
    auto_rollout_day: input.auto_rollout_day,
    read_only_workouts: input.read_only_workouts,
    starting_ctl: input.starting_ctl,
    starting_atl: input.starting_atl,
  });
}
```

For `UPDATE`, fetch the folders list, find the ID, verify the optional requested type equals the stored type, and PUT only supplied editable fields plus the stored type when upstream requires it. Return `{ action, container: compactContainer(saved) }`.

- [ ] **Step 4: Run all library tests**

Run: `npm test -- --run test/library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit container writes**

```bash
git add src/tools/library.ts test/library.test.ts
git commit -m "feat: add library folder and plan writes"
```

---

### Task 4: Implement workout creation, update, and event copying

**Files:**
- Modify: `src/tools/library.ts`
- Test: `test/library.test.ts`

**Interfaces:**
- Produces internally: `workoutWritePayload(source, overrides): RecordValue`
- Consumes: `findContainer`
- Registers: `save_library_workout`

- [ ] **Step 1: Write failing `NEW` and `UPDATE` tests**

For `NEW`, assert that a folder workout omits `day`, while a plan workout requires and sends a non-negative `day`. Verify that `workout_doc`, calculated load, and calculated intensity cannot enter the write payload.

For `UPDATE`, mock the current workout GET, provide only a renamed `name`, and assert that the PUT payload preserves current writable fields such as description, sport, targets, and folder while omitting calculated and server-owned fields:

```ts
expect(updateBody).toEqual(expect.objectContaining({
  folder_id: 50,
  name: "SS-3x10 revised",
  description: "Main\n- 3x\n- 10m 90%",
  type: "Ride",
  targets: ["POWER"],
}));
expect(updateBody).not.toHaveProperty("workout_doc");
expect(updateBody).not.toHaveProperty("icu_training_load");
```

- [ ] **Step 2: Write failing `EVENT` copy tests**

Mock `/events/{eventId}` followed by destination lookup and workout POST. Assert that a `WORKOUT` event transfers only supported authoring fields and honors optional name and day overrides. Add a case where `category: "NOTE"` returns `isError: true` and performs no POST.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm test -- --run test/library.test.ts -t "save library workout"`

Expected: FAIL because `save_library_workout` is not registered.

- [ ] **Step 4: Implement one allowlisted workout payload builder**

Allow only these source fields where present:

```ts
const WORKOUT_WRITE_FIELDS = [
  "folder_id", "name", "description", "type", "indoor", "color", "day",
  "hide_from_athlete", "target", "targets", "carbs_per_hour", "tags", "time",
  "sub_type", "for_week", "distance",
] as const;
```

Runtime rules:

- `NEW` requires destination, name, type, and description.
- `UPDATE` requires `workout_id`, fetches the current workout, and merges writable current values with supplied overrides.
- `EVENT` requires destination and `event_id`, fetches the event, requires `category === "WORKOUT"`, then copies allowlisted event fields.
- Destination `PLAN` requires integer `day >= 0`.
- Destination `FOLDER` rejects a supplied `day` and omits it.
- No source accepts `workout_doc`.

POST new/event workouts to `/workouts`; PUT updates to `/workouts/{workoutId}`. Return compact saved-workout metadata.

- [ ] **Step 5: Run all library tests**

Run: `npm test -- --run test/library.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit workout writes**

```bash
git add src/tools/library.ts test/library.test.ts
git commit -m "feat: save workout library content"
```

---

### Task 5: Implement confirmed library deletion

**Files:**
- Modify: `src/tools/library.ts`
- Test: `test/library.test.ts`

**Interfaces:**
- Consumes: `findContainer`
- Registers: `delete_library_item`
- Uses: `IntervalsClient.delete<T>(path, params)` from Task 1.

- [ ] **Step 1: Write failing deletion-safety tests**

Cover:

- `confirm: false` returns `isError: true` before any DELETE;
- workout deletion first resolves `/workouts/{id}`, then calls DELETE with `others=false`, returning upstream deleted IDs;
- folder/plan deletion resolves the container and calls `/folders/{id}`;
- mismatched requested `item_type` returns an error before DELETE;
- the registered tool has `destructiveHint: true` and its description states that deleting folders or plans deletes contained workouts.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --run test/library.test.ts -t "delete library item"`

Expected: FAIL because `delete_library_item` is not registered.

- [ ] **Step 3: Implement explicit resolution and deletion paths**

Use these endpoint rules:

```ts
if (itemType === "WORKOUT") {
  await client.get(`/athlete/${client.athleteId}/workouts/${itemId}`);
  const deletedIds = await client.delete<number[]>(
    `/athlete/${client.athleteId}/workouts/${itemId}`,
    { others: "false" },
  );
  return textResult({ item_id: itemId, item_type: itemType, deleted: true, deleted_ids: deletedIds });
}

const container = await findContainer(client, itemId);
if (container.type !== itemType) throw new Error(`Item ${itemId} is a ${container.type}, not ${itemType}.`);
const upstream = await client.delete<RecordValue>(`/athlete/${client.athleteId}/folders/${itemId}`);
return textResult({ item_id: itemId, item_type: itemType, deleted: true, upstream });
```

Check `confirm` before any lookup so an unconfirmed call is read- and write-free.

- [ ] **Step 4: Run all library tests**

Run: `npm test -- --run test/library.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit deletion**

```bash
git add src/tools/library.ts test/library.test.ts
git commit -m "feat: add confirmed library deletion"
```

---

### Task 6: Implement selected-workout and plan scheduling

**Files:**
- Modify: `src/tools/library.ts`
- Test: `test/library.test.ts`

**Interfaces:**
- Produces internally: `addDays(date: string, days: number): string`
- Produces internally: `resolveWorkoutTime(savedTime, defaultTime): string`
- Produces internally: `eventFromWorkout(workout, startDateLocal, overrides, plan?): RecordValue`
- Registers: `schedule_library`
- Uses: POST query-parameter support from Task 1.

- [ ] **Step 1: Write failing pure date and time tests**

Export `addDays` and `resolveWorkoutTime` for direct unit testing. Cover leap-safe UTC component arithmetic without treating athlete-local values as instants:

```ts
expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
expect(resolveWorkoutTime("07:30", "18:00:00")).toBe("07:30:00");
expect(resolveWorkoutTime(undefined, "18:00:00")).toBe("18:00:00");
expect(resolveWorkoutTime(undefined, undefined)).toBe("00:00:00");
```

Reject invalid saved/default times rather than silently normalizing them.

- [ ] **Step 2: Write failing `WORKOUTS` scheduling tests**

Provide two workout IDs and timestamps. Assert that the handler fetches every full workout before POST, preserves allowlisted event fields, applies a name/calendar override, and posts once to `/events/bulk` with:

```ts
expect(query).toEqual({ upsertOnUid: "false", updatePlanApplied: "false" });
expect(events).toEqual([
  expect.objectContaining({
    category: "WORKOUT",
    start_date_local: "2026-08-18T19:00:00",
    name: "SS-3x10",
    description: expect.any(String),
    type: "Ride",
  }),
]);
```

Verify the same workout ID may appear on different timestamps, while an exact duplicate ID/timestamp pair fails before POST. Verify invalid timestamps, empty arrays, and more than 100 items fail before POST.

- [ ] **Step 3: Write failing `PLAN` scheduling tests**

Mock a `PLAN` with workouts on days 0, 9, and 14, then mock full workout retrieval. Assert correct dates across a month boundary, precedence of saved workout time over `default_start_time`, and linkage fields:

```ts
expect(events[1]).toEqual(expect.objectContaining({
  start_date_local: "2026-09-09T07:30:00",
  plan_athlete_id: "i123",
  plan_folder_id: 90,
  plan_workout_id: 202,
}));
expect(query.updatePlanApplied).toBe("true");
```

Add failures for a `FOLDER` passed as a plan, missing/negative day, invalid saved time, an empty plan, and more than 100 plan workouts. Every failure must have zero POST calls.

- [ ] **Step 4: Run focused scheduling tests and verify failure**

Run: `npm test -- --run test/library.test.ts -t "schedule library"`

Expected: FAIL because `schedule_library` and helpers are not implemented.

- [ ] **Step 5: Implement preflight and one bulk write**

Build all event bodies before POST. The event projection may copy only supported calendar fields:

```ts
const EVENT_COPY_FIELDS = [
  "name", "description", "type", "indoor", "color", "moving_time",
  "icu_training_load", "target", "targets", "hide_from_athlete",
  "carbs_per_hour", "sub_type", "distance", "tags", "for_week", "icu_intensity",
] as const;
```

Set `category: "WORKOUT"` and `start_date_local` explicitly. In plan mode also set `plan_athlete_id`, `plan_folder_id`, and `plan_workout_id`; let `updatePlanApplied=true` establish the common upstream `plan_applied` value.

Call:

```ts
const created = await client.post<RecordValue[]>(
  `/athlete/${client.athleteId}/events/bulk`,
  eventBodies,
  {
    upsertOnUid: "false",
    updatePlanApplied: mode === "PLAN" ? "true" : "false",
  },
);
```

Map each returned event by array position to `{ workout_id, event_id, name, start_date_local }`. If POST throws, return an error whose message includes `Bulk scheduling outcome is unknown; verify the calendar before retrying.` Do not report `created_count: 0` for that case.

- [ ] **Step 6: Run all library tests**

Run: `npm test -- --run test/library.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit scheduling**

```bash
git add src/tools/library.ts test/library.test.ts
git commit -m "feat: schedule workout library content"
```

---

### Task 7: Register, document, and verify the complete suite

**Files:**
- Modify: `src/index.ts`
- Modify: `src/stdio.ts`
- Modify: `test/stdio.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `test/stdio.test.ts`

**Interfaces:**
- Consumes: `registerLibraryTools(server, client)` from Task 2, now registering all six tools.
- Changes: documented and tested tool count from 24 to 30.

- [ ] **Step 1: Write the failing registration expectations**

Change the count assertion to 30 and add these sorted names to the expected list:

```ts
"delete_library_item",
"get_library_workout",
"save_library_container",
"save_library_workout",
"schedule_library",
"search_workout_library",
```

- [ ] **Step 2: Run stdio tests and verify failure**

Run: `npm test -- --run test/stdio.test.ts`

Expected: FAIL with 24 tools because the shared registration is not wired into stdio.

- [ ] **Step 3: Register the module in both transports**

Add the import and call to both entry points:

```ts
import { registerLibraryTools } from "./tools/library.js";

registerEventTools(server, client);
registerLibraryTools(server, client);
registerWellnessTools(server, client);
```

Keep registration order identical in `src/index.ts` and `src/stdio.ts`.

- [ ] **Step 4: Run registration and library tests**

Run: `npm test -- --run test/stdio.test.ts test/library.test.ts`

Expected: PASS with exactly 30 registered tools.

- [ ] **Step 5: Update user and agent documentation**

In `README.md`:

- update the tool total from 24 to 30;
- add six tool-table rows with the compact-search, explicit-delete, and two scheduling modes;
- add a short `Workout Library` section explaining flat reusable folders versus progressive plans;
- state that scheduling expands bodies server-side and bulk writes are not guaranteed transactional.

In `AGENTS.md`:

- update the tool total and project tree with `src/tools/library.ts` and `test/library.test.ts`;
- document private-library scope, zero-based plan days, compact result rules, container deletion cascade, batch limit 100, and unknown bulk-failure outcome;
- document POST query params and typed DELETE response support in `IntervalsClient`.

- [ ] **Step 6: Run formatting and complete verification**

Run: `git diff --check`

Expected: no output.

Run: `npm test`

Expected: all Vitest tests pass.

Run: `npx tsc --noEmit`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 7: Inspect the final diff and commit documentation/registration**

Run: `git status --short`

Expected: only `src/index.ts`, `src/stdio.ts`, `test/stdio.test.ts`, `README.md`, and `AGENTS.md` remain for this task.

```bash
git add src/index.ts src/stdio.ts test/stdio.test.ts README.md AGENTS.md
git commit -m "docs: document workout library tools"
```

- [ ] **Step 8: Confirm the branch is clean**

Run: `git status --short`

Expected: no output.
