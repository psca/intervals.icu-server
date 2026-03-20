// src/index.ts
import { OAuthProvider, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";
import {
  buildGitHubAuthUrl,
  exchangeGitHubCode,
  getGitHubUsername,
  validateIntervalsCredentials,
} from "./auth.js";
import { encryptApiKey, decryptApiKey } from "./crypto.js";

export interface Env {
  CREDENTIALS_MASTER_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers; // injected by OAuthProvider library
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

      // Settings flow: state was created by /settings
      if (!oauthReqInfoRaw) {
        const settingsStateRaw = await env.OAUTH_KV.get(`settings_state:${stateId}`);
        if (!settingsStateRaw) {
          return new Response("Invalid or expired state", { status: 400 });
        }
        await env.OAUTH_KV.delete(`settings_state:${stateId}`);

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

        const sessionToken = crypto.randomUUID();
        await env.OAUTH_KV.put(
          `settings_session:${sessionToken}`,
          JSON.stringify({ username }),
          { expirationTtl: 3600 }
        );

        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/settings`,
            "Set-Cookie": `settings_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/settings`,
          },
        });
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


      // Check if user already has credentials stored
      const existingCreds = await env.OAUTH_KV.get(`credentials:${username}`);
      if (existingCreds) {
        // Returning user — complete authorization immediately
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: username,
          metadata: { username },
          scope: oauthReqInfo.scope,
          props: { username },
        });
        return Response.redirect(redirectTo, 302);
      }

      // First-time user — collect credentials before completing authorization
      const configureStateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `configure_state:${configureStateId}`,
        JSON.stringify({ oauthReqInfo, username }),
        { expirationTtl: 600 }
      );
      return Response.redirect(
        `${new URL(request.url).origin}/configure?state=${configureStateId}`,
        302
      );
    }

    if (url.pathname === "/configure") {
      if (request.method === "GET") {
        const stateId = url.searchParams.get("state");
        if (!stateId) return new Response("Missing state", { status: 400 });

        const raw = await env.OAUTH_KV.get(`configure_state:${stateId}`);
        if (!raw) return new Response("Invalid or expired state", { status: 400 });

        const error = url.searchParams.get("error");
        const errorHtml = error === "invalid_credentials"
          ? `<p style="color:red">Invalid athlete ID or API key. Please try again.</p>`
          : "";

        return new Response(
          `<!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <title>Configure intervals.icu</title>
          </head><body>
            <h1>Connect your intervals.icu account</h1>
            ${errorHtml}
            <form method="POST" action="/configure">
              <input type="hidden" name="state" value="${stateId}">
              <label>Athlete ID (e.g. i12345)<br>
                <input type="text" name="athleteId" required autofocus>
              </label><br><br>
              <label>API Key<br>
                <input type="password" name="apiKey" required>
              </label><br><br>
              <button type="submit">Save and continue</button>
            </form>
          </body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            },
          }
        );
      }

      if (request.method === "POST") {
        const body = await request.formData();
        const athleteId = body.get("athleteId") as string;
        const apiKey = body.get("apiKey") as string;
        const postStateId = body.get("state") as string;

        const raw = await env.OAUTH_KV.get(`configure_state:${postStateId}`);
        if (!raw) return new Response("Invalid or expired state", { status: 400 });

        // Delete state before processing (replay prevention)
        await env.OAUTH_KV.delete(`configure_state:${postStateId}`);
        const { oauthReqInfo, username } = JSON.parse(raw);

        const valid = await validateIntervalsCredentials(athleteId, apiKey);
        if (!valid) {
          // Issue a fresh state so the user can retry
          const newStateId = crypto.randomUUID();
          await env.OAUTH_KV.put(
            `configure_state:${newStateId}`,
            JSON.stringify({ oauthReqInfo, username }),
            { expirationTtl: 600 }
          );
          return Response.redirect(
            `${url.origin}/configure?state=${newStateId}&error=invalid_credentials`,
            302
          );
        }

        const { encryptedApiKey, iv } = await encryptApiKey(apiKey, username, env.CREDENTIALS_MASTER_KEY);
        await env.OAUTH_KV.put(
          `credentials:${username}`,
          JSON.stringify({ athleteId, encryptedApiKey, iv })
        );

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: username,
          metadata: { username },
          scope: oauthReqInfo.scope,
          props: { username },
        });
        return Response.redirect(redirectTo, 302);
      }
    }

    function getSessionToken(req: Request): string | null {
      const cookie = req.headers.get("Cookie") ?? "";
      const match = cookie.match(/settings_session=([^;]+)/);
      return match ? match[1] : null;
    }

    if (url.pathname === "/settings") {
      const sessionToken = getSessionToken(request);

      if (!sessionToken) {
        // No session — start GitHub OAuth for settings
        const stateId = crypto.randomUUID();
        await env.OAUTH_KV.put(`settings_state:${stateId}`, JSON.stringify({ placeholder: true }), {
          expirationTtl: 600,
        });
        return Response.redirect(
          buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, callbackUrl(request)),
          302
        );
      }

      const session = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json") as { username: string } | null;
      if (!session) return new Response("Session expired. <a href='/settings'>Sign in again</a>", { status: 401 });

      const creds = await env.OAUTH_KV.get(`credentials:${session.username}`, "json") as { athleteId: string } | null;

      return new Response(
        `<!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <title>intervals.icu Settings</title>
        </head><body>
          <h1>Update intervals.icu credentials</h1>
          <form method="POST" action="/settings/save">
            <label>Athlete ID<br>
              <input type="text" name="athleteId" value="${creds?.athleteId ?? ""}" required>
            </label><br><br>
            <label>API Key (leave blank to keep current)<br>
              <input type="password" name="apiKey" placeholder="••••••••">
            </label><br><br>
            <button type="submit">Save</button>
          </form>
          ${creds ? `
          <hr style="margin-top:2em">
          <h2>Danger zone</h2>
          <form method="POST" action="/settings/disconnect">
            <button type="submit" onclick="return confirm('This will remove your intervals.icu credentials and disconnect all MCP clients (e.g. Claude Desktop). You will need to re-authorise from scratch. Continue?')"
              style="color:red">Disconnect account</button>
          </form>` : ""}
        </body></html>`,
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          },
        }
      );
    }

    if (url.pathname === "/settings/save" && request.method === "POST") {
      const sessionToken = getSessionToken(request);
      if (!sessionToken) return new Response("Unauthorized", { status: 401 });

      const session = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json") as { username: string } | null;
      if (!session) return new Response("Session expired", { status: 401 });

      const body = await request.formData();
      const athleteId = body.get("athleteId") as string;
      const apiKey = body.get("apiKey") as string;

      const valid = await validateIntervalsCredentials(athleteId, apiKey);
      if (!valid) {
        return new Response(
          `<!DOCTYPE html><html><body>
            <p>Invalid credentials. <a href="/settings">Try again</a></p>
          </body></html>`,
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const { encryptedApiKey, iv } = await encryptApiKey(apiKey, session.username, env.CREDENTIALS_MASTER_KEY);
      await env.OAUTH_KV.put(
        `credentials:${session.username}`,
        JSON.stringify({ athleteId, encryptedApiKey, iv })
      );

      return new Response(
        `<!DOCTYPE html><html><body>
          <p>Credentials updated successfully.</p>
        </body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (url.pathname === "/settings/disconnected") {
      return new Response(
        `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Disconnected</title>
    </head><body>
      <h1>Account disconnected</h1>
      <p>Your intervals.icu credentials have been removed and all MCP clients (e.g. Claude Desktop) have been disconnected.</p>
      <p><a href="/settings">Set up again</a></p>
    </body></html>`,
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          },
        }
      );
    }

    if (url.pathname === "/settings/disconnect" && request.method === "POST") {
      const sessionToken = getSessionToken(request);
      if (!sessionToken) return new Response("Unauthorized", { status: 401 });

      const session = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json") as { username: string } | null;
      if (!session) return new Response("Session expired", { status: 401 });

      const { username } = session;

      // Paginate through all grants and collect them
      const grants: Array<{ id: string }> = [];
      let cursor: string | undefined;
      do {
        const result = cursor
          ? await env.OAUTH_PROVIDER.listUserGrants(username, { cursor })
          : await env.OAUTH_PROVIDER.listUserGrants(username);
        grants.push(...result.items);
        cursor = result.cursor;
      } while (cursor);

      // Best-effort revocation — a single failure must not block credential deletion
      await Promise.allSettled(grants.map(g => env.OAUTH_PROVIDER.revokeGrant(g.id, username)));

      await env.OAUTH_KV.delete(`credentials:${username}`);
      await env.OAUTH_KV.delete(`settings_session:${sessionToken}`);

      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/settings/disconnected`,
          "Set-Cookie": "settings_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/settings",
        },
      });
    }

    return new Response("intervals-mcp worker", { status: 200 });
  },
};

// --- API handler: /mcp (only reached with a valid token) ---

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const props = ctx.props as { username: string };
    const creds = await env.OAUTH_KV.get(`credentials:${props.username}`, "json") as {
      athleteId: string;
      encryptedApiKey: string;
      iv: string;
    } | null;

    if (!creds) {
      return new Response(
        "No intervals.icu credentials found. Visit /settings to configure your account.",
        { status: 401 }
      );
    }

    const apiKey = await decryptApiKey(
      creds.encryptedApiKey,
      creds.iv,
      props.username,
      env.CREDENTIALS_MASTER_KEY
    );

    const client = new IntervalsClient(apiKey, creds.athleteId);
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
