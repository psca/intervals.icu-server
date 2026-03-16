// src/index.ts
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";
import {
  isAllowedUser,
  buildGitHubAuthUrl,
  exchangeGitHubCode,
  getGitHubUsername,
} from "./auth.js";

export interface Env {
  API_KEY: string;
  ATHLETE_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ALLOWED_USERS: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: any; // injected by OAuthProvider library
}

const STATE_TTL = 60 * 10; // 10 minutes

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/callback`;
}

// --- Default handler: /authorize and /callback ---

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Step 1 of OAuth flow: parse auth request, store oauthReqInfo in KV,
    // redirect user to GitHub for authentication
    if (url.pathname === "/authorize") {
      let oauthReqInfo;
      try {
        oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return new Response("Invalid OAuth request", { status: 400 });
      }

      // Generate a random state ID to carry oauthReqInfo through the GitHub round-trip
      const stateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `oauth_state:${stateId}`,
        JSON.stringify(oauthReqInfo),
        { expirationTtl: STATE_TTL }
      );

      return Response.redirect(
        buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, callbackUrl(request)),
        302
      );
    }

    // Step 2 of OAuth flow: GitHub redirects here after user authenticates.
    // Verify the user is allowed, then call completeAuthorization so the library
    // issues an auth code and redirects the client back.
    if (url.pathname === "/callback") {
      const githubCode = url.searchParams.get("code");
      const stateId = url.searchParams.get("state");

      if (!githubCode || !stateId) {
        return new Response("Missing code or state", { status: 400 });
      }

      const oauthReqInfoRaw = await env.OAUTH_KV.get(`oauth_state:${stateId}`);
      if (!oauthReqInfoRaw) {
        return new Response("Invalid or expired state", { status: 400 });
      }
      await env.OAUTH_KV.delete(`oauth_state:${stateId}`);

      const oauthReqInfo = JSON.parse(oauthReqInfoRaw);

      let username: string;
      try {
        const githubToken = await exchangeGitHubCode(
          githubCode,
          env.GITHUB_CLIENT_ID,
          env.GITHUB_CLIENT_SECRET,
          callbackUrl(request)
        );
        username = await getGitHubUsername(githubToken);
      } catch {
        return new Response("GitHub auth failed", { status: 502 });
      }

      if (!isAllowedUser(username, env.GITHUB_ALLOWED_USERS)) {
        return new Response("Forbidden: user not allowed", { status: 403 });
      }

      // Hand off to the library — it issues the auth code and redirects the client
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: username,
        metadata: { username },
        scope: oauthReqInfo.scope,
        props: { username },
      });

      return Response.redirect(redirectTo, 302);
    }

    return new Response("intervals-mcp worker", { status: 200 });
  },
};

// --- API handler: /mcp (only reached with a valid token) ---

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // Geo-lock: only Singapore may access the MCP endpoint
    const country = (request as any).cf?.country;
    if (country && country !== "SG") {
      return new Response("Forbidden", { status: 403 });
    }

    const client = new IntervalsClient(env.API_KEY, env.ATHLETE_ID);
    const server = new McpServer({ name: "intervals-mcp", version: "1.0.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    registerActivityTools(server, client);
    registerEventTools(server, client);
    registerWellnessTools(server, client);

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// Named exports for testing
export { defaultHandler, apiHandler };

// Export OAuthProvider as the default Worker entrypoint.
// The library handles: token endpoint, registration endpoint, RFC 8414 + RFC 9728
// discovery, PKCE verification, and all KV token storage.
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 60 * 60 * 24 * 30, // 30 days
});
