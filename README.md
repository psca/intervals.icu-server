# intervals-mcp

A Cloudflare Worker that serves [intervals.icu](https://intervals.icu) training data as an MCP (Model Context Protocol) server. Provides 12 tools for accessing activities, wellness data, events/workouts, and weather analysis -- designed to be consumed by LLM-powered coaching assistants.

## Tools

| Tool | Description |
|---|---|
| `get_activities` | List activities with date range and filtering |
| `get_activity_details` | Detailed metrics for a single activity |
| `get_activity_intervals` | Interval/lap data for structured workouts |
| `get_activity_streams` | Full time-series data (power, HR, etc.) |
| `get_activity_stream_sampled` | Downsampled streams for GPS/route analysis |
| `get_activity_weather` | Server-side weather pipeline: GPS + Open-Meteo + headwind/tailwind analysis |
| `get_wellness_data` | HRV, resting HR, CTL/ATL/TSB, sleep, weight |
| `get_events` | Planned workouts/events by date range |
| `get_event_by_id` | Single event details |
| `add_or_update_event` | Create or modify planned workouts |
| `delete_event` | Delete a single event |
| `delete_events_by_date_range` | Delete all events in a date range |

---

## Option A: Run locally (quick start)

No Cloudflare account needed. Runs on your machine, accessible to local MCP clients.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- intervals.icu API key and Athlete ID (Settings > API in intervals.icu)

### 2. Clone and install

```bash
git clone https://github.com/psca/intervals.icu-server
cd intervals.icu-server
npm install
```

### 3. Set credentials

Create a `.dev.vars` file in the project root:

```
API_KEY=your_intervals_icu_api_key
ATHLETE_ID=i12345
```

### 4. Start the local server

```bash
npm run dev
```

The server runs at `http://localhost:8787`.

### 5. Connect your MCP client

Add to your `.mcp.json` (Claude Code / Claude Desktop):

```json
{
  "mcpServers": {
    "intervals-mcp": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

---

## Option B: Deploy to Cloudflare (remote, with OAuth)

Runs as a persistent public endpoint. Access is controlled via **GitHub OAuth** -- only whitelisted GitHub users can authenticate. Suitable for use with Claude Web or any remote MCP client.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare](https://cloudflare.com) account
- A [GitHub OAuth App](https://github.com/settings/developers) for authentication
- intervals.icu API key and Athlete ID

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

### 4. Configure wrangler.toml

Update with your GitHub Client ID:

```toml
[vars]
GITHUB_CLIENT_ID = "<your-github-client-id>"
```

Create a KV namespace for OAuth token storage:

```bash
npx wrangler kv namespace create OAUTH_KV
# Add the returned ID to wrangler.toml under [[kv_namespaces]]
```

### 5. Set secrets

```bash
npx wrangler secret put API_KEY               # intervals.icu API key
npx wrangler secret put ATHLETE_ID            # athlete ID (e.g. i12345)
npx wrangler secret put GITHUB_CLIENT_SECRET  # GitHub OAuth app client secret
npx wrangler secret put GITHUB_ALLOWED_USERS  # comma-separated GitHub usernames (e.g. "alice,bob")
```

### 6. Deploy

```bash
npm run deploy
```

The worker deploys to `https://intervals-mcp.<your-subdomain>.workers.dev`.

### 7. Connect your MCP client

**Claude Web:** add the MCP server URL `https://intervals-mcp.<your-subdomain>.workers.dev/mcp`. Claude will redirect you through the GitHub OAuth flow on first use.

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

---

## Architecture

```
src/
  index.ts              CF Worker entry point -- OAuthProvider wraps apiHandler + defaultHandler
  auth.ts               GitHub OAuth helpers (exchange code, get username, allowlist check)
  client.ts             intervals.icu HTTP client with Basic auth
  formatting.ts         Human-readable formatters for activities, intervals, events, wellness
  weather.ts            Open-Meteo integration + headwind/tailwind computation
  tools/
    activities.ts       6 activity tools (including weather pipeline)
    events.ts           5 event/workout tools
    wellness.ts         1 wellness tool
test/
  index.test.ts         OAuth flow + apiHandler integration tests
  auth.test.ts          GitHub OAuth helper unit tests
  client.test.ts        Client unit tests
  formatting.test.ts    Formatter tests
  weather.test.ts       Weather utility tests
```

**Stateless design** -- each request creates a fresh MCP server instance. No Durable Objects or session state required. OAuth tokens (remote mode) are stored in Cloudflare KV.

## Testing

```bash
npm test
```
