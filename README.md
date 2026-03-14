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

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare](https://cloudflare.com) account
- intervals.icu API key and Athlete ID (Settings > API)

### Install

```bash
npm install
```

### Configure secrets

```bash
npx wrangler secret put API_KEY      # your intervals.icu API key
npx wrangler secret put ATHLETE_ID   # your athlete ID (e.g. i12345)
```

### Deploy

```bash
npx wrangler deploy
```

The worker deploys to `https://intervals-mcp.<your-subdomain>.workers.dev`.

### Local development

```bash
npx wrangler dev
```

Then point your MCP client to `http://localhost:8787/mcp`.

### Connect an MCP client

For full client setup across Claude Code, Claude Desktop, and the Desktop Extension, see [psca/intervals.icu-coach](https://github.com/psca/intervals.icu-coach).

Quick start — add to your `.mcp.json`:

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

## Architecture

```
src/
  index.ts              MCP server entry point (CF Worker fetch handler)
  client.ts             intervals.icu HTTP client with Basic auth
  formatting.ts         Human-readable formatters for activities, intervals, events, wellness
  weather.ts            Open-Meteo integration + headwind/tailwind computation
  tools/
    activities.ts       6 activity tools (including weather pipeline)
    events.ts           5 event/workout tools
    wellness.ts         1 wellness tool
test/
  client.test.ts        Client unit tests
  formatting.test.ts    Formatter tests
  weather.test.ts       Weather utility tests (29 tests)
```

Stateless design -- each request creates a fresh MCP server instance. No Durable Objects or session state required.

## Testing

```bash
npm test              # run once
npm run test:watch    # watch mode
```
