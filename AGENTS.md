# AGENTS.md

## Project overview

TypeScript Cloudflare Worker implementing an MCP server for intervals.icu training data. Provides 12 tools for activities, wellness, events, and weather analysis. Access is controlled via GitHub OAuth — any GitHub user can authenticate. Each user provides their own intervals.icu athlete ID and API key, collected during first-time OAuth via a `/configure` form and stored AES-256-GCM encrypted in OAUTH_KV. Credentials are manageable via the `/settings` page.

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
                         defaultHandler: handles /authorize, /callback, /configure (GET+POST),
                           /settings, /settings/save
                         apiHandler: handles /mcp (only reached after Bearer token validation)
src/stdio.ts          -- Node.js stdio entry point; spawned by local MCP clients via npm run stdio
                         exports createStdioServer(apiKey, athleteId)
src/auth.ts           -- GitHub OAuth helpers: buildGitHubAuthUrl, exchangeGitHubCode,
                         getGitHubUsername, validateIntervalsCredentials
src/crypto.ts         -- HKDF+AES-GCM utilities: hexToBytes, encryptApiKey, decryptApiKey
                         (per-user credential encryption using CREDENTIALS_MASTER_KEY)
src/client.ts         -- IntervalsClient: HTTP client with Basic auth for intervals.icu API
src/formatting.ts     -- 5 pure functions that format API responses into human-readable text
src/weather.ts        -- Pure weather utilities + computeActivityWeather pipeline (Open-Meteo)
src/tools/            -- Tool registration files (one per domain)
  activities.ts       -- 6 tools: list, details, intervals, streams, sampled streams, weather
  events.ts           -- 5 tools: list, get, create/update, delete, delete by range
  wellness.ts         -- 1 tool: wellness data (HRV, CTL/ATL/TSB, sleep)
tsconfig.stdio.json   -- Node.js tsconfig ("types": ["node"]), excludes CF types; used by npm run stdio
vitest.config.ts      -- cloudflare:workers module stub config (at project root, not inside test/)
test/                 -- Unit tests (vitest)
  index.test.ts       -- defaultHandler + apiHandler integration tests
  auth.test.ts        -- GitHub OAuth helper unit tests
  stdio.test.ts       -- 4 tests: tool count, tool names, missing credential errors
  __mocks__/cloudflare-workers.ts -- WorkerEntrypoint stub for vitest
```

## Key patterns

- **Stateless per-request:** Each request creates a new `McpServer` + `IntervalsClient`. No session state, no Durable Objects. `sessionIdGenerator: undefined` disables MCP sessions.
- **Auth gating:** `OAuthProvider` validates the Bearer token and calls `apiHandler` only on success. Unauthenticated requests to `/mcp` get a 401 before any MCP work is done.
- **Open access:** Any GitHub user can authenticate. Access is gated by valid intervals.icu credentials, not a username allowlist.
- **Unified callback:** Both MCP OAuth and settings OAuth redirect to `/callback`. The handler checks `oauth_state:<id>` first; if not found, tries `settings_state:<id>` to determine the flow.
- **OAuth state:** During `/authorize`, a UUID state ID is stored in KV (`oauth_state:<id>`) with a 10-minute TTL, carrying the `oauthReqInfo` through the GitHub round-trip.
- **KV key patterns:** `oauth_state:<uuid>` (10min TTL, oauthReqInfo), `configure_state:<uuid>` (10min TTL, {oauthReqInfo, username}), `credentials:<username>` (no TTL, {athleteId, encryptedApiKey, iv}), `settings_state:<uuid>` (10min TTL, placeholder), `settings_session:<uuid>` (1hr TTL, {username}). `POST /settings/disconnect` deletes both `credentials:<username>` and `settings_session:<token>` and revokes all OAuth grants via `listUserGrants`/`revokeGrant`.
- **Per-user credentials:** `apiHandler` reads `credentials:<username>` from KV using `ctx.props.username`, decrypts the API key with HKDF-derived per-user key, then creates `IntervalsClient`. Returns 401 with `/settings` link if credentials not found.
- **Credential collection flow:** First-time OAuth redirects to `/configure` (form) after GitHub auth. Returning users with stored credentials complete authorization directly. `/settings` provides a separate GitHub OAuth mini-loop to update credentials without re-authorizing MCP clients.
- **Settings session expiry:** If the `settings_session` cookie exists but the KV entry has expired (1hr TTL), `GET /settings` restarts GitHub OAuth rather than returning a 401 — this is intentional so users never hit a dead end.
- **Shared page CSS:** All HTML responses use a `PAGE_CSS` constant defined just above `defaultHandler` in `src/index.ts`. Edit it there to restyle all pages at once.
- **Error handling:** Every tool wraps logic in try/catch and returns error text to the MCP client (never crashes the Worker).
- **Sampling logic:** `computeSampleIndices()` in `activities.ts` handles time-based downsampling for GPS streams. Auto-injects `time` stream type when not requested.
- **Weather pipeline:** `get_activity_weather` does everything server-side: fetches GPS streams, calls Open-Meteo (forecast or archive based on age), computes per-waypoint headwind/tailwind using circular bearing math.
- **Circular math:** Wind direction averaging uses trigonometric circular mean (atan2 of sin/cos sums). Headwind detection uses `(... + 360) % 360` to handle JS negative modulo.
- **stdio entry point:** `src/stdio.ts` exports `createStdioServer(apiKey, athleteId)` — validates credentials, registers all 12 tools, connects `StdioServerTransport`. When run directly (`npm run stdio`), reads credentials from `process.env`. The CF Worker entry point (`src/index.ts`) is not affected.
- **No auth in stdio mode:** Credentials are passed directly as env vars by the MCP client. OAuth is CF Worker only.

## Commands

```bash
npm test           # run all tests (vitest)
npm run dev        # local dev server (wrangler dev)
npm run deploy     # deploy to Cloudflare (wrangler deploy)
```

## Secrets

Set via `npx wrangler secret put <NAME>`:
- `CREDENTIALS_MASTER_KEY` -- 32-byte hex key for AES-256-GCM encryption (generate: `openssl rand -hex 32`)
- `GITHUB_CLIENT_SECRET` -- GitHub OAuth app client secret

## Env vars (wrangler.toml)

- `GITHUB_CLIENT_ID` -- GitHub OAuth app client ID (not a secret, safe to commit)

## KV namespaces (wrangler.toml)

- `OAUTH_KV` -- stores OAuth state, tokens, registered clients, and encrypted per-user credentials

## API base URL

`https://intervals.icu/api/v1` (not `api.intervals.icu` -- that subdomain doesn't exist).

## Testing patterns

- Mock KV with `{ get: vi.fn(), put: vi.fn(), delete: vi.fn() }` — use `mockResolvedValueOnce` chains for sequential calls
- KV `get(..., "json")` returns a parsed object; plain `get(...)` returns a string — mock return values match accordingly
- `vi.stubGlobal("fetch", ...)` + `afterEach(() => vi.unstubAllGlobals())` for fetch mocking
- Web APIs (crypto, fetch, KV) available natively in tests via `@cloudflare/vitest-pool-workers` — no polyfills needed
