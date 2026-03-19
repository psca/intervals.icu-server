// src/stdio.ts — Node.js stdio entry point (not a CF Worker)
// Run with: npx tsx src/stdio.ts
// Credentials via environment variables: API_KEY, ATHLETE_ID

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";

export async function createStdioServer(
  apiKey: string,
  athleteId: string
): Promise<McpServer> {
  if (!apiKey) throw new Error("API_KEY is required");
  if (!athleteId) throw new Error("ATHLETE_ID is required");

  const client = new IntervalsClient(apiKey, athleteId);
  const server = new McpServer({ name: "intervals-mcp", version: "1.0.0" });

  registerActivityTools(server, client);
  registerEventTools(server, client);
  registerWellnessTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return server;
}

// Only run when executed directly (not imported by tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  new URL(import.meta.url).pathname === process.argv[1];

if (isMain) {
  const apiKey = process.env.API_KEY ?? "";
  const athleteId = process.env.ATHLETE_ID ?? "";

  createStdioServer(apiKey, athleteId).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
