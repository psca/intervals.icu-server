# Google Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google login alongside GitHub for the remote Cloudflare Worker MCP server using provider-scoped account IDs.

**Architecture:** Replace GitHub-only login helpers with a provider abstraction that returns a stable `AuthIdentity`. Route `/authorize` and `/settings` through a provider choice screen, store the selected provider in server-side KV state, then use a shared `/callback` to resolve identity and complete either MCP authorization or settings login. Credentials, settings sessions, OAuth grants, and encryption context all use the canonical account id `<provider>:<stable-subject>`.

**Tech Stack:** TypeScript strict mode, Cloudflare Workers, `@cloudflare/workers-oauth-provider`, Vitest with Cloudflare Workers pool, KV-backed OAuth/session state.

---

## File Structure

- Modify `src/auth.ts`: provider types, account-id helpers, GitHub and Google OAuth URL/token/userinfo helpers, intervals credential validation.
- Modify `src/index.ts`: environment fields, provider choice route, callback flow, configure/settings/session/api account-id migration, HTML escaping.
- Modify `src/styles.ts`: provider choice button/link styles.
- Modify `test/auth.test.ts`: provider helper unit tests.
- Modify `test/index.test.ts`: Worker flow tests for provider choice, callback, settings, disconnect, and MCP credential lookup.
- Modify `wrangler.toml`: add `GOOGLE_CLIENT_ID` var placeholder and secret comment.
- Modify `README.md`: document GitHub or Google remote login and Google OAuth setup.
- Modify `AGENTS.md`: update architecture notes, KV keys, secrets, env vars, and auth behavior.

Existing dirty files before this plan: `src/index.ts` and `package-lock.json` already had local modifications. Execution must preserve unrelated user edits and avoid reverting them.

## Task 1: Auth Provider Abstraction

**Files:**
- Modify: `src/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Replace GitHub-only auth tests with provider helper tests**

Update `test/auth.test.ts` imports to:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  accountId,
  buildProviderAuthUrl,
  exchangeProviderCode,
  getProviderIdentity,
  isAuthProvider,
  validateIntervalsCredentials,
} from "../src/auth";
```

Add these tests above `describe("validateIntervalsCredentials", ...)`:

```ts
describe("auth provider helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes supported providers", () => {
    expect(isAuthProvider("github")).toBe(true);
    expect(isAuthProvider("google")).toBe(true);
    expect(isAuthProvider("email")).toBe(false);
    expect(isAuthProvider(null)).toBe(false);
  });

  it("builds canonical account ids", () => {
    expect(accountId({
      provider: "github",
      subject: "12345",
      displayName: "octo",
    })).toBe("github:12345");
  });

  it("builds GitHub auth URL with read:user scope", () => {
    const url = buildProviderAuthUrl("github", "client123", "state456", "https://example.com/callback");
    expect(url).toContain("github.com/login/oauth/authorize");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("state=state456");
    expect(url).toContain("read%3Auser");
    expect(url).toContain("redirect_uri=");
  });

  it("builds Google auth URL with OpenID scopes", () => {
    const url = buildProviderAuthUrl("google", "google-client", "state456", "https://example.com/callback");
    expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("client_id=google-client");
    expect(url).toContain("state=state456");
    expect(url).toContain("openid+email+profile");
    expect(url).toContain("response_type=code");
    expect(url).toContain("redirect_uri=");
  });

  it("exchanges GitHub auth code at GitHub token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ access_token: "gh_tok" }),
    }));

    const token = await exchangeProviderCode("github", "code", "client", "secret", "https://example.com/callback");
    expect(token).toBe("gh_tok");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      client_id: "client",
      client_secret: "secret",
      code: "code",
      redirect_uri: "https://example.com/callback",
    });
  });

  it("exchanges Google auth code at Google token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ access_token: "goog_tok" }),
    }));

    const token = await exchangeProviderCode("google", "code", "client", "secret", "https://example.com/callback");
    expect(token).toBe("goog_tok");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      client_id: "client",
      client_secret: "secret",
      code: "code",
      grant_type: "authorization_code",
      redirect_uri: "https://example.com/callback",
    });
  });

  it("returns GitHub numeric id as subject and login as display name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ id: 12345, login: "octo" }),
    }));

    const identity = await getProviderIdentity("github", "gh_tok");
    expect(identity).toEqual({
      provider: "github",
      subject: "12345",
      displayName: "octo",
    });
  });

  it("returns Google sub as subject and verified email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        sub: "108765432109876543210",
        name: "Ada User",
        email: "ada@example.com",
        email_verified: true,
      }),
    }));

    const identity = await getProviderIdentity("google", "goog_tok");
    expect(identity).toEqual({
      provider: "google",
      subject: "108765432109876543210",
      displayName: "Ada User",
      email: "ada@example.com",
      emailVerified: true,
    });
  });
});
```

Remove the old `describe("buildGitHubAuthUrl", ...)` block after adding these tests.

- [ ] **Step 2: Run auth tests to verify they fail**

Run:

```bash
npm test -- test/auth.test.ts
```

Expected: FAIL because `accountId`, `buildProviderAuthUrl`, `exchangeProviderCode`, `getProviderIdentity`, and `isAuthProvider` are not exported yet.

- [ ] **Step 3: Implement provider helpers in `src/auth.ts`**

Replace the GitHub-specific helper section at the top of `src/auth.ts` with:

```ts
export type AuthProvider = "github" | "google";

export interface AuthIdentity {
  provider: AuthProvider;
  subject: string;
  displayName: string;
  email?: string;
  emailVerified?: boolean;
}

export function isAuthProvider(value: unknown): value is AuthProvider {
  return value === "github" || value === "google";
}

export function accountId(identity: AuthIdentity): string {
  return `${identity.provider}:${identity.subject}`;
}

export function credentialsKey(userAccountId: string): string {
  return `credentials:${userAccountId}`;
}

export function buildProviderAuthUrl(
  provider: AuthProvider,
  clientId: string,
  state: string,
  callbackUrl: string
): string {
  const url = new URL(
    provider === "github"
      ? "https://github.com/login/oauth/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth"
  );
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", callbackUrl);

  if (provider === "github") {
    url.searchParams.set("scope", "read:user");
  } else {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("response_type", "code");
  }

  return url.toString();
}

export async function exchangeProviderCode(
  provider: AuthProvider,
  code: string,
  clientId: string,
  clientSecret: string,
  callbackUrl: string
): Promise<string> {
  const res = await fetch(
    provider === "github"
      ? "https://github.com/login/oauth/access_token"
      : "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        ...(provider === "google" ? { grant_type: "authorization_code" } : {}),
      }),
    }
  );
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) throw new Error(data.error_description ?? data.error ?? "no access_token");
  return data.access_token;
}

export async function getProviderIdentity(
  provider: AuthProvider,
  accessToken: string
): Promise<AuthIdentity> {
  if (provider === "github") {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "intervals-mcp",
      },
    });
    const data = (await res.json()) as { id?: number; login?: string };
    if (data.id === undefined || !data.login) throw new Error("could not get GitHub identity");
    return {
      provider: "github",
      subject: String(data.id),
      displayName: data.login,
    };
  }

  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    sub?: string;
    name?: string;
    email?: string;
    email_verified?: boolean;
  };
  if (!data.sub) throw new Error("could not get Google identity");
  const verifiedEmail = data.email_verified && data.email ? data.email : undefined;
  return {
    provider: "google",
    subject: data.sub,
    displayName: data.name ?? verifiedEmail ?? "Google user",
    email: verifiedEmail,
    emailVerified: data.email_verified === true,
  };
}
```

Keep `validateIntervalsCredentials` unchanged below those helpers.

- [ ] **Step 4: Run auth tests to verify they pass**

Run:

```bash
npm test -- test/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit auth provider abstraction**

Run:

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: add auth provider abstraction"
```

## Task 2: Provider Choice and Login Route

**Files:**
- Modify: `src/index.ts`
- Modify: `src/styles.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Update test env and add provider choice tests**

In `test/index.test.ts`, update `makeEnv()` to include Google config:

```ts
GOOGLE_CLIENT_ID: "goog_client",
GOOGLE_CLIENT_SECRET: "goog_secret",
```

Replace the `/authorize` happy-path test with:

```ts
it("renders provider choices when oauthReqInfo is valid", async () => {
  const env = makeEnv();
  env.OAUTH_PROVIDER.parseAuthRequest.mockResolvedValue({
    clientId: "client123",
    redirectUri: "https://claude.ai/callback",
    scope: ["mcp"],
    state: "abc",
  });

  const req = new Request(
    "https://mcp.example.com/authorize?response_type=code&client_id=client123"
  );
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Continue with GitHub");
  expect(body).toContain("Continue with Google");
  expect(body).toContain("/login?flow=oauth");
  expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
    expect.stringMatching(/^oauth_state:/),
    expect.stringContaining("client123"),
    expect.objectContaining({ expirationTtl: 600 })
  );
});
```

Add a new `describe("defaultHandler /login", ...)` block after `/authorize` tests:

```ts
describe("defaultHandler /login", () => {
  it("rejects unsupported providers", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/login?flow=oauth&state=s1&provider=email");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when oauth state is expired", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/login?flow=oauth&state=s1&provider=github");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("stores GitHub provider in oauth state and redirects to GitHub", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({
      clientId: "client123",
      redirectUri: "https://claude.ai/callback",
      scope: ["mcp"],
      state: "abc",
    }));

    const req = new Request("https://mcp.example.com/login?flow=oauth&state=s1&provider=github");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("github.com/login/oauth/authorize");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "oauth_state:s1",
      expect.stringContaining('"provider":"github"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("stores Google provider in settings state and redirects to Google", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({ flow: "settings" }));

    const req = new Request("https://mcp.example.com/login?flow=settings&state=s1&provider=google");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(res.headers.get("Location")).toContain("client_id=goog_client");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "settings_state:s1",
      expect.stringContaining('"provider":"google"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });
});
```

Update `/settings` tests that expect an immediate GitHub redirect:

```ts
it("GET /settings with no cookie renders provider choices", async () => {
  const env = makeEnv();
  const req = new Request("https://mcp.example.com/settings");
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Continue with GitHub");
  expect(body).toContain("Continue with Google");
  expect(body).toContain("/login?flow=settings");
  expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
    expect.stringMatching(/^settings_state:/),
    expect.any(String),
    expect.objectContaining({ expirationTtl: 600 })
  );
});
```

Remove the old `/settings` test that asserts redirect to GitHub and `/callback`.

- [ ] **Step 2: Run index tests to verify provider choice tests fail**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because `/authorize` and `/settings` still redirect to GitHub and `/login` is not implemented.

- [ ] **Step 3: Update imports and Env in `src/index.ts`**

Change auth imports to:

```ts
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
```

Update `Env`:

```ts
export interface Env {
  CREDENTIALS_MASTER_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}
```

Add these interfaces near `SettingsSession`:

```ts
interface OAuthState {
  oauthReqInfo: unknown;
  provider?: AuthProvider;
}

interface SettingsState {
  flow: "settings";
  provider?: AuthProvider;
}
```

Replace `SettingsSession` with:

```ts
interface SettingsSession {
  accountId: string;
  identity: AuthIdentity;
}
```

Add helper functions below `callbackUrl()`:

```ts
function providerClientId(env: Env, provider: AuthProvider): string {
  return provider === "github" ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID;
}

function providerClientSecret(env: Env, provider: AuthProvider): string {
  return provider === "github" ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
}

function providerLabel(provider: AuthProvider): string {
  return provider === "github" ? "GitHub" : "Google";
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
          <a class="btn-provider" href="/login?flow=${flow}&state=${stateId}&provider=github">Continue with GitHub</a>
          <a class="btn-provider" href="/login?flow=${flow}&state=${stateId}&provider=google">Continue with Google</a>
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
```

- [ ] **Step 4: Render provider choice from `/authorize`**

Replace the `/authorize` KV write and redirect body with:

```ts
const stateId = crypto.randomUUID();
await env.OAUTH_KV.put(
  `oauth_state:${stateId}`,
  JSON.stringify({ oauthReqInfo }),
  { expirationTtl: STATE_TTL }
);

return renderProviderChoicePage("oauth", stateId);
```

- [ ] **Step 5: Add `/login` route**

Add this route before `/callback`:

```ts
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
  await env.OAUTH_KV.put(
    stateKey,
    JSON.stringify({ ...state, provider: providerParam }),
    { expirationTtl: STATE_TTL }
  );

  return Response.redirect(
    buildProviderAuthUrl(
      providerParam,
      providerClientId(env, providerParam),
      stateId,
      callbackUrl(request)
    ),
    302
  );
}
```

- [ ] **Step 6: Render provider choice from `/settings` when no session or expired session**

In both `/settings` branches that create `settings_state`, store a settings state and render provider choice:

```ts
const stateId = crypto.randomUUID();
await env.OAUTH_KV.put(
  `settings_state:${stateId}`,
  JSON.stringify({ flow: "settings" }),
  { expirationTtl: STATE_TTL }
);
return renderProviderChoicePage("settings", stateId);
```

- [ ] **Step 7: Add provider button styles**

Append to `PAGE_CSS` in `src/styles.ts`:

```css
  .provider-actions { display: grid; gap: 10px; margin-top: 20px; }
  .btn-provider {
    display: block; padding: 10px 14px; border: 1px solid #d1d5db;
    border-radius: 6px; color: #111; text-decoration: none; font-size: 14px;
    font-weight: 500; text-align: center; background: #fff;
  }
  .btn-provider:hover { background: #f9fafb; border-color: #9ca3af; }
```

- [ ] **Step 8: Run index tests to verify provider choice passes**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: callback/configure/settings tests still fail because they still expect username-based state and callback behavior. Provider choice and `/login` tests should pass.

- [ ] **Step 9: Commit provider choice route**

Run:

```bash
git add src/index.ts src/styles.ts test/index.test.ts
git commit -m "feat: add oauth provider choice"
```

## Task 3: Callback and Configure with Canonical Account IDs

**Files:**
- Modify: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Update callback tests for provider-scoped identity**

In callback tests, replace OAuth state mock values like:

```ts
JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: ["mcp"], state: "s" })
```

with:

```ts
JSON.stringify({
  oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: ["mcp"], state: "s" },
  provider: "github",
})
```

Update mocked GitHub user responses from `{ login: "testuser" }` to:

```ts
{ id: 12345, login: "testuser" }
```

Add callback tests:

```ts
it("returns 400 when oauth state has no selected provider", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({
    oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: [], state: "s" },
  }));

  const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
  const res = await defaultHandler.fetch(req, env);
  expect(res.status).toBe(400);
});

it("returns 400 when settings state has no selected provider", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(JSON.stringify({ flow: "settings" }));

  const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(400);
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_state:validstate");
});

it("uses Google identity and canonical account id for returning users", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce(JSON.stringify({
      oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: ["mcp"], state: "s" },
      provider: "google",
    }))
    .mockResolvedValueOnce(JSON.stringify({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" }));
  env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({ redirectTo: "https://claude.ai/cb" });

  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "goog_tok" }) })
    .mockResolvedValueOnce({ json: () => Promise.resolve({
      sub: "108765432109876543210",
      name: "Ada User",
      email: "ada@example.com",
      email_verified: true,
    }) })
  );

  const req = new Request("https://mcp.example.com/callback?code=code&state=validstate&provider=github");
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("oauth_state:validstate");
  expect(env.OAUTH_KV.get).toHaveBeenCalledWith("credentials:google:108765432109876543210");
  expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
    userId: "google:108765432109876543210",
    metadata: expect.objectContaining({ provider: "google", email: "ada@example.com" }),
    props: expect.objectContaining({ accountId: "google:108765432109876543210" }),
  }));
});
```

Update the first-time user test to expect `configure_state` containing identity and `credentials:github:12345` lookup:

```ts
expect(env.OAUTH_KV.get).toHaveBeenCalledWith("credentials:github:12345");
expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
  expect.stringMatching(/^configure_state:/),
  expect.stringContaining('"accountId":"github:12345"'),
  expect.objectContaining({ expirationTtl: 600 })
);
```

- [ ] **Step 2: Update configure tests for identity state**

Update configure state mocks from `{ oauthReqInfo, username: "testuser" }` to:

```ts
{
  oauthReqInfo,
  identity: { provider: "github", subject: "12345", displayName: "testuser" },
  accountId: "github:12345",
}
```

Update valid credential test expectation:

```ts
expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
  "credentials:github:12345",
  expect.stringContaining("athleteId")
);
expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
  userId: "github:12345",
  props: expect.objectContaining({ accountId: "github:12345" }),
}));
```

- [ ] **Step 3: Run callback/configure tests to verify they fail**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because callback and configure still use username-based state and credentials.

- [ ] **Step 4: Add account authorization helper in `src/index.ts`**

Add below provider helpers:

```ts
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
    userId: userAccountId,
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
```

- [ ] **Step 5: Rewrite `/callback` OAuth flow**

In `/callback`, rename `githubCode` to:

```ts
const authCode = url.searchParams.get("code");
```

Keep the existing missing-parameter check with the new variable:

```ts
if (!authCode || !stateId) {
  return new Response("Missing code or state", { status: 400 });
}
```

For the OAuth-state branch, after reading `oauthReqInfoRaw`:

```ts
await env.OAUTH_KV.delete(`oauth_state:${stateId}`);
const oauthState = JSON.parse(oauthReqInfoRaw) as OAuthState;
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
const existingCreds = await env.OAUTH_KV.get(credentialsKey(userAccountId));
if (existingCreds) {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization(
    authorizationPayload(oauthState.oauthReqInfo, identity, userAccountId)
  );
  return Response.redirect(redirectTo, 302);
}

const configureStateId = crypto.randomUUID();
await env.OAUTH_KV.put(
  `configure_state:${configureStateId}`,
  JSON.stringify({ oauthReqInfo: oauthState.oauthReqInfo, identity, accountId: userAccountId }),
  { expirationTtl: STATE_TTL }
);
return Response.redirect(`${url.origin}/configure?state=${configureStateId}`, 302);
```

Keep the existing replay prevention behavior: delete `oauth_state:<state>` before provider token exchange.

- [ ] **Step 6: Rewrite `/callback` settings flow**

For the settings-state branch:

```ts
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
  { expirationTtl: 3600 }
);
```

Keep the same redirect and cookie response to `/settings`.

- [ ] **Step 7: Update `/configure` POST**

Replace:

```ts
const { oauthReqInfo, username } = JSON.parse(raw);
```

with:

```ts
const { oauthReqInfo, identity, accountId: userAccountId } = JSON.parse(raw) as {
  oauthReqInfo: any;
  identity: AuthIdentity;
  accountId: string;
};
```

On invalid credentials, re-store:

```ts
JSON.stringify({ oauthReqInfo, identity, accountId: userAccountId })
```

Encrypt and store with account id:

```ts
const { encryptedApiKey, iv } = await encryptApiKey(apiKey, userAccountId, env.CREDENTIALS_MASTER_KEY);
await env.OAUTH_KV.put(
  credentialsKey(userAccountId),
  JSON.stringify({ athleteId, encryptedApiKey, iv })
);
```

Complete authorization:

```ts
const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization(
  authorizationPayload(oauthReqInfo, identity, userAccountId)
);
return Response.redirect(redirectTo, 302);
```

- [ ] **Step 8: Run index tests to verify callback/configure pass**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: callback/configure tests pass; settings and api handler username tests still fail.

- [ ] **Step 9: Commit callback/configure account-id flow**

Run:

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: use provider scoped ids in auth callback"
```

## Task 4: Settings and MCP API Account IDs

**Files:**
- Modify: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Update settings tests to use account-id sessions**

Replace settings session mocks like:

```ts
{ username: "testuser" }
```

with:

```ts
{
  accountId: "github:12345",
  identity: { provider: "github", subject: "12345", displayName: "testuser" },
}
```

Update expected credential keys from `credentials:testuser` to `credentials:github:12345`.

Update grant revocation expectations:

```ts
expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-1", "github:12345");
expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-2", "github:12345");
```

Add a test that settings displays Google verified email:

```ts
it("GET /settings displays verified Google email", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce({
      accountId: "google:108765432109876543210",
      identity: {
        provider: "google",
        subject: "108765432109876543210",
        displayName: "Ada User",
        email: "ada@example.com",
        emailVerified: true,
      },
    })
    .mockResolvedValueOnce({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" });

  const req = new Request("https://mcp.example.com/settings", {
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);
  const body = await res.text();

  expect(body).toContain("Signed in with Google as");
  expect(body).toContain("ada@example.com");
});
```

- [ ] **Step 2: Update api handler tests**

Change missing credentials test context:

```ts
const ctx = { props: { accountId: "github:12345" } };
```

Add legacy props test:

```ts
it("returns 401 when token props do not include accountId", async () => {
  const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
  const ctx = { props: { username: "testuser" } };

  const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
  const res = await apiHandler.fetch(req, env, ctx);

  expect(res.status).toBe(401);
  expect(env.OAUTH_KV.get).not.toHaveBeenCalledWith("credentials:undefined", "json");
});
```

Update decrypted credential test:

```ts
const userAccountId = "github:12345";
const { encryptedApiKey, iv } = await enc("real-api-key", userAccountId, masterKey);
const ctx = { props: { accountId: userAccountId } };
```

- [ ] **Step 3: Run index tests to verify settings/api tests fail**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL because settings and api handler still use `username`.

- [ ] **Step 4: Add display and session helpers**

Add below `providerLabel()`:

```ts
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function identityDisplay(identity: AuthIdentity): string {
  if (identity.provider === "google" && identity.emailVerified && identity.email) {
    return identity.email;
  }
  return identity.displayName;
}
```

- [ ] **Step 5: Update `/settings` GET**

Replace credential lookup:

```ts
const creds = await env.OAUTH_KV.get(credentialsKey(session.accountId), "json") as StoredCredentials | null;
```

Replace signed-in copy with escaped provider display:

```ts
<p class="subtitle">Signed in with ${providerLabel(session.identity.provider)} as <strong>${escapeHtml(identityDisplay(session.identity))}</strong></p>
```

Escape athlete ID:

```ts
value="${escapeHtml(creds?.athleteId ?? "")}"
```

- [ ] **Step 6: Update `/settings/save`**

Replace all `session.username` uses with `session.accountId`.

Encrypt new API keys:

```ts
encResult = await encryptApiKey(apiKey, session.accountId, env.CREDENTIALS_MASTER_KEY);
```

Read existing credentials:

```ts
const existingCreds = await env.OAUTH_KV.get(credentialsKey(session.accountId), "json") as StoredCredentials | null;
```

Decrypt existing API key:

```ts
const existingApiKey = await decryptApiKey(
  existingCreds.encryptedApiKey,
  existingCreds.iv,
  session.accountId,
  env.CREDENTIALS_MASTER_KEY
);
```

Store updated credentials:

```ts
await env.OAUTH_KV.put(
  credentialsKey(session.accountId),
  JSON.stringify({ athleteId, encryptedApiKey: encResult.encryptedApiKey, iv: encResult.iv })
);
```

- [ ] **Step 7: Update `/settings/disconnect`**

Replace:

```ts
const { username } = session;
```

with:

```ts
const userAccountId = session.accountId;
```

Use `userAccountId` in `listUserGrants`, `revokeGrant`, and credential deletion:

```ts
const result = cursor
  ? await env.OAUTH_PROVIDER.listUserGrants(userAccountId, { cursor })
  : await env.OAUTH_PROVIDER.listUserGrants(userAccountId);

await Promise.allSettled(grants.map(g => env.OAUTH_PROVIDER.revokeGrant(g.id, userAccountId)));
await env.OAUTH_KV.delete(credentialsKey(userAccountId));
```

- [ ] **Step 8: Update `apiHandler`**

Replace:

```ts
const props = ctx.props as { username: string };
const creds = await env.OAUTH_KV.get(`credentials:${props.username}`, "json") as StoredCredentials | null;
```

with:

```ts
const props = ctx.props as { accountId?: string };
if (!props.accountId) {
  return new Response(
    "No intervals.icu credentials found. Visit /settings to configure your account.",
    { status: 401 }
  );
}

const creds = await env.OAUTH_KV.get(credentialsKey(props.accountId), "json") as StoredCredentials | null;
```

Decrypt with account id:

```ts
const apiKey = await decryptApiKey(
  creds.encryptedApiKey,
  creds.iv,
  props.accountId,
  env.CREDENTIALS_MASTER_KEY
);
```

- [ ] **Step 9: Run index tests to verify settings/api pass**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit settings and api account-id flow**

Run:

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: use account ids for settings and mcp credentials"
```

## Task 5: HTML Escaping Coverage

**Files:**
- Modify: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: Add escaping regression tests**

Add to `describe("defaultHandler /settings", ...)`:

```ts
it("escapes identity display and athlete ID in settings HTML", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce({
      accountId: "google:sub1",
      identity: {
        provider: "google",
        subject: "sub1",
        displayName: "<script>alert(1)</script>",
        email: "ada<script>@example.com",
        emailVerified: true,
      },
    })
    .mockResolvedValueOnce({ athleteId: 'i123"><script>alert(2)</script>', encryptedApiKey: "enc", iv: "iv" });

  const req = new Request("https://mcp.example.com/settings", {
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);
  const body = await res.text();

  expect(body).toContain("ada&lt;script&gt;@example.com");
  expect(body).toContain("i123&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
  expect(body).not.toContain("<script>alert");
});
```

Add to `describe("defaultHandler /configure", ...)`:

```ts
it("escapes configure state value in hidden input", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValue(
    JSON.stringify({
      oauthReqInfo: { scope: [] },
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
      accountId: "github:12345",
    })
  );

  const req = new Request("https://mcp.example.com/configure?state=abc%22%3E%3Cscript%3E");
  const res = await defaultHandler.fetch(req, env);
  const body = await res.text();

  expect(body).toContain('value="abc&quot;&gt;&lt;script&gt;"');
  expect(body).not.toContain('value="abc"><script>');
});
```

- [ ] **Step 2: Run escaping tests**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: FAIL if configure hidden state is not escaped; settings escaping may already pass from Task 4.

- [ ] **Step 3: Escape configure state in GET form**

In `/configure` GET, change:

```ts
<input type="hidden" name="state" value="${stateId}">
```

to:

```ts
<input type="hidden" name="state" value="${escapeHtml(stateId)}">
```

- [ ] **Step 4: Run escaping tests to verify they pass**

Run:

```bash
npm test -- test/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit escaping coverage**

Run:

```bash
git add src/index.ts test/index.test.ts
git commit -m "test: cover auth html escaping"
```

## Task 6: Config and Documentation

**Files:**
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `wrangler.toml` vars and secret comments**

Add to `[vars]`:

```toml
GOOGLE_CLIENT_ID = "<your-google-client-id>"
```

Add to secret comments:

```toml
#   GOOGLE_CLIENT_SECRET  -- Google OAuth web client secret
```

- [ ] **Step 2: Update README remote auth summary**

In `README.md`, replace wording that says remote mode uses GitHub OAuth with wording like:

```md
- **Remote (Cloudflare Worker)** -- persistent public endpoint with GitHub or Google OAuth and per-user credentials
```

In the remote prerequisites list, include:

```md
- A [GitHub OAuth App](https://github.com/settings/developers) and/or a Google OAuth web client for authentication
```

- [ ] **Step 3: Add Google OAuth setup to README**

After the GitHub OAuth app section, add:

```md
### 4. Create a Google OAuth web client

1. In Google Cloud Console, create or select a project.
2. Configure the OAuth consent screen for your deployment.
3. Create an OAuth client ID with application type **Web application**.
4. Add `https://intervals-mcp.<your-subdomain>.workers.dev/callback` as an authorized redirect URI.
5. Note the **Client ID** and **Client Secret**.
```

Renumber the existing remote setup sections so they read: `### 5. Configure wrangler.toml`, `### 6. Set secrets`, `### 7. Deploy`, `### 8. Connect your MCP client`.

- [ ] **Step 4: Update README config and secrets**

Show both client IDs:

```toml
[vars]
GITHUB_CLIENT_ID = "<your-github-client-id>"
GOOGLE_CLIENT_ID = "<your-google-client-id>"
```

Show both secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Update connection text:

```md
Claude will show a browser login page where you can continue with GitHub or Google, then enter your intervals.icu athlete ID and API key.
```

Add a short note:

```md
GitHub and Google identities are separate accounts. Existing credentials from versions that only used GitHub usernames are not migrated; reconnect and re-enter intervals.icu credentials after upgrading.
```

- [ ] **Step 5: Update `AGENTS.md` auth architecture**

Replace GitHub-only overview language with:

```md
Access is controlled by GitHub or Google OAuth. Each provider identity maps to a separate account ID of the form `<provider>:<stable-subject>`. Users provide their own intervals.icu athlete ID and API key, collected during first-time OAuth via `/configure` and stored AES-256-GCM encrypted in OAUTH_KV.
```

Update key patterns:

```md
`oauth_state:<uuid>` (10min TTL, {oauthReqInfo, provider?}), `settings_state:<uuid>` (10min TTL, {flow, provider?}), `configure_state:<uuid>` (10min TTL, {oauthReqInfo, identity, accountId}), `credentials:<accountId>` (no TTL, {athleteId, encryptedApiKey, iv}), `settings_session:<uuid>` (1hr TTL, {accountId, identity}).
```

Update secrets/env vars sections to include:

```md
- `GOOGLE_CLIENT_SECRET` -- Google OAuth web client secret
- `GOOGLE_CLIENT_ID` -- Google OAuth web client ID (not a secret, safe to commit)
```

- [ ] **Step 6: Run targeted tests after docs/config changes**

Run:

```bash
npm test -- test/auth.test.ts test/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit config and docs**

Run:

```bash
git add wrangler.toml README.md AGENTS.md
git commit -m "docs: document google oauth setup"
```

## Task 7: Full Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS for all Vitest files.

- [ ] **Step 2: Run TypeScript compile check**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git status --short
```

Expected: no unintended changes. Pre-existing user edits that were not part of this implementation may still appear; do not revert them.

- [ ] **Step 4: Manual local Worker smoke test**

Run:

```bash
npm run dev
```

Open the local `/authorize` URL only through an MCP OAuth client when available. Without a full MCP auth request, `/authorize` should still return `400 Invalid OAuth request`. Use `/settings` for a simpler browser check: it should render GitHub and Google provider choices.

Expected: `/settings` provider choice page renders; selecting a provider redirects to that provider OAuth endpoint with `/callback` as redirect URI.

- [ ] **Step 5: Final implementation commit if uncommitted verification fixes were needed**

If verification required any code or doc changes, commit them:

```bash
git add <changed-files>
git commit -m "fix: complete google oauth verification"
```

If no files changed during verification, do not create an empty commit.
