# Planned Workout Start Times Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `add_or_update_event` create and update planned workouts at an athlete-local time while retaining backward-compatible date-only behavior.

**Architecture:** Extend the existing event tool schema with the upstream `start_date_local` field and resolve the outbound timestamp according to operation type. Keep the behavior in `src/tools/events.ts`; use Zod validation at the MCP boundary and mocked-fetch tool tests to prove exact upstream request payloads.

**Tech Stack:** TypeScript 5.9, Zod via the MCP SDK, Vitest 3, Intervals.icu REST API.

## Global Constraints

- `start_date_local` is exactly `YYYY-MM-DDTHH:mm:ss`, without `Z` or a UTC offset.
- It is a wall-clock value in the athlete timezone configured in Intervals.icu.
- Keep `start_date`; map it to athlete-local midnight.
- `start_date_local` takes precedence when both inputs are supplied.
- Create without either field defaults to today at midnight.
- Update without either field omits `start_date_local` and preserves the stored timestamp.
- Expose the field for both POST creation and PUT update.
- Do not add timezone conversion, a separate `start_time`, or dependencies.

---

## File Structure

- Modify `src/tools/events.ts`: validate, expose, and resolve event start timestamps.
- Modify `test/events.test.ts`: test the schema and exact POST/PUT payloads.
- Modify `README.md`: document athlete-local scheduling.

### Task 1: Implement the tested event timestamp contract

**Files:**
- Modify: `test/events.test.ts`
- Modify: `src/tools/events.ts`

**Interfaces:**
- Consumes: `start_date?: string`, `event_id?: string`.
- Produces: `start_date_local?: string`, exported `localTimestampSchema`, and `resolveStartDateLocal(startDateLocal, startDate, isUpdate): string | undefined`.

- [ ] **Step 1: Add a request capture helper**

In `test/events.test.ts`, import `localTimestampSchema` from `../src/tools/events` and add:

```ts
function successfulEventFetch(capture: (body: Record<string, unknown>) => void) {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    capture(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 123, name: "Ride", type: "Ride", category: "WORKOUT" }),
      text: () => Promise.resolve(""),
    });
  });
}
```

- [ ] **Step 2: Write all failing behavior tests before production changes**

Add tests covering these exact calls and assertions:

```ts
it("creates an event at an athlete-local start time", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", successfulEventFetch(value => { body = value; }));
  const server = await createStdioServer("test-key", "i123");
  await callTool(server, "add_or_update_event", {
    name: "Evening Ride", type: "Ride", start_date_local: "2026-08-04T19:00:00",
  });
  expect(body.start_date_local).toBe("2026-08-04T19:00:00");
});

it("updates an event at an athlete-local start time", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", successfulEventFetch(value => { body = value; }));
  const server = await createStdioServer("test-key", "i123");
  await callTool(server, "add_or_update_event", {
    event_id: "123", name: "Evening Ride", type: "Ride",
    start_date_local: "2026-08-04T19:40:00",
  });
  expect(body.start_date_local).toBe("2026-08-04T19:40:00");
});

it("prefers start_date_local when both date inputs are supplied", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", successfulEventFetch(value => { body = value; }));
  const server = await createStdioServer("test-key", "i123");
  await callTool(server, "add_or_update_event", {
    name: "Ride", type: "Ride", start_date: "2026-08-05",
    start_date_local: "2026-08-04T20:15:00",
  });
  expect(body.start_date_local).toBe("2026-08-04T20:15:00");
});

it("omits start_date_local when an update supplies neither date field", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", successfulEventFetch(value => { body = value; }));
  const server = await createStdioServer("test-key", "i123");
  await callTool(server, "add_or_update_event", {
    event_id: "123", name: "Renamed Ride", type: "Ride",
  });
  expect(body).not.toHaveProperty("start_date_local");
});

it("maps a date-only update to athlete-local midnight", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", successfulEventFetch(value => { body = value; }));
  const server = await createStdioServer("test-key", "i123");
  await callTool(server, "add_or_update_event", {
    event_id: "123", name: "Ride", type: "Ride", start_date: "2026-06-02",
  });
  expect(body.start_date_local).toBe("2026-06-02T00:00:00");
});

it.each([
  "2026-08-04",
  "2026-08-04T19:00",
  "2026-08-04T19:00:00Z",
  "2026-08-04T19:00:00+01:00",
  "2026-02-30T19:00:00",
  "2026-08-04T24:00:00",
])("rejects invalid athlete-local timestamp %s", value => {
  expect(() => localTimestampSchema.parse(value)).toThrow();
});
```

Extend the existing date-only create test with:

```ts
expect(JSON.parse(requestBody).start_date_local).toBe("2026-06-01T00:00:00");
```

- [ ] **Step 3: Run the event tests and verify RED**

Run:

```bash
npm test -- test/events.test.ts
```

Expected: compilation/test failure because `localTimestampSchema` and timed input support do not exist. This is the correct RED state.

- [ ] **Step 4: Add strict local timestamp validation**

Above `registerEventTools` in `src/tools/events.ts`, add:

```ts
export const localTimestampSchema = z.string().superRefine((value, context) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    context.addIssue({ code: "custom", message: "Expected YYYY-MM-DDTHH:mm:ss without a timezone suffix" });
    return;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  const valid = date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
  if (!valid) context.addIssue({ code: "custom", message: "Invalid local date or time" });
});

function resolveStartDateLocal(
  startDateLocal: string | undefined,
  startDate: string | undefined,
  isUpdate: boolean,
): string | undefined {
  if (startDateLocal) return startDateLocal;
  if (startDate) return `${startDate}T00:00:00`;
  return isUpdate ? undefined : `${new Date().toISOString().slice(0, 10)}T00:00:00`;
}
```

- [ ] **Step 5: Expose and forward `start_date_local`**

Beside `start_date` in the input schema, add:

```ts
start_date_local: localTimestampSchema.optional().describe(
  "Athlete-local start time YYYY-MM-DDTHH:mm:ss in the timezone configured in Intervals.icu; do not append Z or an offset"
),
```

Destructure `start_date_local`, delete the unconditional `date` default, and construct `eventData` with:

```ts
start_date_local: resolveStartDateLocal(start_date_local, start_date, Boolean(event_id)),
```

The existing `stripUndefinedFields` call omits the property for timestamp-preserving updates.

- [ ] **Step 6: Run the focused suite and verify GREEN**

Run:

```bash
npm test -- test/events.test.ts
```

Expected: all event tests pass with zero failures.

- [ ] **Step 7: Commit the behavior**

```bash
git add src/tools/events.ts test/events.test.ts
git commit -m "feat: support planned workout start times"
```

### Task 2: Document and verify the public contract

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `add_or_update_event.start_date_local?: string` from Task 1.
- Produces: public usage guidance for date-only and timed event writes.

- [ ] **Step 1: Update README tool guidance**

Change the tool row to:

```md
| `add_or_update_event` | Create or modify planned workouts, with optional athlete-local `start_date_local` scheduling (`YYYY-MM-DDTHH:mm:ss`) |
```

Below the tool table add:

```md
Planned event writes accept either the backward-compatible date-only `start_date`
or `start_date_local` for a specific wall-clock time in the athlete timezone configured
in Intervals.icu. Do not append `Z` or a UTC offset to `start_date_local`.
```

- [ ] **Step 2: Run whitespace validation**

Run `git diff --check`. Expected: exit 0 with no output.

- [ ] **Step 3: Run the full test suite**

Run `npm test`. Expected: every Vitest file and test passes with zero failures.

- [ ] **Step 4: Run both TypeScript checks**

Run:

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.stdio.json
```

Expected: both commands exit 0 with no TypeScript errors.

- [ ] **Step 5: Review exact scope**

Run:

```bash
git diff -- src/tools/events.ts test/events.test.ts README.md
git status --short
```

Confirm the diff implements every global constraint and contains no unrelated changes.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: document planned workout start times"
```

- [ ] **Step 7: Perform fresh final verification**

Run:

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.stdio.json
git diff --check HEAD~2..HEAD
git status --short
```

Expected: tests and typechecks exit 0, the committed diff is whitespace-clean, and the worktree is clean.
