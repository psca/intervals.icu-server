# Workout Library Tools Design

## Goal

Add private Intervals.icu Workout Library support to the MCP server so coaching workflows can maintain reusable workouts, build progressive training plans, and schedule library content without repeatedly transmitting full workout descriptions through the model.

## Scope

This change will add six workflow-oriented tools:

- `search_workout_library`;
- `get_library_workout`;
- `save_library_container`;
- `save_library_workout`;
- `delete_library_item`;
- `schedule_library`.

The tools will support the athlete's own private library. Shared folders and the global or public workout library are outside this change. The implementation will use the athlete ID and API key already configured for the MCP server, so it requires no new OAuth scope or credential migration.

The design will not add nested folders, recurring calendar rules, automatic training progression, or model-authored `workout_doc` structures. It will not deploy the Worker.

## Library Model

The MCP will expose the three Intervals.icu library item types through training-oriented workflows:

- `FOLDER` is a flat category of reusable workouts, such as `Bike — Sweet Spot`.
- `PLAN` is a progressive block whose workouts have zero-based `day` offsets.
- `WORKOUT` is a reusable session in a folder or a scheduled component inside a plan.

Folders will use readable names without numeric prefixes. Plans express progression, while ordinary folders hold stable workout variants. A base plan can therefore reference variants such as `SS-3x08`, `SS-3x10`, and `SS-3x12` in successive weeks without treating each week as an unrelated workout.

The code will live in `src/tools/library.ts` and follow the existing tool registration, result, and error patterns. Both the remote Worker in `src/index.ts` and local stdio server in `src/stdio.ts` will register the tools.

## Compact Discovery

### `search_workout_library`

This read-only tool will list and search the athlete's own folders, plans, and workouts. Inputs will support:

- a text query against names;
- item type `ALL`, `WORKOUT`, `FOLDER`, or `PLAN`;
- sport type;
- container ID;
- a result limit that defaults to 50 and is capped at 100.

Container results will include ID, name, type, description summary where appropriate, and workout count. Workout results will include ID, name, sport, container metadata, moving time, training load, intensity, indoor flag, targets, and tags.

Search results will exclude full descriptions, `workout_doc`, and attachments. Filtering will use upstream metadata and names; the MCP will not infer training categories by parsing workout descriptions.

### `get_library_workout`

This read-only tool will retrieve one complete saved workout. It will return the full text description and supported workout metadata but omit raw `workout_doc` by default. The raw parsed structure is large, server-generated, and not an accepted authoring format for these tools.

## Container Writes

### `save_library_container`

This tool will create or update a `FOLDER` or `PLAN` using an explicit `action` of `CREATE` or `UPDATE`. Updates require `container_id`. Only supplied editable fields will be sent upstream so omitted inputs do not clear existing settings.

Common fields include name and description. Plan-specific fields may include rollout and starting-fitness settings supported by the upstream API. The input schema will reject plan-only fields for ordinary folders where the distinction can be validated locally.

## Workout Writes

### `save_library_workout`

This tool will accept a `source` that identifies how the workout is produced:

- `NEW` creates a workout from supplied workout fields;
- `UPDATE` modifies an existing library workout;
- `EVENT` retrieves an existing calendar workout and copies its supported fields into the library.

`UPDATE` requires `workout_id`. `EVENT` requires `event_id`. Every operation requires a destination `container_id`, either directly or as the existing destination retained during an update.

A workout saved into an ordinary folder does not use a day offset. A workout saved into a plan requires a non-negative integer `day`; day 0 is the plan's first day and day 7 begins its second week.

The text `description` is the canonical authoring format. Intervals.icu will parse it and calculate duration, load, intensity, and structured workout data. The MCP will not accept model-authored `workout_doc` fields.

For `EVENT`, the server will fetch the calendar event and transfer supported workout fields internally. The model only supplies the source event, destination, and optional name or plan-day override. Events whose category is not `WORKOUT` will be rejected.

Responses will return the saved workout ID and compact calculated metadata. Complete content remains available through `get_library_workout`.

## Scheduling

### `schedule_library`

This tool will support two modes.

`WORKOUTS` accepts up to 100 pairs of library workout IDs and athlete-local timestamps. Each item may override the copied event name and calendar ID.

`PLAN` accepts a plan ID, an athlete-local start date, and an optional default start time. The server will retrieve every plan workout and add its zero-based `day` offset to the supplied start date. A valid saved workout time takes precedence over the default time; otherwise the event is scheduled at athlete-local midnight.

Before making a write, the server will:

1. retrieve and validate every referenced item;
2. confirm that a plan ID identifies a `PLAN`;
3. confirm that plan workouts have non-negative day offsets;
4. validate all resulting local dates and times;
5. reject exact duplicate pairs of workout ID and target timestamp within the request;
6. construct every calendar event internally.

After preflight passes, the server will call `POST /athlete/{id}/events/bulk` once with the required query parameters. A small additive `IntervalsClient.post` enhancement may provide optional query parameters; existing callers will remain compatible.

Each generated event will preserve supported source fields, including name, description, sport, targets, tags, duration, load, intensity, indoor flag, and nutrition settings. Plan scheduling will also preserve `plan_workout_id`, `plan_folder_id`, and a common `plan_applied` value where the upstream contract supports those fields.

The response will identify each source workout ID, created event ID, name, and scheduled timestamp. Upstream bulk writes are not documented as transactional, so the MCP will not claim strict atomicity. If a request fails without a usable upstream response, it will report an unknown creation outcome rather than assert that zero events were created.

Selected-workout mode permits per-workout name and timestamp overrides. Plan mode initially permits a block start date and one fallback start time only; it will not rewrite the plan's workout ordering or content during scheduling.

## Deletion

### `delete_library_item`

This tool will delete a `WORKOUT`, `FOLDER`, or `PLAN`. It requires the item type, item ID, and `confirm: true`. Its MCP annotations will identify it as destructive. Intervals.icu inherently deletes every contained workout when a folder or plan is deleted, so the tool description and confirmation error will state that cascade explicitly.

The server will resolve the item before deletion and reject a mismatched item type. Deleting one workout will use `others=false`, so it will not request deletion of other workouts added to the same plan at the same time. Deleting a folder or plan uses the upstream container endpoint and therefore deletes its contents. The response will include the requested item ID, item type, deletion status, and any additional IDs or metadata returned by Intervals.icu.

## Errors and Safety

All tools will use the repository's structured tool-result and error helpers. Errors will identify the failed operation without exposing credentials or authorization headers.

Local validation will reject:

- unknown workouts, containers, plans, or source events;
- attempts to schedule an ordinary folder as a plan;
- missing or negative plan-day offsets;
- invalid athlete-local timestamps;
- updates without the required item ID;
- deletion without explicit confirmation;
- non-workout calendar events used as workout sources;
- batches larger than 100 items;
- an exact duplicate of the same workout ID and target timestamp within one scheduling request.

No bulk write will begin until every item in the request has passed preflight validation. This prevents avoidable partial writes but does not create a transaction around the upstream API.

## Testing

Tests will cover:

1. compact search results excluding descriptions, `workout_doc`, and attachments;
2. query, item-type, sport, container, and limit filtering;
3. complete single-workout retrieval without raw `workout_doc`;
4. folder and plan create and update payloads;
5. new workout creation and plan-day validation;
6. workout update behavior that preserves omitted fields;
7. calendar-event-to-library copying and rejection of non-workout events;
8. confirmed deletion, item-type validation, and rejected unconfirmed deletion;
9. selected-workout scheduling with supported overrides;
10. plan expansion across week, month, and year boundaries;
11. saved workout time, default time, and midnight fallback behavior;
12. rejection of invalid batches before any bulk write;
13. required bulk-event query parameters, request payload, and compact result mapping;
14. ambiguous upstream bulk failures reported without false atomicity claims;
15. tool registration and tool counts in Worker and stdio modes.

After focused tests, the full Vitest suite and TypeScript compiler will pass. `README.md` and `AGENTS.md` will document the new tools, their compact-result behavior, the flat folder model, and the distinction between reusable folders and progressive plans.

## Success Criteria

The change succeeds when an MCP client can:

- find reusable workouts without receiving their full bodies;
- inspect one selected workout in detail;
- create and maintain simple library folders and progressive plans;
- create, update, and save calendar workouts as library templates;
- schedule selected templates or a complete plan through one MCP call and one upstream bulk write;
- delete library items only through an explicitly confirmed destructive operation;
- use the same behavior through remote HTTP and local stdio transports.
