// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";
import {
  generateId,
  verifyPkce,
  isAllowedUser,
  buildGitHubAuthUrl,
  buildOAuthMetadata,
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
}

const STATE_TTL = 60 * 10;   // 10 minutes
const CODE_TTL = 60 * 5;     // 5 minutes
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

function baseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function callbackUrl(request: Request): string {
  return `${baseUrl(request)}/callback`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Geo-lock: only Singapore may access the MCP endpoint
    if (path.startsWith("/mcp")) {
      const country = (request as any).cf?.country;
      if (country && country !== "SG") {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // OAuth discovery
    if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
      return Response.json(buildOAuthMetadata(baseUrl(request)));
    }

    // Dynamic client registration — accept all, return synthetic client
    if (path === "/register" && request.method === "POST") {
      const body = await request.json() as { redirect_uris?: string[] };
      return Response.json(
        {
          client_id: generateId(),
          client_secret: null,
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: "none",
        },
        { status: 201 }
      );
    }

    // Authorization — store PKCE state, redirect to GitHub
    if (path === "/authorize" && request.method === "GET") {
      const codeChallenge = url.searchParams.get("code_challenge");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? generateId();

      if (!codeChallenge || !redirectUri) {
        return new Response("Missing code_challenge or redirect_uri", { status: 400 });
      }

      const stateId = generateId();
      await env.OAUTH_KV.put(
        `state:${stateId}`,
        JSON.stringify({ codeChallenge, redirectUri, clientState: state }),
        { expirationTtl: STATE_TTL }
      );

      return Response.redirect(
        buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, callbackUrl(request)),
        302
      );
    }

    // GitHub callback — verify user, issue MCP auth code
    if (path === "/callback" && request.method === "GET") {
      const githubCode = url.searchParams.get("code");
      const stateId = url.searchParams.get("state");

      if (!githubCode || !stateId) {
        return new Response("Missing code or state", { status: 400 });
      }

      const stateRaw = await env.OAUTH_KV.get(`state:${stateId}`);
      if (!stateRaw) return new Response("Invalid or expired state", { status: 400 });
      await env.OAUTH_KV.delete(`state:${stateId}`);

      const { codeChallenge, redirectUri, clientState } = JSON.parse(stateRaw);

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
        return new Response("Forbidden", { status: 403 });
      }

      const code = generateId();
      await env.OAUTH_KV.put(
        `code:${code}`,
        JSON.stringify({ codeChallenge }),
        { expirationTtl: CODE_TTL }
      );

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      if (clientState) redirect.searchParams.set("state", clientState);
      return Response.redirect(redirect.toString(), 302);
    }

    // Token exchange — verify PKCE, issue access token
    if (path === "/token" && request.method === "POST") {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const code = params.get("code");
      const codeVerifier = params.get("code_verifier");

      if (!code || !codeVerifier) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      const codeRaw = await env.OAUTH_KV.get(`code:${code}`);
      if (!codeRaw) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      await env.OAUTH_KV.delete(`code:${code}`);

      const { codeChallenge } = JSON.parse(codeRaw);
      if (!(await verifyPkce(codeChallenge, codeVerifier))) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      const accessToken = generateId();
      await env.OAUTH_KV.put(
        `token:${accessToken}`,
        JSON.stringify({ expiresAt: Date.now() + TOKEN_TTL * 1000 }),
        { expirationTtl: TOKEN_TTL }
      );

      return Response.json({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: TOKEN_TTL,
      });
    }

    // Token revocation
    if (path === "/revoke" && request.method === "POST") {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const token = params.get("token");
      if (token) await env.OAUTH_KV.delete(`token:${token}`);
      return new Response(null, { status: 200 });
    }

    // MCP — validate Bearer token, forward to MCP transport
    if (path.startsWith("/mcp")) {
      const authHeader = request.headers.get("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (!token) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer realm="${baseUrl(request)}", error="invalid_token"`,
          },
        });
      }

      const tokenRaw = await env.OAUTH_KV.get(`token:${token}`);
      if (!tokenRaw) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer realm="${baseUrl(request)}", error="invalid_token"`,
          },
        });
      }

      const { expiresAt } = JSON.parse(tokenRaw);
      if (Date.now() > expiresAt) {
        await env.OAUTH_KV.delete(`token:${token}`);
        return new Response("Unauthorized", { status: 401 });
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
    }

    return new Response("intervals-mcp worker", { status: 200 });
  },
};
