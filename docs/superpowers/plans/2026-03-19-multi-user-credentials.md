# Multi-User Credentials Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded single-user intervals.icu credentials with per-user credentials collected during OAuth and manageable via a `/settings` page.

**Architecture:** Each whitelisted GitHub user provides their own intervals.icu athlete ID and API key, collected in a form during first-time MCP authorization and stored AES-256-GCM encrypted in the existing `OAUTH_KV` namespace. A separate `/settings` browser flow (its own GitHub OAuth mini-loop) lets users update credentials without re-authorizing their MCP client. The `apiHandler` reads per-user credentials from KV on each MCP request using the username from `ctx.props`.

**Tech Stack:** TypeScript, Cloudflare Workers, `crypto.subtle` (HKDF + AES-GCM, built-in), `@cloudflare/workers-oauth-provider@0.3.0`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-multi-user-credentials-design.md`

---

## Chunk 1: Crypto Utilities

### File Map
- Create: `src/crypto.ts`
- Create: `test/crypto.test.ts`

---

### Task 1: `src/crypto.ts` — hex conversion and key derivation

**Files:**
- Create: `src/crypto.ts`
- Create: `test/crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hexToBytes, encryptApiKey, decryptApiKey } from "../src/crypto";

const MASTER_KEY = "a".repeat(64); // 64 hex chars = valid

describe("hexToBytes", () => {
  it("converts 64-char hex string to 32-byte Uint8Array", () => {
    const bytes = hexToBytes("00".repeat(32));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(0);
  });

  it("throws on wrong length", () => {
    expect(() => hexToBytes("aabb")).toThrow("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  });

  it("throws on non-hex characters", () => {
    expect(() => hexToBytes("z".repeat(64))).toThrow("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  });
});

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips an API key for a given username", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    expect(typeof encryptedApiKey).toBe("string");
    expect(typeof iv).toBe("string");

    const decrypted = await decryptApiKey(encryptedApiKey, iv, "alice", MASTER_KEY);
    expect(decrypted).toBe("my-api-key");
  });

  it("fails to decrypt with a different username", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    await expect(decryptApiKey(encryptedApiKey, iv, "bob", MASTER_KEY)).rejects.toThrow();
  });

  it("produces different ciphertext on each call (random IV)", async () => {
    const r1 = await encryptApiKey("key", "alice", MASTER_KEY);
    const r2 = await encryptApiKey("key", "alice", MASTER_KEY);
    expect(r1.iv).not.toBe(r2.iv);
    expect(r1.encryptedApiKey).not.toBe(r2.encryptedApiKey);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/crypto.test.ts
```
Expected: FAIL — `Cannot find module '../src/crypto'`

- [ ] **Step 3: Implement `src/crypto.ts`**

```ts
// src/crypto.ts

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

async function deriveUserKey(username: string, masterKeyHex: string): Promise<CryptoKey> {
  const rawMaster = hexToBytes(masterKeyHex);
  const masterKey = await crypto.subtle.importKey("raw", rawMaster, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(username),
    },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptApiKey(
  apiKey: string,
  username: string,
  masterKeyHex: string
): Promise<{ encryptedApiKey: string; iv: string }> {
  const userKey = await deriveUserKey(username, masterKeyHex);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    userKey,
    new TextEncoder().encode(apiKey)
  );
  return {
    encryptedApiKey: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...ivBytes)),
  };
}

export async function decryptApiKey(
  encryptedApiKey: string,
  iv: string,
  username: string,
  masterKeyHex: string
): Promise<string> {
  const userKey = await deriveUserKey(username, masterKeyHex);
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encryptedApiKey), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    userKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- test/crypto.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/crypto.ts test/crypto.test.ts
git commit -m "feat: add HKDF+AES-GCM crypto utilities for per-user credential encryption"
```

---

## Chunk 2: Auth Helpers

### File Map
- Modify: `src/auth.ts` (add `validateIntervalsCredentials`, `settingsCallbackUrl`)
- Modify: `test/auth.test.ts` (add tests for new helpers)

---

### Task 2: `validateIntervalsCredentials` and `settingsCallbackUrl`

**Files:**
- Modify: `src/auth.ts`
- Modify: `test/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/auth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isAllowedUser,
  buildGitHubAuthUrl,
  validateIntervalsCredentials,
  settingsCallbackUrl,
} from "../src/auth";

// ... existing tests unchanged ...

describe("validateIntervalsCredentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when intervals.icu responds 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await validateIntervalsCredentials("i12345", "mykey");
    expect(result).toBe(true);
    // verify auth header format
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://intervals.icu/api/v1/athlete/i12345");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Basic " + btoa("API_KEY:mykey"),
    });
  });

  it("returns false when intervals.icu responds non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await validateIntervalsCredentials("i12345", "badkey");
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await validateIntervalsCredentials("i12345", "mykey");
    expect(result).toBe(false);
  });
});

describe("settingsCallbackUrl", () => {
  it("returns origin + /settings/callback", () => {
    const req = new Request("https://mcp.example.com/settings");
    expect(settingsCallbackUrl(req)).toBe("https://mcp.example.com/settings/callback");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/auth.test.ts
```
Expected: FAIL — `validateIntervalsCredentials is not exported`

- [ ] **Step 3: Add helpers to `src/auth.ts`**

Append to `src/auth.ts`:

```ts
export async function validateIntervalsCredentials(
  athleteId: string,
  apiKey: string
): Promise<boolean> {
  try {
    const res = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}`, {
      headers: {
        Authorization: "Basic " + btoa(`API_KEY:${apiKey}`),
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function settingsCallbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/settings/callback`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- test/auth.test.ts
```
Expected: PASS (all tests including existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: add validateIntervalsCredentials and settingsCallbackUrl helpers"
```

---

## Chunk 3: /callback Update + /configure Routes

### File Map
- Modify: `src/index.ts` — `Env` type, `/callback` credentials check + configure redirect, new `/configure` GET+POST routes
- Modify: `test/index.test.ts` — tests for new callback behaviour and configure routes

---

### Task 3: Update `Env` and `/callback` to check for existing credentials

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("defaultHandler /callback")` block in `test/index.test.ts`:

```ts
it("redirects to /configure when user has no credentials", async () => {
  const env = makeEnv();
  // KV: first call returns oauth_state (oauthReqInfo), second call returns null (no credentials)
  env.OAUTH_KV.get
    .mockResolvedValueOnce(JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: [], state: "s" }))
    .mockResolvedValueOnce(null); // credentials:<username> not found

  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
    .mockResolvedValueOnce({ json: () => Promise.resolve({ login: "testuser" }) })
  );

  const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("/configure?state=");
  // oauth_state deleted, configure_state written
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("oauth_state:validstate");
  expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
    expect.stringMatching(/^configure_state:/),
    expect.stringContaining("testuser"),
    expect.objectContaining({ expirationTtl: 600 })
  );
});

it("calls completeAuthorization directly when credentials already exist", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce(JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: [], state: "s" }))
    .mockResolvedValueOnce(JSON.stringify({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" }));
  env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({ redirectTo: "https://claude.ai/cb" });

  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
    .mockResolvedValueOnce({ json: () => Promise.resolve({ login: "testuser" }) })
  );

  const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("claude.ai");
  expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/index.test.ts
```
Expected: FAIL — new tests fail, existing tests still pass

- [ ] **Step 3: Update `Env` type and `/callback` in `src/index.ts`**

Update the `Env` interface:

```ts
export interface Env {
  CREDENTIALS_MASTER_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ALLOWED_USERS: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}
```

(Remove `API_KEY` and `ATHLETE_ID` — they are no longer used by the Worker.)

Update the `/callback` handler block (replace existing completeAuthorization call with credentials check):

```ts
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- test/index.test.ts
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: check for existing credentials in /callback, redirect new users to /configure"
```

---

### Task 4: Add `/configure` GET and POST routes

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/index.test.ts`:

```ts
describe("defaultHandler /configure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET returns 400 when state not found in KV", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/configure?state=badstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("GET returns 200 with HTML form when state is valid", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ oauthReqInfo: { scope: [] }, username: "testuser" })
    );
    const req = new Request("https://mcp.example.com/configure?state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("athleteId");
    expect(body).toContain("apiKey");
  });

  it("POST returns 400 when configure_state missing or expired", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/configure", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "key", state: "badstate" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("POST redirects back to /configure with new state on invalid credentials", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ oauthReqInfo: { scope: [] }, username: "testuser" })
    );
    // intervals.icu returns 401
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const req = new Request("https://mcp.example.com/configure", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "badkey", state: "validstate" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/\/configure\?state=.+&error=invalid_credentials/);
    // old state deleted, new state written
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("configure_state:validstate");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^configure_state:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("POST completes authorization on valid credentials", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    const oauthReqInfo = { scope: ["mcp"] };
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ oauthReqInfo, username: "testuser" })
    );
    env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({
      redirectTo: "https://claude.ai/callback?code=done",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const req = new Request("https://mcp.example.com/configure", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "goodkey", state: "validstate" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("claude.ai");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "credentials:testuser",
      expect.stringContaining("athleteId")
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/index.test.ts
```
Expected: FAIL — `/configure` routes not yet implemented

- [ ] **Step 3: Add `/configure` routes to `defaultHandler` in `src/index.ts`**

Add these imports at the top of `src/index.ts`:

```ts
import { encryptApiKey } from "./crypto.js";
import { validateIntervalsCredentials } from "./auth.js";
```

Add inside `defaultHandler.fetch`, before the final `return new Response(...)`:

```ts
if (url.pathname === "/configure") {
  const stateId = url.searchParams.get("state");
  if (!stateId) return new Response("Missing state", { status: 400 });

  if (request.method === "GET") {
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- test/index.test.ts
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add /configure GET+POST routes for first-time credential collection"
```

---

## Chunk 4: /settings Routes

### File Map
- Modify: `src/index.ts` — add `/settings`, `/settings/callback`, `/settings/save` routes
- Modify: `test/index.test.ts` — tests for settings routes

---

### Task 5: Add `/settings` browser auth flow

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/index.test.ts`:

```ts
describe("defaultHandler /settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET /settings with no cookie redirects to GitHub", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/settings");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("github.com/login/oauth/authorize");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_state:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("GET /settings/callback returns 400 on invalid state", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/settings/callback?code=x&state=bad");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("GET /settings/callback sets session cookie and redirects to /settings", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({ placeholder: true })); // settings_state exists
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ login: "testuser" }) })
    );

    const req = new Request("https://mcp.example.com/settings/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://mcp.example.com/settings");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("settings_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("GET /settings with valid session shows form", async () => {
    const env = makeEnv();
    // KV "json" mode returns parsed objects — mock accordingly
    env.OAUTH_KV.get
      .mockResolvedValueOnce({ username: "testuser" }) // settings_session:<token>
      .mockResolvedValueOnce({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" }); // credentials:<username>

    const req = new Request("https://mcp.example.com/settings", {
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("i123");
    expect(body).toContain("••••••••");
  });

  it("POST /settings/save returns 401 with no session", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null); // no session found
    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "key" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("POST /settings/save updates credentials on valid input", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    // KV "json" mode returns parsed object
    env.OAUTH_KV.get.mockResolvedValue({ username: "testuser" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i999", apiKey: "newkey" }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "settings_session=mytoken",
      },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "credentials:testuser",
      expect.stringContaining("i999")
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/index.test.ts
```
Expected: FAIL — `/settings` routes not yet implemented

- [ ] **Step 3: Add `/settings` routes to `defaultHandler` in `src/index.ts`**

Add a helper inside `defaultHandler.fetch` (before the route handlers):

```ts
function getSessionToken(req: Request): string | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(/settings_session=([^;]+)/);
  return match ? match[1] : null;
}
```

Add after the `/configure` block:

```ts
if (url.pathname === "/settings") {
  const sessionToken = getSessionToken(request);

  if (!sessionToken) {
    // No session — start GitHub OAuth for settings
    const stateId = crypto.randomUUID();
    await env.OAUTH_KV.put(`settings_state:${stateId}`, JSON.stringify({ placeholder: true }), {
      expirationTtl: 600,
    });
    return Response.redirect(
      buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, settingsCallbackUrl(request)),
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
    </body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    }
  );
}

if (url.pathname === "/settings/callback") {
  const code = url.searchParams.get("code");
  const stateId = url.searchParams.get("state");

  if (!code || !stateId) return new Response("Missing code or state", { status: 400 });

  const stateEntry = await env.OAUTH_KV.get(`settings_state:${stateId}`);
  if (!stateEntry) return new Response("Invalid or expired state", { status: 400 });
  await env.OAUTH_KV.delete(`settings_state:${stateId}`);

  let username: string;
  try {
    const githubToken = await exchangeGitHubCode(
      code,
      env.GITHUB_CLIENT_ID,
      env.GITHUB_CLIENT_SECRET,
      settingsCallbackUrl(request)
    );
    username = await getGitHubUsername(githubToken);
  } catch {
    return new Response("GitHub auth failed", { status: 502 });
  }

  if (!isAllowedUser(username, env.GITHUB_ALLOWED_USERS)) {
    return new Response("Forbidden: user not allowed", { status: 403 });
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
```

Also add `settingsCallbackUrl` to the imports from `./auth.js`.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- test/index.test.ts
```
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add /settings browser flow for credential management"
```

---

## Chunk 5: `apiHandler` Update + Docs

### File Map
- Modify: `src/index.ts` — update `apiHandler` to read per-user credentials from KV via `ctx.props`
- Modify: `test/index.test.ts` — tests for updated apiHandler
- Modify: `wrangler.toml` — document new `CREDENTIALS_MASTER_KEY` secret
- Modify: `AGENTS.md` — update architecture description

---

### Task 6: Update `apiHandler` to use per-user credentials

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Verify how `ctx.props` is surfaced**

Before writing tests, confirm the exact API by checking the installed library:

```bash
cat node_modules/@cloudflare/workers-oauth-provider/dist/index.d.ts | grep -A5 "apiHandler\|props"
```

The library passes `props` as `ctx.props` to the `apiHandler`. If the output shows a different pattern (e.g. a method on `env.OAUTH_PROVIDER`), adjust the implementation accordingly.

- [ ] **Step 2: Write failing tests**

Add a new `describe` block to `test/index.test.ts`:

```ts
describe("apiHandler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 401 when credentials not found in KV", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    env.OAUTH_KV.get.mockResolvedValue(null);
    const ctx = { props: { username: "testuser" } };

    const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
    const res = await apiHandler.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("/settings");
  });

  it("creates IntervalsClient with decrypted credentials", async () => {
    const { encryptApiKey: enc } = await import("../src/crypto");
    const masterKey = "a".repeat(64);
    const { encryptedApiKey, iv } = await enc("real-api-key", "testuser", masterKey);

    const env = makeEnv({ CREDENTIALS_MASTER_KEY: masterKey });
    // KV "json" mode returns parsed object — mock accordingly
    env.OAUTH_KV.get.mockResolvedValue({ athleteId: "i123", encryptedApiKey, iv });
    const ctx = { props: { username: "testuser" } };

    // The McpServer/transport will fail (not a real MCP request), but we just need
    // to confirm it gets past credential loading without throwing
    const req = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    // Should not return 401
    const res = await apiHandler.fetch(req, env, ctx);
    expect(res.status).not.toBe(401);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm test -- test/index.test.ts
```
Expected: FAIL — `apiHandler` still uses `env.API_KEY`

- [ ] **Step 4: Update `apiHandler` in `src/index.ts`**

Add `decryptApiKey` to the crypto import. Replace the `apiHandler` body:

```ts
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
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: update apiHandler to decrypt per-user credentials from KV"
```

---

### Task 7: Update docs and config

**Files:**
- Modify: `wrangler.toml`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update `wrangler.toml`**

Replace the secrets comment block:

```toml
# Secrets set via `npx wrangler secret put <NAME>`:
#   CREDENTIALS_MASTER_KEY  -- 32-byte hex key for AES-256-GCM encryption (generate: openssl rand -hex 32)
#   GITHUB_CLIENT_SECRET    -- GitHub OAuth app client secret
#   GITHUB_ALLOWED_USERS    -- comma-separated list of allowed GitHub usernames (e.g. "alice,bob")
#
# Removed (per-user credentials now stored in OAUTH_KV):
#   API_KEY
#   ATHLETE_ID
```

- [ ] **Step 2: Update `AGENTS.md`**

Update the Project overview sentence:

```
Access is controlled via GitHub OAuth — only whitelisted GitHub users can authenticate.
Each user provides their own intervals.icu athlete ID and API key, stored AES-256-GCM
encrypted in OAUTH_KV. Credentials are collected during first-time OAuth and manageable
via the /settings page.
```

Update the Secrets section to match new secrets. Update the Key patterns section to document the new KV key patterns.

- [ ] **Step 3: Run tests one final time**

```bash
npm test
```
Expected: PASS (all tests)

- [ ] **Step 4: Final commit**

```bash
git add wrangler.toml AGENTS.md
git commit -m "docs: update AGENTS.md and wrangler.toml for multi-user credential architecture"
```

---

## Post-Implementation: GitHub OAuth App Config

**Before deploying**, add `/settings/callback` as a permitted redirect URI in the GitHub OAuth app:

1. Go to GitHub → Settings → Developer settings → OAuth Apps → your app
2. Add `https://<your-worker-domain>/settings/callback` to "Authorization callback URL"
3. Save

## Post-Implementation: Operator Migration

After deploying:

1. Visit `https://<your-worker-domain>/settings` in a browser
2. Sign in with GitHub (must be on the whitelist)
3. Enter your intervals.icu athlete ID and API key
4. Once saved, remove the old CF secrets:
   ```bash
   npx wrangler secret delete API_KEY
   npx wrangler secret delete ATHLETE_ID
   ```
5. Set the new secret:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put CREDENTIALS_MASTER_KEY
   ```
