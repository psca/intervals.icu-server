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

const PAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.5; color: #111;
    background: #f5f5f7; min-height: 100vh;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 48px 16px;
  }
  .card {
    background: #fff; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 16px rgba(0,0,0,.06);
    padding: 36px 40px; width: 100%; max-width: 440px;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 600; color: #c0392b; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
  .hint { color: #888; font-weight: 400; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 5px; color: #333; }
  input[type=text], input[type=password] {
    width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px;
    font-size: 14px; font-family: inherit; outline: none; transition: border-color .15s;
  }
  input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
  .btn-primary {
    margin-top: 8px; padding: 9px 18px; background: #2563eb; color: #fff;
    border: none; border-radius: 6px; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-danger {
    padding: 8px 16px; background: #fff; color: #dc2626;
    border: 1px solid #dc2626; border-radius: 6px; font-size: 14px;
    font-weight: 500; cursor: pointer; transition: background .15s, color .15s;
  }
  .btn-danger:hover { background: #dc2626; color: #fff; }
  .danger-zone {
    margin-top: 32px; padding-top: 24px; border-top: 1px solid #f0f0f0;
  }
  .danger-zone p { font-size: 13px; color: #666; margin-bottom: 12px; }
  .error { color: #dc2626; font-size: 13px; margin-bottom: 16px; }
  a { color: #2563eb; }
`;

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
            "Set-Cookie": `settings_session=${sessionToken}; Max-Age=3600; HttpOnly; Secure; SameSite=Lax; Path=/settings`,
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
          ? `<p class="error">Invalid athlete ID or API key. Please try again.</p>`
          : "";

        return new Response(
          `<!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <title>Configure intervals.icu</title>
            <style>${PAGE_CSS}</style>
          </head><body>
            <div class="card">
              <h1>Connect your intervals.icu account</h1>
              <p class="subtitle">Enter your intervals.icu credentials to get started.</p>
              ${errorHtml}
              <form method="POST" action="/configure">
                <input type="hidden" name="state" value="${stateId}">
                <div class="field">
                  <label for="athleteId">Athlete ID <span class="hint">(e.g. i12345)</span></label>
                  <input type="text" id="athleteId" name="athleteId" required autofocus>
                </div>
                <div class="field">
                  <label for="apiKey">API Key</label>
                  <input type="password" id="apiKey" name="apiKey" required>
                </div>
                <button type="submit" class="btn-primary">Save and continue</button>
              </form>
            </div>
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
      if (!session) {
        // Session expired in KV — restart GitHub OAuth (clears stale cookie on success)
        const stateId = crypto.randomUUID();
        await env.OAUTH_KV.put(`settings_state:${stateId}`, JSON.stringify({ placeholder: true }), {
          expirationTtl: 600,
        });
        return Response.redirect(
          buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, callbackUrl(request)),
          302
        );
      }

      const creds = await env.OAUTH_KV.get(`credentials:${session.username}`, "json") as { athleteId: string } | null;

      return new Response(
        `<!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <title>intervals.icu Settings</title>
          <style>${PAGE_CSS}</style>
        </head><body>
          <div class="card">
            <h1>intervals.icu Settings</h1>
            <p class="subtitle">Signed in as <strong>${session.username}</strong></p>
            <form method="POST" action="/settings/save">
              <div class="field">
                <label for="athleteId">Athlete ID</label>
                <input type="text" id="athleteId" name="athleteId" value="${creds?.athleteId ?? ""}" required>
              </div>
              <div class="field">
                <label for="apiKey">API Key <span class="hint">(leave blank to keep current)</span></label>
                <input type="password" id="apiKey" name="apiKey" placeholder="••••••••">
              </div>
              <button type="submit" class="btn-primary">Save</button>
            </form>
            ${creds ? `
            <div class="danger-zone">
              <h2>Danger zone</h2>
              <p>Removes your credentials and disconnects all MCP clients (e.g. Claude Desktop). You will need to re-authorise from scratch.</p>
              <form method="POST" action="/settings/disconnect">
                <button type="submit" class="btn-danger" onclick="return confirm('Disconnect all MCP clients and remove your intervals.icu credentials. Continue?')">Disconnect account</button>
              </form>
            </div>` : ""}
          </div>
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
          `<!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <title>intervals.icu Settings</title>
            <style>${PAGE_CSS}</style>
          </head><body>
            <div class="card">
              <h1>Invalid credentials</h1>
              <p class="error">The athlete ID or API key you entered is incorrect. Please check your <a href="https://intervals.icu/settings" target="_blank" rel="noopener">intervals.icu settings</a> and try again.</p>
              <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Try again</a>
            </div>
          </body></html>`,
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }
        );
      }

      const { encryptedApiKey, iv } = await encryptApiKey(apiKey, session.username, env.CREDENTIALS_MASTER_KEY);
      await env.OAUTH_KV.put(
        `credentials:${session.username}`,
        JSON.stringify({ athleteId, encryptedApiKey, iv })
      );

      return new Response(
        `<!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <title>intervals.icu Settings</title>
          <style>${PAGE_CSS}</style>
        </head><body>
          <div class="card">
            <h1>Credentials updated</h1>
            <p>Your intervals.icu credentials have been saved successfully.</p>
            <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Back to settings</a>
          </div>
        </body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }
      );
    }

    if (url.pathname === "/settings/disconnected") {
      return new Response(
        `<!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <title>Disconnected — intervals.icu</title>
          <style>${PAGE_CSS}</style>
        </head><body>
          <div class="card">
            <h1>Account disconnected</h1>
            <p>Your intervals.icu credentials have been removed and all MCP clients (e.g. Claude Desktop) have been disconnected.</p>
            <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Connect again</a>
          </div>
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
    // This server is stateless — SSE/GET is not supported. Returning 405 prevents
    // the Worker from hanging when MCP clients probe for SSE support.
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

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
