# AGENTS.md

## Project overview

TypeScript Cloudflare Worker implementing an MCP server for intervals.icu training data. Provides 12 tools for activities, wellness, events, and weather analysis. Deployed as a stateless CF Worker with credentials stored as Cloudflare secrets.

## Tech stack

- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (strict mode)
- **MCP SDK:** `@modelcontextprotocol/sdk` using `WebStandardStreamableHTTPServerTransport` (web-standard, not Node.js)
- **Build/Deploy:** Wrangler
- **Testing:** Vitest
- **External APIs:** intervals.icu REST API, Open-Meteo weather API

## Project structure

```
src/index.ts          -- CF Worker entry point, creates MCP server per request (stateless)
src/client.ts         -- IntervalsClient: HTTP client with Basic auth for intervals.icu API
src/formatting.ts     -- 5 pure functions that format API responses into human-readable text
src/weather.ts        -- Pure weather utilities + computeActivityWeather pipeline (Open-Meteo)
src/tools/            -- Tool registration files (one per domain)
  activities.ts       -- 6 tools: list, details, intervals, streams, sampled streams, weather
  events.ts           -- 5 tools: list, get, create/update, delete, delete by range
  wellness.ts         -- 1 tool: wellness data (HRV, CTL/ATL/TSB, sleep)
test/                 -- Unit tests (vitest)
```

## Key patterns

- **Stateless per-request:** Each request creates a new `McpServer` + `IntervalsClient`. No session state, no Durable Objects. `sessionIdGenerator: undefined` disables MCP sessions.
- **Error handling:** Every tool wraps logic in try/catch and returns error text to the MCP client (never crashes the Worker).
- **Sampling logic:** `computeSampleIndices()` in `activities.ts` handles time-based downsampling for GPS streams. Auto-injects `time` stream type when not requested.
- **Weather pipeline:** `get_activity_weather` does everything server-side: fetches GPS streams, calls Open-Meteo (forecast or archive based on age), computes per-waypoint headwind/tailwind using circular bearing math.
- **Circular math:** Wind direction averaging uses trigonometric circular mean (atan2 of sin/cos sums). Headwind detection uses `(... + 360) % 360` to handle JS negative modulo.

## Commands

```bash
npm test           # run all tests (vitest)
npm run dev        # local dev server (wrangler dev)
npm run deploy     # deploy to Cloudflare (wrangler deploy)
```

## Secrets

Set via `npx wrangler secret put <NAME>`:
- `API_KEY` -- intervals.icu API key
- `ATHLETE_ID` -- intervals.icu athlete ID (e.g. `i12345`)

## API base URL

`https://intervals.icu/api/v1` (not `api.intervals.icu` -- that subdomain doesn't exist).
