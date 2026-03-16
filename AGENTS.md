# AGENTS.md

## Project overview

TypeScript Cloudflare Worker implementing an MCP server for intervals.icu training data. Provides 12 tools for activities, wellness, events, and weather analysis. Access is controlled via GitHub OAuth -- only whitelisted GitHub users can authenticate. Deployed as a stateless CF Worker with intervals.icu credentials stored as Cloudflare secrets.

## Tech stack

- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (strict mode)
- **MCP SDK:** `@modelcontextprotocol/sdk` using `WebStandardStreamableHTTPServerTransport` (web-standard, not Node.js)
- **Auth:** `@cloudflare/workers-oauth-provider@0.3.0` -- handles token endpoint, dynamic client registration, RFC 8414 + RFC 9728 discovery, PKCE, KV token storage
- **Build/Deploy:** Wrangler
- **Testing:** Vitest
- **External APIs:** intervals.icu REST API, Open-Meteo weather API

## Project structure

```
src/index.ts          -- CF Worker entry point; OAuthProvider as default export
                         defaultHandler: handles /authorize and /callback (GitHub OAuth dance)
                         apiHandler: handles /mcp (only reached after Bearer token validation)
src/auth.ts           -- 4 GitHub OAuth helpers: buildGitHubAuthUrl, exchangeGitHubCode,
                         getGitHubUsername, isAllowedUser
src/client.ts         -- IntervalsClient: HTTP client with Basic auth for intervals.icu API
src/formatting.ts     -- 5 pure functions that format API responses into human-readable text
src/weather.ts        -- Pure weather utilities + computeActivityWeather pipeline (Open-Meteo)
src/tools/            -- Tool registration files (one per domain)
  activities.ts       -- 6 tools: list, details, intervals, streams, sampled streams, weather
  events.ts           -- 5 tools: list, get, create/update, delete, delete by range
  wellness.ts         -- 1 tool: wellness data (HRV, CTL/ATL/TSB, sleep)
test/                 -- Unit tests (vitest)
  index.test.ts       -- defaultHandler + apiHandler integration tests
  auth.test.ts        -- GitHub OAuth helper unit tests
  vitest.config.ts    -- cloudflare:workers module stub config
  __mocks__/cloudflare-workers.ts -- WorkerEntrypoint stub for vitest
```

## Key patterns

- **Stateless per-request:** Each request creates a new `McpServer` + `IntervalsClient`. No session state, no Durable Objects. `sessionIdGenerator: undefined` disables MCP sessions.
- **Auth gating:** `OAuthProvider` validates the Bearer token and calls `apiHandler` only on success. Unauthenticated requests to `/mcp` get a 401 before any MCP work is done.
- **GitHub allowlist:** `isAllowedUser()` checks the authenticated GitHub username against `GITHUB_ALLOWED_USERS` (comma-separated secret) during the `/callback` step.
- **OAuth state:** During `/authorize`, a UUID state ID is stored in KV (`oauth_state:<id>`) with a 10-minute TTL, carrying the `oauthReqInfo` through the GitHub round-trip.
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
- `GITHUB_CLIENT_SECRET` -- GitHub OAuth app client secret
- `GITHUB_ALLOWED_USERS` -- comma-separated list of allowed GitHub usernames (e.g. `"alice,bob"`)

## Env vars (wrangler.toml)

- `GITHUB_CLIENT_ID` -- GitHub OAuth app client ID (not a secret, safe to commit)

## KV namespaces (wrangler.toml)

- `OAUTH_KV` -- stores OAuth state, tokens, and registered clients (managed by `@cloudflare/workers-oauth-provider`)

## API base URL

`https://intervals.icu/api/v1` (not `api.intervals.icu` -- that subdomain doesn't exist).
