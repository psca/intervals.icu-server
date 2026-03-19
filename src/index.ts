// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";

export interface Env {
  API_KEY?: string;
  ATHLETE_ID?: string;
  WORKER_SECRET?: string;
}

interface ParsedCredentials {
  athleteId: string;
  apiKey: string;
}

function parseCredentials(authHeader: string | null, env: Env): ParsedCredentials | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const colonIndex = token.indexOf(":");
  if (colonIndex !== -1) {
    const athleteId = token.slice(0, colonIndex);
    const apiKey = token.slice(colonIndex + 1);
    if (!/^i\d+$/.test(athleteId) || !apiKey || apiKey.length > 256 || /\s/.test(apiKey)) return null;
    return { athleteId, apiKey };
  }
  // Backward-compat: no colon = match against WORKER_SECRET
  if (env.WORKER_SECRET && token === env.WORKER_SECRET && env.ATHLETE_ID && env.API_KEY) {
    return { athleteId: env.ATHLETE_ID, apiKey: env.API_KEY };
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const credentials = parseCredentials(request.headers.get("Authorization"), env);
    if (!credentials) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("intervals-mcp worker", { status: 200 });
    }

    const client = new IntervalsClient(credentials.apiKey, credentials.athleteId);
    const server = new McpServer({ name: "intervals-mcp", version: "1.0.0" });

    // sessionIdGenerator: undefined = stateless mode (required for CF Workers)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    registerActivityTools(server, client);
    registerEventTools(server, client);
    registerWellnessTools(server, client);

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
