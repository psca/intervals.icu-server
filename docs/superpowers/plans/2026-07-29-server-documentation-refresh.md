# Server Documentation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the server README and AGENTS instructions so they accurately describe the current OAuth Worker, local development, 24-tool surface, and split-workout safeguards.

**Architecture:** Treat source files and registration tests as the source of truth. Refresh user-facing setup and architecture information in `README.md`, then update the canonical agent guidance in `AGENTS.md` with the same operational constraints. No runtime code, OAuth configuration, or deployed endpoint changes are part of this work.

**Tech Stack:** Markdown, Node.js, Wrangler, Cloudflare Workers, Vitest.

## Global Constraints

- Modify only `README.md` and `AGENTS.md` as product documentation; the design and plan files are process artifacts.
- Preserve the hosted OAuth quick start, the existing local stdio flow, and the 24-tool table.
- Do not modify source code, `wrangler.toml`, OAuth applications, secrets, KV bindings, deployment state, coach documentation, or `.agents`.
- Describe development OAuth with separate local GitHub and Google clients and the exact callback `http://localhost:8787/callback`.
- Document local secrets only as ignored `.dev.vars` examples; never add real values.
- State that `Ride` and `VirtualRide` are one cycling family, intensity over 80% or absent is advisory only, no override exists, apply requires explicit approval and detailed pre-write fingerprint revalidation, and rollback status is read-back verified and conservative for ambiguous creates.

---

## File Structure

- Modify: `README.md` — public onboarding, hosted and local setup, tool semantics, architecture, and test inventory.
- Modify: `AGENTS.md` — canonical agent instructions, route/tool inventory, session TTL, local OAuth development, and reconciliation invariants.
- Source references only: `src/index.ts`, `src/stdio.ts`, `src/tools/split-reconciliation.ts`, `test/stdio.test.ts`, `wrangler.toml`, `.gitignore`.

### Task 1: Refresh README Setup, Safety Guidance, and Inventory

**Files:**

- Modify: `README.md:5-22`
- Modify: `README.md:111-116`
- Modify: `README.md:209-271`
- Reference: `src/index.ts:58-63`
- Reference: `src/stdio.ts:24-33`
- Reference: `src/tools/split-reconciliation.ts:479-535`
- Reference: `test/stdio.test.ts:18-55`
- Reference: `.gitignore:1-4`

**Interfaces:**

- Preserves: the public Worker URL `https://intervals-mcp.anthonypoh1998.workers.dev/mcp`.
- Preserves: the existing stdio configuration, including `API_KEY` and `ATHLETE_ID`.
- Produces: a documented local OAuth Worker workflow at `http://localhost:8787`.

- [ ] **Step 1: Verify the existing README gaps before editing**

Run:

```bash
rg -n "Developer setup: local OAuth Worker|settings_session|split-workout|weekly-snapshot|analysis.ts|split-reconciliation.ts" README.md
```

Expected: no local OAuth Worker section and no complete architecture inventory for the weekly snapshot, split reconciliation, and analysis modules.

- [ ] **Step 2: Add the local OAuth Worker entry to the table of contents**

In the table of contents, insert this line between remote Worker and local stdio setup:

```md
- [Developer setup: local OAuth Worker](#developer-setup-local-oauth-worker)
```

- [ ] **Step 3: Add the local OAuth Worker section before local stdio**

Insert the following section immediately before `## Developer setup: local stdio`:

```md
## Developer setup: local OAuth Worker

Use this mode to exercise the Cloudflare Worker OAuth flow locally. It uses local Wrangler KV state and does not read or modify the deployed Worker’s credentials.

1. Create separate development GitHub and Google OAuth clients. Keep the production OAuth app callbacks unchanged. Configure both development clients with this redirect URI:

   ```text
   http://localhost:8787/callback
   ```

2. Create the ignored `.dev.vars` file:

   ```dotenv
   CREDENTIALS_MASTER_KEY=<output of openssl rand -hex 32>
   GITHUB_CLIENT_ID=<local GitHub OAuth client ID>
   GITHUB_CLIENT_SECRET=<local GitHub OAuth client secret>
   GOOGLE_CLIENT_ID=<local Google OAuth client ID>
   GOOGLE_CLIENT_SECRET=<local Google OAuth client secret>
   ```

3. Start the Worker:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:8787/settings`, choose GitHub or Google, and enter the intervals.icu Athlete ID and API key. The local MCP endpoint is `http://localhost:8787/mcp`.

An MCP client must be able to reach the local Worker. Hosted clients generally cannot reach `localhost`; use a local client or the stdio mode below for those workflows.
```

- [ ] **Step 4: Document reconciliation safety next to analysis semantics**

After the existing `get_weekly_snapshot` analysis-semantics bullet, add this exact subsection:

```md
### Split-workout reconciliation safety

- Planned and completed `Ride` and `VirtualRide` records are one cycling family. Planned indoor metadata is not an eligibility gate; replacement events use each completed activity’s type and indoor state.
- Completed intensity above 80%, or a missing intensity value, is advisory only. There is no override parameter.
- `reconcile_split_workout` requires explicit approval and the preview fingerprint. Before the first write, it rebuilds the candidate from current detailed event and activity records; a mismatch makes zero changes.
- If an apply fails, rollback is reported complete only after the original event and activities are read back and verified. A create response without a usable ID is treated as ambiguous and therefore incomplete.
```

- [ ] **Step 5: Replace the abbreviated architecture tree with the current module inventory**

Keep the existing top-level entries, then make the `src/` and `test/` listing include these lines:

```text
  analysis.ts           Pure shared analysis helpers for comparison, readiness, and trends
  styles.ts             Shared HTML page styles for OAuth, settings, and help pages
  tools/
    activities.ts       6 tools: list, details, intervals, streams, route, weather
    athlete.ts          6 tools: profile, search, power/pace/HR curves, gear
    events.ts           5 tools: list, get, create/update, delete, delete by range
    wellness.ts         1 tool: wellness data
    weekly-snapshot.ts  1 tool: athlete-local weekly progress and pairing statuses
    split-reconciliation.ts  2 tools: preview and confirmed reconciliation
    analysis.ts         3 tools: similar activity comparison, readiness, discipline trends
test/
  activities.test.ts, athlete.test.ts, analysis.test.ts, auth.test.ts, client.test.ts,
  crypto.test.ts, events.test.ts, formatting.test.ts, index.test.ts, stdio.test.ts,
  weather.test.ts, weekly-snapshot.test.ts, split-reconciliation.test.ts, wellness.test.ts
```

Retain concise descriptions for the existing `index.ts`, `stdio.ts`, `auth.ts`, `crypto.ts`, `client.ts`, `formatting.ts`, `weather.ts`, `openapi-spec.json`, `scripts/`, `tsconfig.stdio.json`, and `vitest.config.ts` entries.

- [ ] **Step 6: Verify README terminology and tool coverage**

Run:

```bash
rg -n "local OAuth Worker|localhost:8787/callback|\.dev\.vars|Split-workout reconciliation safety|cycling family|advisory only|detailed event and activity|ambiguous" README.md
rg -n "get_activities|get_weekly_snapshot|compare_similar_activities|get_training_readiness|get_discipline_trends|get_activity_details|get_activity_intervals|get_activity_streams|get_activity_route|get_activity_weather|get_athlete_profile|search_activities|get_power_curves|get_pace_curves|get_hr_curves|get_gear|get_wellness_data|get_events|get_event_by_id|add_or_update_event|preview_split_workout_reconciliation|reconcile_split_workout|delete_event|delete_events_by_date_range" README.md
```

Expected: the first command finds every new local OAuth and reconciliation concept; the second finds all 24 registered tool names.

- [ ] **Step 7: Commit the README refresh**

Run:

```bash
git diff --check
git add README.md
git commit -m "docs: refresh server README"
```

### Task 2: Refresh AGENTS Canonical Instructions

**Files:**

- Modify: `AGENTS.md:23-69`
- Modify: `AGENTS.md:74-93`
- Modify: `AGENTS.md:95-119`
- Reference: `src/index.ts:58-63`
- Reference: `src/index.ts:319-327`
- Reference: `src/index.ts:866-868`
- Reference: `src/tools/activities.ts:169-177`
- Reference: `src/tools/split-reconciliation.ts:479-535`

**Interfaces:**

- Consumes: README’s public local OAuth vocabulary and source-derived safety rules.
- Produces: canonical agent instructions that prevent stale session, local OAuth, and reconciliation assumptions.

- [ ] **Step 1: Verify the stale AGENTS statements before editing**

Run:

```bash
rg -n "1hr TTL|sampled streams|defaultHandler: handles|split-reconciliation|npm run dev|\.dev\.vars" AGENTS.md
```

Expected: two one-hour session references, the `sampled streams` label, no local `.dev.vars` guidance, and no detailed split-reconciliation invariants.

- [ ] **Step 2: Correct route and tool inventory wording**

Update the `src/index.ts` route summary to include `/` and `/help` before `/authorize`.

Replace the activities entry with:

```text
  activities.ts       -- 6 tools: list, details, intervals, streams, route, weather
```

Keep weekly snapshot, split reconciliation, and analysis module counts at 1, 2, and 3 respectively.

- [ ] **Step 3: Correct settings-session lifetime**

In both the KV-key pattern and settings-session-expiry bullets, replace `1hr TTL` with `7-day TTL`:

```md
`settings_session:<uuid>` (7-day TTL, {accountId, identity})
```

```md
If the `settings_session` cookie exists but the KV entry has expired (7-day TTL), `GET /settings` restarts provider OAuth rather than returning a 401 so users can recover cleanly.
```

- [ ] **Step 4: Add local OAuth Worker guidance after the commands block**

Add this subsection after the commands code block and before `## Secrets`:

```md
## Local OAuth Worker development

`npm run dev` runs the Worker locally at `http://localhost:8787` with local Wrangler KV state. Use separate development GitHub and Google OAuth clients with the redirect URI `http://localhost:8787/callback`; do not replace production OAuth callbacks. Put the local client IDs, provider secrets, and a generated `CREDENTIALS_MASTER_KEY` in ignored `.dev.vars`. Use `/settings` to complete local provider sign-in and credential setup; `/mcp` is the local MCP endpoint.
```

- [ ] **Step 5: Add reconciliation invariants after weekly snapshot semantics**

Add this bullet immediately after the weekly snapshot semantics bullet:

```md
- **Split reconciliation:** Treat `Ride` and `VirtualRide` as one cycling family; planned indoor metadata is not a gate and completed intensity above 80% or missing is advisory only. Never invent an override. Apply only after explicit athlete approval with the exact preview fingerprint. The handler rebuilds the candidate from detailed current records before the first write; failed applies report rollback complete only after read-back verification, and an event create without a usable ID remains an incomplete rollback.
```

- [ ] **Step 6: Verify the canonical instructions against source terms**

Run:

```bash
rg -n "7-day TTL|/help|streams, route, weather|Local OAuth Worker development|localhost:8787/callback|cycling family|Never invent an override|read-back verification|usable ID" AGENTS.md
rg -n "1hr TTL|sampled streams" AGENTS.md && exit 1 || true
```

Expected: the first command finds every refreshed term; the second prints no stale terms.

- [ ] **Step 7: Commit the AGENTS refresh**

Run:

```bash
git diff --check
git add AGENTS.md
git commit -m "docs: refresh server agent guidance"
```

### Task 3: Run Documentation Verification and Prepare the Coach Handoff

**Files:**

- Verify: `README.md`
- Verify: `AGENTS.md`
- Verify only: `test/stdio.test.ts`, `test/split-reconciliation.test.ts`, `test/index.test.ts`

**Interfaces:**

- Produces: a clean, source-aligned server documentation refresh committed on `main`.
- Preserves: all runtime behavior and deployment state.

- [ ] **Step 1: Run focused source-regression tests**

Run:

```bash
npm test -- stdio.test.ts split-reconciliation.test.ts index.test.ts
```

Expected: all three test files pass. The tests confirm the 24-tool contract, split-reconciliation behavior, and OAuth route behavior that the refreshed docs describe.

- [ ] **Step 2: Run final documentation drift searches**

Run:

```bash
rg -n "1hr TTL|one hour|sampled streams|outdoor rides|completed parts at <=80%" README.md AGENTS.md && exit 1 || true
rg -n "24 tools|local OAuth Worker|local stdio|Ride.*VirtualRide|7-day TTL|rollback" README.md AGENTS.md
```

Expected: the first command prints nothing; the second confirms the current surface and safety terms.

- [ ] **Step 3: Inspect the final documentation diff and repository state**

Run:

```bash
git diff HEAD~2..HEAD -- README.md AGENTS.md
git diff --check
git status --short --branch
git log -3 --oneline
```

Expected: only intended documentation commits are present, no whitespace errors exist, and the worktree is clean.

- [ ] **Step 4: Report the completed server refresh and begin the separate coach audit**

Report:

- README and AGENTS commit IDs.
- Focused test result and documentation-search result.
- That source code, deployment, coach documentation, and `.agents` were not modified.
- That the next distinct task is the requested coach and triathlon-skill documentation audit.
