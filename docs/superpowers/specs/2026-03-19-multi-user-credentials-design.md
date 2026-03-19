# Multi-User Credentials Design

**Date:** 2026-03-19
**Status:** Approved

## Overview

Replace the single hardcoded `API_KEY` / `ATHLETE_ID` CF secrets with per-user intervals.icu credentials. Users authenticate via GitHub OAuth (whitelist unchanged), then provide their own athlete ID and API key. Credentials are stored encrypted in KV.

## Goals

- Each whitelisted GitHub user supplies their own intervals.icu athlete ID and API key
- Credentials are collected during the MCP OAuth flow (first-time) and updatable via a `/settings` browser page
- API keys are stored encrypted at rest using native Web Crypto (HKDF + AES-GCM)
- No new KV namespace required; no third-party crypto packages

## Non-Goals

- Open registration (GitHub whitelist `GITHUB_ALLOWED_USERS` stays unchanged)
- Per-user rate limiting or billing
- Credential sharing between users

---

## Architecture

### Storage

Reuse existing `OAUTH_KV` namespace with new key patterns:

```
credentials:<github_username>    →  { athleteId: string, encryptedApiKey: string, iv: string }
configure_state:<stateId>        →  { oauthReqInfo, username } (10-min TTL)
settings_state:<stateId>         →  { username } (10-min TTL, for /settings OAuth loop)
settings_session:<token>         →  { username } (1-hour TTL, browser session)
```

- `athleteId` stored plaintext (not secret — visible in intervals.icu URLs)
- `encryptedApiKey` is AES-GCM ciphertext, base64-encoded
- `iv` is the AES-GCM initialisation vector, base64-encoded
- `configure_state` stores **both** `oauthReqInfo` and `username` so `POST /configure` has access to both

### Encryption

One new CF secret: `CREDENTIALS_MASTER_KEY` (64 hex characters = 32 raw bytes, generated with `openssl rand -hex 32`).

**Key derivation using `crypto.subtle` (HKDF-SHA-256):**

```ts
function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('CREDENTIALS_MASTER_KEY must be 64 hex characters')
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
}

const rawMasterKey = hexToBytes(CREDENTIALS_MASTER_KEY)
const masterKey    = await crypto.subtle.importKey('raw', rawMasterKey, 'HKDF', false, ['deriveKey'])
const userKey      = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(github_username) },
  masterKey,
  { name: 'AES-GCM', length: 256 },
  false, ['encrypt', 'decrypt']
)
```

Notes:
- `salt` is an empty buffer (the master key itself carries all the entropy — HKDF with an empty salt is safe per RFC 5869 §3.1)
- `info` is the UTF-8 encoding of the GitHub username — binds the derived key to a specific user; a KV dump cannot be cross-decrypted between users
- `hexToBytes` validates the exact 64-hex-character format before use; a misconfigured secret throws immediately with a clear message

**Per-API-key encryption (AES-256-GCM):**

```ts
const iv         = crypto.getRandomValues(new Uint8Array(12))
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, userKey, new TextEncoder().encode(apiKey))
// store: { athleteId, encryptedApiKey: base64(ciphertext), iv: base64(iv) }
```

Decryption reverses the process. Both `encryptApiKey` and `decryptApiKey` live in `src/crypto.ts`.

### intervals.icu Auth Header Convention

The intervals.icu API uses HTTP Basic auth with the literal string `API_KEY` as the username and the actual key as the password:

```
Authorization: "Basic " + btoa("API_KEY:" + apiKey)
```

This matches the existing `IntervalsClient` constructor. All credential validation calls must use this exact format.

### Env Changes

Add to `Env`:
```ts
CREDENTIALS_MASTER_KEY: string  // new CF secret
```

Remove after the operator has set up their own credentials via the new flow:
```ts
API_KEY: string      // was single-user CF secret
ATHLETE_ID: string   // was single-user CF secret
```

**Migration:** The operator visits `/settings` after deployment, enters their intervals.icu credentials to populate KV, then removes `API_KEY` and `ATHLETE_ID` from CF secrets and redeploys.

---

## Flows

### First-Time MCP Authorization

1. User initiates MCP OAuth from their client (Claude, Cursor, etc.)
2. `/authorize` → stores `oauthReqInfo` as `oauth_state:<stateId>` in KV, redirects to GitHub
3. `/callback` → exchanges GitHub code, checks `isAllowedUser` whitelist; `username` is now known
4. KV lookup for `credentials:<username>`:
   - **Found** → call `completeAuthorization` (see call shape below) → redirect to MCP client
   - **Not found** → write `configure_state:<stateId>` = `{ oauthReqInfo, username }` to KV (10-min TTL); **delete `oauth_state:<stateId>`**; redirect to `/configure?state=<stateId>`

5. `GET /configure?state=<stateId>` → look up `configure_state:<stateId>` in KV; return 400 if missing or expired; serve HTML form (athlete ID + API key fields) with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`

6. `POST /configure` (body: `athleteId`, `apiKey`, `state=<stateId>`) →
   - Read `configure_state:<stateId>` from KV; return 400 if missing (expired or already used)
   - **Delete `configure_state:<stateId>`** before further processing (prevents replay)
   - Validate credentials: `GET https://intervals.icu/api/v1/athlete/<athleteId>` with `Authorization: Basic btoa("API_KEY:" + apiKey)`
   - **On validation failure** (non-200 or network error): write a fresh `configure_state:<newStateId>` = `{ oauthReqInfo, username }` (10-min TTL), redirect to `/configure?state=<newStateId>` — the browser lands back on the form with an error query param
   - **On validation success**: encrypt API key; store `credentials:<username>` in KV; call `completeAuthorization`; redirect to MCP client

**`completeAuthorization` call shape** (matches existing working code):
```ts
const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
  request: oauthReqInfo,
  userId: username,
  metadata: { username },
  scope: oauthReqInfo.scope,
  props: { username },
})
return Response.redirect(redirectTo, 302)
```

### Returning User MCP Authorization

Steps 1–4 as above, but credentials exist → `completeAuthorization` called immediately, user never sees the form.

### Settings Page (Update Credentials)

A separate GitHub OAuth loop for browser sessions only. **Prerequisite:** `/settings/callback` must be added as a permitted redirect URI in the GitHub OAuth app settings (in addition to the existing `/callback`).

1. `GET /settings` → no valid session cookie → generate `stateId`; store `settings_state:<stateId>` in KV (10-min TTL); redirect to GitHub OAuth using `buildGitHubAuthUrl(env.GITHUB_CLIENT_ID, stateId, settingsCallbackUrl(request))` where `settingsCallbackUrl` returns `<origin>/settings/callback`

2. `GET /settings/callback?code=<code>&state=<stateId>` →
   - Look up `settings_state:<stateId>` in KV; **return 400 if missing** (validates state parameter, prevents CSRF)
   - Delete `settings_state:<stateId>`
   - Exchange code (`exchangeGitHubCode` with `redirect_uri = settingsCallbackUrl(request)`)
   - `isAllowedUser` check (return 403 if not whitelisted)
   - Generate session token (random UUID); store `settings_session:<token>` = `{ username }` in KV (1-hour TTL)
   - Set `HttpOnly; Secure; SameSite=Lax` cookie with value = session token
   - Redirect to `/settings`

3. `GET /settings` → valid session cookie → read `settings_session:<token>` from KV (return 401 if missing/expired); serve HTML form pre-filled with current `athleteId` (API key shown as `••••••••`) with CSP header

4. `POST /settings/save` →
   - Read session cookie; look up `settings_session:<token>` from KV (return 401 if missing/expired)
   - Validate new credentials against intervals.icu (same as `/configure` POST)
   - If intervals.icu is temporarily unavailable (network error or 5xx): return error page with retry prompt; **do not skip validation**
   - On success: encrypt and overwrite `credentials:<username>` in KV; render success page

**CSRF:** `SameSite=Lax` on the session cookie is the CSRF mitigation for `POST /settings/save`. No additional synchronizer token is required.

### `apiHandler` (MCP Request)

The `@cloudflare/workers-oauth-provider` library surfaces the authenticated token's `props` via the execution context (`ctx`), not via `env.OAUTH_PROVIDER`. The expected pattern (verify against installed library types before implementing):

```ts
async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
  const props = ctx.props as { username: string }  // injected by OAuthProvider after token validation
  const creds = await env.OAUTH_KV.get(`credentials:${props.username}`, 'json') as StoredCredentials | null
  if (!creds) {
    return new Response('Configure your intervals.icu credentials at /settings', { status: 401 })
  }
  const apiKey = await decryptApiKey(creds.encryptedApiKey, creds.iv, props.username, env.CREDENTIALS_MASTER_KEY)
  const client = new IntervalsClient(apiKey, creds.athleteId)
  // ... rest of handler unchanged
}
```

If `ctx.props` is not the correct surface, check the `OAuthHelpers` interface in `@cloudflare/workers-oauth-provider` for how `props` are delivered to `apiHandler` — the library has an `unwrapToken` method that may be relevant.

---

## New Code Surface

| File | Change |
|------|--------|
| `src/crypto.ts` | New: `encryptApiKey`, `decryptApiKey`, `hexToBytes` using `crypto.subtle` (HKDF + AES-GCM) |
| `src/auth.ts` | Add: `validateIntervalsCredentials(athleteId, apiKey): Promise<boolean>` and `settingsCallbackUrl(request): string` helper |
| `src/index.ts` | Add: `/configure` GET+POST, `/settings` GET, `/settings/callback`, `/settings/save` routes; update `apiHandler`; update `Env` type |
| `wrangler.toml` | Add `CREDENTIALS_MASTER_KEY` to secrets list |
| GitHub OAuth app | Add `/settings/callback` as a permitted redirect URI (external config, done in GitHub app settings) |

No new npm dependencies. All crypto is `crypto.subtle` (Workers runtime built-in).

---

## Security Notes

- `CREDENTIALS_MASTER_KEY` is a CF secret — write-only, not visible in dashboard or logs
- Per-user HKDF-derived keys: decrypting one user's entry does not help decrypt another's
- Settings session tokens are short-lived (1 hour), KV-backed, revocable by deleting the KV entry
- GitHub whitelist check applies to both the MCP OAuth flow and the settings page
- `/configure` state is deleted before processing (replay prevention); validation failures issue a fresh state token via redirect
- Settings OAuth loop validates the `state` parameter via KV lookup before exchanging the GitHub code (CSRF prevention)
- HTML forms at `/configure` and `/settings` include `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`
