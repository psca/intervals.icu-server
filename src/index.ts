// src/index.ts
import { OAuthProvider, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { IntervalsClient } from "./client.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerAthleteTools } from "./tools/athlete.js";
import { registerEventTools } from "./tools/events.js";
import { registerWellnessTools } from "./tools/wellness.js";
import { registerWeeklySnapshotTool } from "./tools/weekly-snapshot.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import {
  AuthIdentity,
  AuthProvider,
  accountId,
  buildProviderAuthUrl,
  credentialsKey,
  exchangeProviderCode,
  getProviderIdentity,
  isAuthProvider,
  validateIntervalsCredentials,
} from "./auth.js";
import { encryptApiKey, decryptApiKey } from "./crypto.js";
import { PAGE_CSS } from "./styles.js";

export interface Env {
  CREDENTIALS_MASTER_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface StoredCredentials {
  athleteId: string;
  encryptedApiKey: string;
  iv: string;
}

interface OAuthState {
  oauthReqInfo: unknown;
  provider?: AuthProvider;
}

interface SettingsState {
  flow: "settings";
  provider?: AuthProvider;
}

interface SettingsSession {
  accountId: string;
  identity: AuthIdentity;
}

const STATE_TTL = 60 * 10; // 10 minutes
const SETTINGS_SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/callback`;
}

function oauthGrantUserId(accountId: string): string {
  return btoa(accountId)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function getQueryParamPreservingPlus(url: URL, name: string): string | null {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  for (const part of query.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    if (decodeURIComponent(rawKey.replaceAll("+", " ")) !== name) {
      continue;
    }
    const rawValue = separator === -1 ? "" : part.slice(separator + 1);
    return decodeURIComponent(rawValue.replaceAll("+", "%2B"));
  }
  return null;
}

function providerClientId(env: Env, provider: AuthProvider): string {
  return provider === "github" ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
}

function providerClientSecret(env: Env, provider: AuthProvider): string {
  return provider === "github" ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
}

function providerLabel(provider: AuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function helpLink(href = "/help", label = "Help"): string {
  return `<a class="page-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function providerIcon(provider: AuthProvider): string {
  if (provider === "github") {
    return `<svg class="provider-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.71 5.47 7.8.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.48-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.97-.82-1.16-.28-.16-.68-.55-.01-.56.63-.01 1.08.6 1.23.85.72 1.24 1.87.89 2.33.67.07-.53.28-.89.5-1.09-1.78-.21-3.64-.92-3.64-4.07 0-.9.31-1.63.82-2.21-.08-.21-.36-1.05.08-2.18 0 0 .67-.22 2.2.85a7.38 7.38 0 0 1 4 0c1.53-1.07 2.2-.85 2.2-.85.44 1.13.16 1.97.08 2.18.51.58.82 1.31.82 2.21 0 3.16-1.87 3.86-3.65 4.07.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.47.55.39A8.19 8.19 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"/>
    </svg>`;
  }

  return `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.26-2.12 3.57-5.24 3.57-8.64Z"/>
    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.1 7.93-2.99l-3.87-3A7.1 7.1 0 0 1 12 19.2c-3.06 0-5.65-2.1-6.58-4.93H1.42v3.09A11.96 11.96 0 0 0 12 24Z"/>
    <path fill="#FBBC05" d="M5.42 14.27A7.37 7.37 0 0 1 5.05 12c0-.79.13-1.56.37-2.27V6.64H1.42A12.26 12.26 0 0 0 0 12c0 1.93.45 3.76 1.42 5.36l4-3.09Z"/>
    <path fill="#EA4335" d="M12 4.8c1.76 0 3.35.62 4.59 1.83l3.44-3.52C17.94 1.1 15.24 0 12 0A11.96 11.96 0 0 0 1.42 6.64l4 3.09C6.35 6.9 8.94 4.8 12 4.8Z"/>
  </svg>`;
}

function identityDisplay(identity: AuthIdentity): string {
  if (identity.provider === "google" && identity.emailVerified && identity.email) {
    return identity.email;
  }
  return identity.displayName;
}

function isSettingsSession(value: unknown): value is SettingsSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeSession = value as Record<string, unknown>;
  if (typeof maybeSession.accountId !== "string" || !maybeSession.accountId) {
    return false;
  }

  const identity = maybeSession.identity;
  if (!identity || typeof identity !== "object") {
    return false;
  }

  const maybeIdentity = identity as Record<string, unknown>;
  return isAuthProvider(maybeIdentity.provider) && typeof maybeIdentity.displayName === "string";
}

async function resolveIdentity(
  provider: AuthProvider,
  code: string,
  request: Request,
  env: Env
): Promise<AuthIdentity> {
  const token = await exchangeProviderCode(
    provider,
    code,
    providerClientId(env, provider),
    providerClientSecret(env, provider),
    callbackUrl(request)
  );
  return getProviderIdentity(provider, token);
}

function authorizationPayload(
  oauthReqInfo: any,
  identity: AuthIdentity,
  userAccountId: string
) {
  return {
    request: oauthReqInfo,
    userId: oauthGrantUserId(userAccountId),
    metadata: {
      provider: identity.provider,
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
    },
    scope: oauthReqInfo.scope,
    props: {
      accountId: userAccountId,
      provider: identity.provider,
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
    },
  };
}

function renderProviderChoicePage(flow: "oauth" | "settings", stateId: string): Response {
  return new Response(
    `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Sign in to intervals.icu MCP</title>
      <style>${PAGE_CSS}</style>
    </head><body>
      <div class="card">
        <h1>Sign in</h1>
        <p class="subtitle">Choose how you want to continue.</p>
        <div class="provider-actions">
          <a class="btn-provider" href="/login?flow=${flow}&state=${stateId}&provider=github">${providerIcon("github")}<span>Continue with ${providerLabel("github")}</span></a>
          <a class="btn-provider" href="/login?flow=${flow}&state=${stateId}&provider=google">${providerIcon("google")}<span>Continue with ${providerLabel("google")}</span></a>
        </div>
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

function renderHelpPage(origin: string): Response {
  const mcpUrl = escapeHtml(`${origin}/mcp`);

  return new Response(
    `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Help</title>
      <style>${PAGE_CSS}</style>
    </head><body>
      <div class="card docs-card">
        <h1>Help</h1>
        <p class="subtitle">Use this server with your MCP client and your intervals.icu account.</p>
        <div class="page-actions">${helpLink("/settings", "Settings")}</div>

        <section class="doc-section" id="intervals-icu">
          <h2>intervals.icu</h2>
          <ol>
            <li>Open <a href="https://intervals.icu/settings" target="_blank" rel="noreferrer">intervals.icu/settings</a> and scroll down to <strong>Developer Settings</strong>.</li>
            <li>
              Copy your athlete ID and API key from that section.
              <div class="settings-shot" aria-label="intervals.icu Developer Settings reference">
                <div class="settings-shot__title">Developer Settings</div>
                <div class="settings-shot__fields">
                  <div>
                    <div class="settings-shot__label">Athlete ID</div>
                    <div class="settings-shot__value">i12345</div>
                  </div>
                  <div>
                    <div class="settings-shot__label">API Key</div>
                    <div class="settings-shot__value">(view)</div>
                  </div>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <section class="doc-section" id="chatgpt">
          <h2>ChatGPT</h2>
          <ol>
            <li>Enable <strong>developer mode</strong> in ChatGPT if your plan requires it for custom apps.</li>
            <li>Open ChatGPT settings, go to <strong>Apps &amp; Connectors</strong>, and add this custom app URL: <code>${mcpUrl}</code>.</li>
            <li>Finish authorization in the browser when prompted.</li>
            <li>Create a new <strong>Project</strong> in ChatGPT for your coaching chats.</li>
            <li>In the Project, choose <strong>Add source</strong> and upload <code>TRIATHLON_TRAINING_CHATGPT_PROJECT_SKILL.md</code>.</li>
          </ol>
          <p class="subtitle">If Skills are not available on your ChatGPT plan, use the Project source file above as the coaching instructions layer.</p>
        </section>

        <section class="doc-section" id="claude">
          <h2>Claude</h2>
          <ol>
            <li>Open <a href="https://claude.ai/customize" target="_blank" rel="noreferrer">claude.ai/customize</a>.</li>
            <li>Under <strong>Connectors</strong>, choose <strong>Add custom connector</strong> and use <code>${mcpUrl}</code> as the server URL.</li>
            <li>Finish the OAuth sign-in flow and return to Claude.</li>
            <li>Under <strong>Skills</strong>, choose <strong>Create skill</strong>, then <strong>Upload a skill</strong>.</li>
            <li>Upload the coach skill ZIP: <code>triathlon-training.zip</code>.</li>
          </ol>
          <p class="subtitle">Claude.ai currently installs the connector and the skill separately for this setup. There is no single bundled install flow on this page today.</p>
        </section>
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

function renderLandingPage(): Response {
  return new Response(
    `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>intervals-mcp</title>
      <style>${PAGE_CSS}</style>
    </head><body>
      <div class="card">
        <h1>intervals-mcp</h1>
        <p class="subtitle">Connect ChatGPT or Claude to your intervals.icu data.</p>
        <div class="page-actions">${helpLink()}</div>
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

// --- Default handler: /authorize and /callback ---

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return renderLandingPage();
    }

    if (url.pathname === "/help") {
      return renderHelpPage(url.origin);
    }

    if (url.pathname === "/authorize") {
      let oauthReqInfo;
      try {
        oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch {
        return new Response("Invalid OAuth request", { status: 400 });
      }

      const stateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `oauth_state:${stateId}`,
        JSON.stringify({ oauthReqInfo }),
        { expirationTtl: STATE_TTL }
      );

      return renderProviderChoicePage("oauth", stateId);
    }

    if (url.pathname === "/login") {
      const flow = url.searchParams.get("flow");
      const stateId = url.searchParams.get("state");
      const providerParam = url.searchParams.get("provider");

      if ((flow !== "oauth" && flow !== "settings") || !stateId || !isAuthProvider(providerParam)) {
        return new Response("Invalid login request", { status: 400 });
      }

      const stateKey = flow === "oauth" ? `oauth_state:${stateId}` : `settings_state:${stateId}`;
      const raw = await env.OAUTH_KV.get(stateKey);
      if (!raw) return new Response("Invalid or expired state", { status: 400 });

      const state = JSON.parse(raw);
      const callbackStateId = crypto.randomUUID();
      const callbackStateKey =
        flow === "oauth"
          ? `oauth_state:${callbackStateId}`
          : `settings_state:${callbackStateId}`;

      await env.OAUTH_KV.put(
        callbackStateKey,
        JSON.stringify({ ...state, provider: providerParam }),
        { expirationTtl: STATE_TTL }
      );
      await env.OAUTH_KV.delete(stateKey);

      return Response.redirect(
        buildProviderAuthUrl(
          providerParam,
          providerClientId(env, providerParam),
          callbackStateId,
          callbackUrl(request)
        ),
        302
      );
    }

    // Step 2 of OAuth flow: GitHub redirects here after user authenticates.
    // Verify the user is allowed, then call completeAuthorization so the library
    // issues an auth code and redirects the client back.
    if (url.pathname === "/callback") {
      const authCode = getQueryParamPreservingPlus(url, "code");
      const stateId = url.searchParams.get("state");

      if (!authCode || !stateId) {
        return new Response("Missing code or state", { status: 400 });
      }

      const oauthStateRaw = await env.OAUTH_KV.get(`oauth_state:${stateId}`);

      // Settings flow: state was created by /settings
      if (!oauthStateRaw) {
        const settingsStateRaw = await env.OAUTH_KV.get(`settings_state:${stateId}`);
        if (!settingsStateRaw) {
          return new Response("Invalid or expired state", { status: 400 });
        }
        const settingsState = JSON.parse(settingsStateRaw) as SettingsState;
        await env.OAUTH_KV.delete(`settings_state:${stateId}`);
        if (!isAuthProvider(settingsState.provider)) {
          return new Response("Invalid or expired state", { status: 400 });
        }

        let identity: AuthIdentity;
        try {
          identity = await resolveIdentity(settingsState.provider, authCode, request, env);
        } catch {
          return new Response(`${providerLabel(settingsState.provider)} auth failed`, { status: 502 });
        }

        const userAccountId = accountId(identity);
        const sessionToken = crypto.randomUUID();
        await env.OAUTH_KV.put(
          `settings_session:${sessionToken}`,
          JSON.stringify({ accountId: userAccountId, identity }),
          { expirationTtl: SETTINGS_SESSION_TTL }
        );

        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/settings`,
            "Set-Cookie": `settings_session=${sessionToken}; Max-Age=${SETTINGS_SESSION_TTL}; HttpOnly; Secure; SameSite=Lax; Path=/settings`,
          },
        });
      }

      await env.OAUTH_KV.delete(`oauth_state:${stateId}`);
      const oauthState = JSON.parse(oauthStateRaw) as OAuthState;
      if (!isAuthProvider(oauthState.provider)) {
        return new Response("Invalid or expired state", { status: 400 });
      }

      let identity: AuthIdentity;
      try {
        identity = await resolveIdentity(oauthState.provider, authCode, request, env);
      } catch {
        return new Response(`${providerLabel(oauthState.provider)} auth failed`, { status: 502 });
      }

      const userAccountId = accountId(identity);

      // Check if user already has credentials stored
      const existingCreds = await env.OAUTH_KV.get(credentialsKey(userAccountId));
      if (existingCreds) {
        // Returning user — complete authorization immediately
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization(
          authorizationPayload(oauthState.oauthReqInfo, identity, userAccountId)
        );
        return Response.redirect(redirectTo, 302);
      }

      // First-time user — collect credentials before completing authorization
      const configureStateId = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `configure_state:${configureStateId}`,
        JSON.stringify({ oauthReqInfo: oauthState.oauthReqInfo, identity, accountId: userAccountId }),
        { expirationTtl: STATE_TTL }
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
                <input type="hidden" name="state" value="${escapeHtml(stateId)}">
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
        const { oauthReqInfo, identity, accountId: userAccountId } = JSON.parse(raw) as {
          oauthReqInfo: any;
          identity: AuthIdentity;
          accountId: string;
        };

        const valid = await validateIntervalsCredentials(athleteId, apiKey);
        if (!valid) {
          // Issue a fresh state so the user can retry
          const newStateId = crypto.randomUUID();
          await env.OAUTH_KV.put(
            `configure_state:${newStateId}`,
            JSON.stringify({ oauthReqInfo, identity, accountId: userAccountId }),
            { expirationTtl: 600 }
          );
          return Response.redirect(
            `${url.origin}/configure?state=${newStateId}&error=invalid_credentials`,
            302
          );
        }

        const { encryptedApiKey, iv } = await encryptApiKey(
          apiKey,
          userAccountId,
          env.CREDENTIALS_MASTER_KEY
        );
        await env.OAUTH_KV.put(
          credentialsKey(userAccountId),
          JSON.stringify({ athleteId, encryptedApiKey, iv })
        );

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization(
          authorizationPayload(oauthReqInfo, identity, userAccountId)
        );
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
        const stateId = crypto.randomUUID();
        await env.OAUTH_KV.put(
          `settings_state:${stateId}`,
          JSON.stringify({ flow: "settings" }),
          { expirationTtl: STATE_TTL }
        );
        return renderProviderChoicePage("settings", stateId);
      }

      const rawSession = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json");
      if (!isSettingsSession(rawSession)) {
        const stateId = crypto.randomUUID();
        await env.OAUTH_KV.put(
          `settings_state:${stateId}`,
          JSON.stringify({ flow: "settings" }),
          { expirationTtl: STATE_TTL }
        );
        return renderProviderChoicePage("settings", stateId);
      }
      const session = rawSession;

      const creds = await env.OAUTH_KV.get(credentialsKey(session.accountId), "json") as StoredCredentials | null;

      return new Response(
        `<!DOCTYPE html><html><head>
          <meta charset="utf-8">
          <title>intervals.icu Settings</title>
          <style>${PAGE_CSS}</style>
        </head><body>
          <div class="card">
            <div class="page-actions">${helpLink()}</div>
            <h1>intervals.icu Settings</h1>
            <p class="subtitle">Signed in with ${providerLabel(session.identity.provider)} as <strong>${escapeHtml(identityDisplay(session.identity))}</strong></p>
            <form method="POST" action="/settings/save">
              <div class="field">
                <label for="athleteId">Athlete ID</label>
                <input type="text" id="athleteId" name="athleteId" value="${escapeHtml(creds?.athleteId ?? "")}" required>
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
              <p>Removes your credentials and disconnects all MCP clients (e.g. Claude Desktop). You will need to re-authorise.</p>
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

      const rawSession = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json");
      if (!isSettingsSession(rawSession)) return new Response("Session expired", { status: 401 });
      const session = rawSession;

      const body = await request.formData();
      const athleteId = ((body.get("athleteId") as string | null) ?? "").trim();
      const apiKey = ((body.get("apiKey") as string | null) ?? "").trim();

      if (!athleteId) {
        return new Response(
          `<!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <title>intervals.icu Settings</title>
            <style>${PAGE_CSS}</style>
          </head><body>
            <div class="card">
              <h1>Missing athlete ID</h1>
              <p class="error">Athlete ID is required.</p>
              <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Try again</a>
            </div>
          </body></html>`,
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }
        );
      }

      let encResult: { encryptedApiKey: string; iv: string };

      if (apiKey) {
        // New API key provided — validate and encrypt
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
        encResult = await encryptApiKey(apiKey, session.accountId, env.CREDENTIALS_MASTER_KEY);
      } else {
        // No API key — keep existing encrypted key
        const existingCreds = await env.OAUTH_KV.get(credentialsKey(session.accountId), "json") as {
          athleteId: string; encryptedApiKey: string; iv: string;
        } | null;
        if (!existingCreds) {
          return new Response(
            `<!DOCTYPE html><html><head>
              <meta charset="utf-8">
              <title>intervals.icu Settings</title>
              <style>${PAGE_CSS}</style>
            </head><body>
              <div class="card">
                <h1>API key required</h1>
                <p class="error">No existing credentials found. Please provide an API key.</p>
                <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Try again</a>
              </div>
            </body></html>`,
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }
          );
        }
        // Validate existing key works with the (possibly new) athlete ID
        const existingApiKey = await decryptApiKey(
          existingCreds.encryptedApiKey, existingCreds.iv,
          session.accountId, env.CREDENTIALS_MASTER_KEY
        );
        const valid = await validateIntervalsCredentials(athleteId, existingApiKey);
        if (!valid) {
          return new Response(
            `<!DOCTYPE html><html><head>
              <meta charset="utf-8">
              <title>intervals.icu Settings</title>
              <style>${PAGE_CSS}</style>
            </head><body>
              <div class="card">
                <h1>Invalid credentials</h1>
                <p class="error">Your existing API key does not work with the provided athlete ID. Please provide a new API key.</p>
                <a href="/settings" class="btn-primary" style="display:inline-block;text-decoration:none">Try again</a>
              </div>
            </body></html>`,
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } }
          );
        }
        encResult = { encryptedApiKey: existingCreds.encryptedApiKey, iv: existingCreds.iv };
      }

      await env.OAUTH_KV.put(
        credentialsKey(session.accountId),
        JSON.stringify({ athleteId, encryptedApiKey: encResult.encryptedApiKey, iv: encResult.iv })
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

      const rawSession = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json");
      if (!isSettingsSession(rawSession)) return new Response("Session expired", { status: 401 });
      const session = rawSession;

      const userAccountId = session.accountId;
      const oauthUserId = oauthGrantUserId(userAccountId);

      // Paginate through all grants and collect them
      const grants: Array<{ id: string }> = [];
      let cursor: string | undefined;
      do {
        const result = cursor
          ? await env.OAUTH_PROVIDER.listUserGrants(oauthUserId, { cursor })
          : await env.OAUTH_PROVIDER.listUserGrants(oauthUserId);
        grants.push(...result.items);
        cursor = result.cursor;
      } while (cursor);

      // Best-effort revocation — a single failure must not block credential deletion
      await Promise.allSettled(grants.map(g => env.OAUTH_PROVIDER.revokeGrant(g.id, oauthUserId)));

      await env.OAUTH_KV.delete(credentialsKey(userAccountId));
      await env.OAUTH_KV.delete(`settings_session:${sessionToken}`);

      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/settings/disconnected`,
          "Set-Cookie": "settings_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/settings",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
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

    const props = ctx.props as { accountId?: string };
    if (!props.accountId) {
      return new Response(
        "No intervals.icu credentials found. Visit /settings to configure your account.",
        { status: 401 }
      );
    }

    const creds = await env.OAUTH_KV.get(credentialsKey(props.accountId), "json") as StoredCredentials | null;

    if (!creds) {
      return new Response(
        "No intervals.icu credentials found. Visit /settings to configure your account.",
        { status: 401 }
      );
    }

    const apiKey = await decryptApiKey(
      creds.encryptedApiKey,
      creds.iv,
      props.accountId,
      env.CREDENTIALS_MASTER_KEY
    );

    const client = new IntervalsClient(apiKey, creds.athleteId);
    const server = new McpServer({ name: "intervals-mcp", version: "1.0.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    registerActivityTools(server, client);
    registerAthleteTools(server, client);
    registerEventTools(server, client);
    registerWellnessTools(server, client);
    registerWeeklySnapshotTool(server, client);
    registerAnalysisTools(server, client);

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
