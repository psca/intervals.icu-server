# intervals-mcp

An MCP (Model Context Protocol) server for [intervals.icu](https://intervals.icu) training data. Provides 18 tools for accessing activities, athlete profiles and curves, wellness data, events/workouts, and weather analysis -- designed to be consumed by LLM-powered coaching assistants.

Two modes:
- **Local (stdio)** -- runs as a local process, no cloud account needed
- **Remote (Cloudflare Worker)** -- persistent public endpoint with GitHub OAuth and per-user credentials

## Tools

| Tool | Description |
|---|---|
| `get_activities` | List activities with date range and filtering |
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
| `add_or_update_event` | Create or modify planned workouts |
| `delete_event` | Delete a single event |
| `delete_events_by_date_range` | Delete all events in a date range |

---

## Option A: Local stdio (quick start)

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

That's it. The MCP client will spawn the server automatically.

---

## Option B: Remote Cloudflare Worker (with OAuth)

Runs as a persistent public endpoint. Any GitHub user can authenticate and connect their own intervals.icu account. Suitable for use with Claude Web or any remote MCP client.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare](https://cloudflare.com) account
- A [GitHub OAuth App](https://github.com/settings/developers) for authentication

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

Create a KV namespace for OAuth token and credential storage:

```bash
npx wrangler kv namespace create OAUTH_KV
# Add the returned ID to wrangler.toml under [[kv_namespaces]]
```

### 5. Set secrets

```bash
# Generate a random 32-byte key for encrypting per-user credentials
openssl rand -hex 32 | npx wrangler secret put CREDENTIALS_MASTER_KEY

npx wrangler secret put GITHUB_CLIENT_SECRET  # GitHub OAuth app client secret
```

### 6. Deploy

```bash
npm run deploy
```

The worker deploys to `https://intervals-mcp.<your-subdomain>.workers.dev`.

### 7. Connect your MCP client

**Claude Web:** add the MCP server URL `https://intervals-mcp.<your-subdomain>.workers.dev/mcp`. Claude will redirect you through the GitHub OAuth flow on first use, then prompt you to enter your intervals.icu athlete ID and API key.

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

On first connection, your MCP client will open a browser window for GitHub login and credential setup.

### Updating credentials

Visit `https://intervals-mcp.<your-subdomain>.workers.dev/settings` to update your intervals.icu athlete ID or API key, or to disconnect your account entirely.

---

## Architecture

```
src/
  index.ts              CF Worker entry point -- OAuthProvider wraps apiHandler + defaultHandler
  stdio.ts              Node.js stdio entry point -- spawned by local MCP clients
  auth.ts               GitHub OAuth helpers (exchange code, get username, validate intervals credentials)
  crypto.ts             HKDF+AES-GCM per-user credential encryption
  client.ts             intervals.icu HTTP client with Basic auth
  formatting.ts         Human-readable formatters for activities, intervals, events, wellness
  weather.ts            Open-Meteo integration + headwind/tailwind computation
  tools/
    activities.ts       6 activity tools (including weather pipeline)
    athlete.ts          6 athlete tools (profile, search, curves, gear)
    events.ts           5 event/workout tools
    wellness.ts         1 wellness tool
test/
  stdio.test.ts         stdio entry point unit tests
  index.test.ts         OAuth flow + apiHandler integration tests
  auth.test.ts          GitHub OAuth helper unit tests
  client.test.ts        Client unit tests
  formatting.test.ts    Formatter tests
  weather.test.ts       Weather utility tests
```

**Stateless design** -- each request creates a fresh MCP server instance. No Durable Objects or session state required. OAuth tokens and encrypted per-user credentials are stored in Cloudflare KV.

## Testing

```bash
npm test
```

## Credits

Inspired by [mvilanova/intervals-mcp-server](https://github.com/mvilanova/intervals-mcp-server). This project diverged significantly in architecture (TypeScript, Cloudflare Workers, GitHub OAuth) but shares the same goal of connecting AI assistants to intervals.icu training data.

## License

[GNU General Public License v3.0](LICENSE)
