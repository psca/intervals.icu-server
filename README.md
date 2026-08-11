# intervals-mcp

An MCP (Model Context Protocol) server for [intervals.icu](https://intervals.icu) training data. Provides 30 tools for accessing activities, athlete profiles and curves, wellness data, events/workouts, workout library management and scheduling, split-workout reconciliation, weather analysis, and compact athlete-analysis workflows -- designed to be consumed by LLM-powered coaching assistants.

Two modes:
- **Remote managed** -- persistent public endpoint with GitHub and Google OAuth configured, plus per-user intervals.icu credentials
- **Local stdio** -- runs as a local process, no cloud account needed

## Table of Contents

- [End-user quick start](#end-user-quick-start)
- [ChatGPT](#chatgpt)
- [Claude](#claude)
- [What to expect during sign-in](#what-to-expect-during-sign-in)
- [Updating your intervals.icu credentials](#updating-your-intervalsicu-credentials)
- [Developer setup: remote worker](#developer-setup-remote-worker)
- [Developer setup: local OAuth Worker](#developer-setup-local-oauth-worker)
- [Developer setup: local stdio](#developer-setup-local-stdio)
- [Tools](#tools)
- [Architecture](#architecture)
- [Testing](#testing)
- [Credits](#credits)
- [License](#license)

## End-user quick start

Start from your chat application, not from this repository.

1. In `ChatGPT` or `Claude`, add the intervals.icu app / connector using:
   ```
   https://intervals-mcp.anthonypoh1998.workers.dev/mcp
   ```
2. Let the chat application begin the OAuth flow when it needs the connection.
3. Sign in with GitHub or Google when prompted.
4. On first setup, enter your intervals.icu `Athlete ID` and `API Key`.
5. Return to the chat application and continue normally.

## ChatGPT

1. Open ChatGPT and enable developer mode if your plan requires it for custom apps.
2. In ChatGPT settings, open `Apps & Connectors`.
3. Add this custom app URL:
   ```
   https://intervals-mcp.anthonypoh1998.workers.dev/mcp
   ```
4. ChatGPT will begin the OAuth flow when it needs the connection.

## Claude

1. Open Claude and go to `https://claude.ai/customize`.
2. Under `Connectors`, add a custom connector with:
   ```
   https://intervals-mcp.anthonypoh1998.workers.dev/mcp
   ```
3. Claude will begin the OAuth flow when it needs the connection.

## What to expect during sign-in

The sign-in flow always begins from the chat application.

1. ChatGPT or Claude asks to connect the intervals.icu app / connector.
2. The app opens the hosted OAuth flow in the browser.
3. You sign in with GitHub or Google.
4. On first connection, the worker asks for your intervals.icu `Athlete ID` and `API Key`.
5. After saving those credentials, the chat application returns to the conversation with live tool access.

To find your intervals.icu credentials:

1. Open `https://intervals.icu/settings`
2. Scroll to `Developer Settings`
3. Copy your `Athlete ID` and `API Key`

## Updating your intervals.icu credentials

Visit:

```text
https://intervals-mcp.anthonypoh1998.workers.dev/settings
```

Use that page to update your intervals.icu athlete ID or API key, or to disconnect your account entirely.

## Tools

| Tool | Description |
|---|---|
| `get_activities` | List activities with date range and filtering |
| `get_weekly_snapshot` | Athlete-local week progress, pairing-derived completion status, and completed/planned totals by discipline |
| `compare_similar_activities` | Compatible-session comparison with recent, median, and per-metric evidence; bike speed affects verdicts only on the same identified route |
| `get_training_readiness` | HRV/RHR trends, actionable signals, future demand, and discipline load states using server-estimated CTL/ATL/TSB |
| `get_discipline_trends` | 4-, 8-, and 12-week volume, fitness, efficiency, durability, and context-compatible curve evidence; load direction is not fitness direction |
| `get_activity_details` | Detailed metrics for a single activity |
| `get_activity_intervals` | Interval/lap data for structured workouts |
| `get_activity_streams` | Full time-series data (power, HR, etc.) |
| `get_activity_route` | GPS/route data sampled at regular intervals for route analysis and elevation profiles |
| `get_activity_weather` | Server-side weather pipeline: GPS + Open-Meteo + headwind/tailwind analysis |
| `get_athlete_profile` | Athlete profile, thresholds, zones, and baseline settings |
| `search_activities` | Search activities by name or tag |
| `get_power_curves` | Peak power curves over a date range |
| `get_pace_curves` | Peak pace curves and critical speed models over a date range |
| `get_hr_curves` | Peak heart-rate curves over a date range |
| `get_gear` | Gear usage summary for bikes, shoes, and other equipment |
| `get_wellness_data` | HRV, resting HR, CTL/ATL/TSB, sleep, weight |
| `get_events` | Planned workouts/events by date range |
| `get_event_by_id` | Single event details |
| `add_or_update_event` | Create or modify planned workouts, with optional athlete-local `start_date_local` scheduling (`YYYY-MM-DDTHH:mm:ss`) |
| `search_workout_library` | Search athlete's private folders, plans, and workouts with compact metadata projection (omits workout descriptions) |
| `get_library_workout` | Retrieve a single library workout by ID (includes workout description; omits raw `workout_doc` and attachments) |
| `save_library_container` | Create or update a top-level `FOLDER` or progressive `PLAN` container |
| `save_library_workout` | Create, update, or copy calendar events into library workouts (`NEW`, `UPDATE`, `EVENT` sources) |
| `delete_library_item` | Explicitly confirmed deletion (`confirm: true`) of a library workout, folder, or plan (deleting a container cascades to contained workouts) |
| `schedule_library` | Bulk calendar scheduling in `WORKOUTS` mode (up to 100 library workouts) or `PLAN` mode (plan expansion from `start_date`) |
| `preview_split_workout_reconciliation` | Read-only preview of eligible easy continuous `Ride` or `VirtualRide` workouts split across same-day cycling activities; completed intensity above 80% is advisory |
| `reconcile_split_workout` | Confirmed, fingerprint-protected event split, activity pairing, and activity rename workflow |
| `delete_event` | Delete a single event |
| `delete_events_by_date_range` | Delete all events in a date range |

Planned event writes accept either the backward-compatible date-only `start_date`
or `start_date_local` for a specific wall-clock time in the athlete timezone configured
in Intervals.icu. Do not append `Z` or a UTC offset to `start_date_local`.

### Workout Library semantics

- **Scope:** The tools use the authenticated athlete's private library endpoints. Records with an explicit mismatched `athlete_id` are excluded; records with an omitted `athlete_id` are accepted as owned results from those endpoints. Shared or community library discovery remains out of scope.
- **Folders vs. Plans:** Containers are either flat `FOLDER` collections (reusable standalone workouts without day offsets) or progressive `PLAN` schedules (multi-day progressions where each workout defines a non-negative integer `day` offset from plan start). Folders reject `day` offsets; plans require integer `day >= 0`.
- **Compact discovery & projections:** `search_workout_library` projects compact metadata to conserve context: compact workout search results omit workout descriptions, `workout_doc`, and attachments (container metadata may include the container description). `get_library_workout` returns the selected workout description but omits raw `workout_doc` and attachments.
- **Confirmed deletions & cascade warning:** `delete_library_item` requires `confirm: true`. Deleting a `FOLDER` or `PLAN` container permanently deletes all contained workouts in intervals.icu (destructive cascade).
- **Scheduling:** `schedule_library` supports `WORKOUTS` mode (individual workouts with local timestamps) and `PLAN` mode (expands zero-based day offsets from `start_date` across month/year boundaries, prioritizing saved workout times over default start times). All validation and workout retrieval complete server-side before performing a single bulk POST (max 100 items). Upstream bulk writes are not transactional; if the upstream request fails, the outcome is reported as unknown and the calendar must be inspected before retrying.

### Analysis semantics

- `compare_similar_activities` selects only candidates with compatibility at least 70. Directional overall verdicts require at least two comparisons and at least two directional metrics with 60% agreement. Cycling speed is evidence only unless both activities use the same non-null route ID in `SAME_ROUTE` mode.
- `get_training_readiness` is advisory. Its per-discipline CTL, ATL, and TSB are server estimates from activity load; a positive TSB caused by `LOW_RECENT_TRAINING` is not a positive readiness signal.
- `get_discipline_trends` separates volume from fitness. `INCREASED`, `DECREASED`, and `STABLE` describe load direction only. Its top-level discipline summary uses the shortest requested window and reports that basis in `summary_window_weeks`; sparse periods and curve evidence cannot produce stable or directional aggregate verdicts. Trend values include explicit metric and unit labels. Races and unusually long sessions still count toward volume, but are excluded from ordinary efficiency cohorts.
- `get_weekly_snapshot` derives pairing from `activity.paired_event_id`. It reports only `COMPLETED`, `UNPAIRED_COMPLETION`, `MISSED`, and `PLANNED`; unpaired activity compliance is `null`, and event descriptions are capped at 2,000 characters.

### Split-workout reconciliation safety

- Planned and completed `Ride` and `VirtualRide` records are one cycling family. Planned indoor metadata is not an eligibility gate; replacement events use each completed activity's type and indoor state.
- Completed intensity above 80%, or a missing intensity value, is advisory only. There is no override parameter.
- `reconcile_split_workout` requires explicit approval and the preview fingerprint. Before the first write, it rebuilds the candidate from current detailed event and activity records; a mismatch makes zero changes.
- If an apply fails, rollback is reported complete only after the original event and activities are read back and verified. A create response without a usable ID is treated as ambiguous and therefore incomplete.

## Developer setup: remote worker

This section is for operators who want to deploy their own hosted worker.

The current Worker implementation always shows both GitHub and Google login options, so deployments must configure both providers.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare](https://cloudflare.com) account
- A [GitHub OAuth App](https://github.com/settings/developers) for authentication
- A Google OAuth web client for authentication

### 2. Clone and install

```bash
git clone https://github.com/psca/intervals.icu-server
cd intervals.icu-server
npm install
```

### 3. Create a GitHub OAuth App

1. Go to GitHub Settings > Developer settings > OAuth Apps > New OAuth App
2. Set **Authorization callback URL** to `https://intervals-mcp.<your-subdomain>.workers.dev/callback`
3. Note the **Client ID** and generate a **Client Secret**

### 4. Create a Google OAuth web client

1. In Google Cloud Console, create or select a project.
2. Configure the OAuth consent screen for your deployment.
3. Create an OAuth client ID with application type **Web application**.
4. Add `https://intervals-mcp.<your-subdomain>.workers.dev/callback` as an authorized redirect URI.
5. Note the **Client ID** and **Client Secret**.

### 5. Configure wrangler.toml

Update with both OAuth client IDs:

```toml
[vars]
GITHUB_CLIENT_ID = "<your-github-client-id>"
GOOGLE_CLIENT_ID = "<your-google-client-id>"
```

Create a KV namespace for OAuth token and credential storage:

```bash
npx wrangler kv namespace create OAUTH_KV
# Add the returned ID to wrangler.toml under [[kv_namespaces]]
```

### 6. Set secrets

```bash
# Generate a random 32-byte key for encrypting per-user credentials
openssl rand -hex 32 | npx wrangler secret put CREDENTIALS_MASTER_KEY

npx wrangler secret put GITHUB_CLIENT_SECRET  # GitHub OAuth app client secret
npx wrangler secret put GOOGLE_CLIENT_SECRET  # Google OAuth web client secret
```

### 7. Deploy

```bash
npm run deploy
```

The worker deploys to `https://intervals-mcp.<your-subdomain>.workers.dev`.

### 8. Connect your MCP client

**Claude Web:** add the MCP server URL `https://intervals-mcp.<your-subdomain>.workers.dev/mcp`. Claude will show a browser login page where you can continue with GitHub or Google, then enter your intervals.icu athlete ID and API key.

**Claude Desktop / Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "intervals-mcp": {
      "type": "http",
      "url": "https://intervals-mcp.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

On first connection, your MCP client will open a browser window for provider login and credential setup.

GitHub and Google identities are separate accounts. Existing credentials from versions that only used GitHub usernames are not migrated; reconnect and re-enter intervals.icu credentials after upgrading.

## Developer setup: local OAuth Worker

Use this mode to exercise the Cloudflare Worker OAuth flow locally. It uses local Wrangler KV state and does not read or modify the deployed Worker's credentials.

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

## Developer setup: local stdio

No cloud account needed. Runs as a local process, communicates with your MCP client over stdio.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- intervals.icu API key and Athlete ID (Settings > API in intervals.icu)

### 2. Clone and install

```bash
git clone https://github.com/psca/intervals.icu-server
cd intervals.icu-server
npm install
```

### 3. Connect your MCP client

Add to your `.mcp.json` (Claude Code / Claude Desktop):

```json
{
  "mcpServers": {
    "intervals-mcp": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "stdio"],
      "env": {
        "API_KEY": "your_intervals_icu_api_key",
        "ATHLETE_ID": "i12345"
      }
    }
  }
}
```

The MCP client will spawn the server automatically.

## Architecture

```
src/
  index.ts              CF Worker entry point -- OAuthProvider wraps apiHandler + defaultHandler
  stdio.ts              Node.js stdio entry point -- spawned by local MCP clients
  analysis.ts            Pure shared analysis helpers for comparison, readiness, and trends
  styles.ts              Shared HTML page styles for OAuth, settings, and help pages
  auth.ts               OAuth helpers (provider auth URLs, code exchange, identity lookup, validate intervals credentials)
  crypto.ts             HKDF+AES-GCM per-user credential encryption
  client.ts             intervals.icu HTTP client with Basic auth
  formatting.ts         Human-readable formatters for activities, intervals, events, wellness
  weather.ts            Open-Meteo integration + headwind/tailwind computation
  tools/
    activities.ts       6 tools: list, details, intervals, streams, route, weather
    athlete.ts          6 tools: profile, search, power/pace/HR curves, gear
    events.ts           5 tools: list, get, create/update, delete, delete by range
    library.ts          6 tools: search, get workout, save container, save workout, confirmed delete, schedule
    wellness.ts         1 tool: wellness data
    weekly-snapshot.ts  1 tool: athlete-local weekly progress and pairing statuses
    split-reconciliation.ts 2 tools: preview and confirmed reconciliation
    analysis.ts         3 tools: similar activity comparison, readiness, discipline trends
test/
  activities.test.ts, athlete.test.ts, analysis.test.ts, auth.test.ts, client.test.ts,
  crypto.test.ts, events.test.ts, formatting.test.ts, index.test.ts, library.test.ts,
  stdio.test.ts, weather.test.ts, weekly-snapshot.test.ts, split-reconciliation.test.ts,
  wellness.test.ts
```

**Stateless design** -- each request creates a fresh MCP server instance. No Durable Objects or session state required. OAuth tokens and encrypted per-user credentials are stored in Cloudflare KV.

## Testing

```bash
npm test
```

## Credits

Inspired by [mvilanova/intervals-mcp-server](https://github.com/mvilanova/intervals-mcp-server). This project diverged significantly in architecture (TypeScript, Cloudflare Workers, OAuth-backed remote auth) but shares the same goal of connecting AI assistants to intervals.icu training data.

## License

[GNU General Public License v3.0](LICENSE)
