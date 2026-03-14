// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";

export interface Env {
  API_KEY: string;
  ATHLETE_ID: string;
  WORKER_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const country = (request as any).cf?.country;
    if (country && country !== "SG") {
      return new Response("Forbidden", { status: 403 });
    }

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.WORKER_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("intervals-mcp worker", { status: 200 });
    }

    const client = new IntervalsClient(env.API_KEY, env.ATHLETE_ID);
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
