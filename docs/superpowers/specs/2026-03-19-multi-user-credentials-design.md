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

Reuse existing `OAUTH_KV` namespace with a new key pattern:

```
credentials:<github_username>  →  { athleteId: string, encryptedApiKey: string, iv: string }
```

- `athleteId` stored plaintext (not secret — visible in intervals.icu URLs)
- `encryptedApiKey` is AES-GCM ciphertext, base64-encoded
- `iv` is the AES-GCM initialisation vector, base64-encoded

### Encryption

One new CF secret: `CREDENTIALS_MASTER_KEY` (32-byte random hex string, set once at deploy).

Per-user encryption key derived with HKDF (native `crypto.subtle`):

```
user_key = HKDF-SHA-256(master_key, salt="intervals-creds", info=github_username)
encrypted = AES-256-GCM(user_key, raw_api_key, random_iv)
```

If the master key is ever compromised, all users are affected — but the master key lives in CF secrets (write-only, not visible in dashboard), so exposure requires full account compromise. Deriving per-user keys means a leaked derived key or KV dump cannot be used to decrypt other users' data.

### Env Changes

Add to `Env`:
```ts
CREDENTIALS_MASTER_KEY: string  // new CF secret
```

Remove (once all users migrated):
```ts
API_KEY: string      // was single-user secret
ATHLETE_ID: string   // was single-user secret
```

---

## Flows

### First-Time MCP Authorization

1. User initiates MCP OAuth from their client (Claude, Cursor, etc.)
2. `/authorize` → stores `oauthReqInfo` in KV, redirects to GitHub
3. `/callback` → exchanges GitHub code, checks `isAllowedUser` whitelist
4. KV lookup for `credentials:<username>`:
   - **Found** → `completeAuthorization({ userId: username, props: { username } })` → redirect to MCP client
   - **Not found** → store `stateId` reference, redirect to `GET /configure?state=<stateId>`
5. `/configure` GET → serve HTML form (athlete ID + API key fields)
6. `/configure` POST → validate credentials against intervals.icu API (`GET /api/v1/athlete/<id>`), encrypt API key, store in KV, call `completeAuthorization`, redirect to MCP client

The `stateId` is already in KV with a 10-minute TTL (existing `oauth_state:` key). `/configure` reads it, completes auth, then deletes it — no new state management needed.

### Returning User MCP Authorization

Same as above step 1–4, but credentials exist → `completeAuthorization` called immediately, user never sees the form.

### Settings Page (Update Credentials)

Separate lightweight GitHub OAuth loop for browser sessions only (not MCP tokens):

1. `GET /settings` → no session cookie → redirect to GitHub OAuth (`scope: read:user`, state stored as `settings_state:<stateId>` in KV with 10-min TTL)
2. `GET /settings/callback` → exchange code, `isAllowedUser` check, set short-lived session cookie (`settings_session:<token>` in KV, 1-hour TTL), redirect to `/settings`
3. `GET /settings` → valid session cookie → serve HTML form pre-filled with current `athleteId` (API key masked as `••••••••`)
4. `POST /settings/save` → read session cookie, validate new credentials against intervals.icu, encrypt API key, overwrite KV entry, return success page

Session cookie is `HttpOnly; Secure; SameSite=Lax`, value is a random UUID referencing the KV session entry.

### `apiHandler` (MCP Request)

```ts
const { props } = await env.OAUTH_PROVIDER.authenticateRequest(request)
const creds = await env.OAUTH_KV.get(`credentials:${props.username}`, 'json')
if (!creds) return new Response('Configure your intervals.icu credentials at /settings', { status: 401 })
const apiKey = await decryptApiKey(creds.encryptedApiKey, creds.iv, props.username, env.CREDENTIALS_MASTER_KEY)
const client = new IntervalsClient(apiKey, creds.athleteId)
```

---

## New Code Surface

| File | Change |
|------|--------|
| `src/crypto.ts` | New: `encryptApiKey`, `decryptApiKey` using `crypto.subtle` (HKDF + AES-GCM) |
| `src/auth.ts` | Add: `validateIntervalsCredentials(athleteId, apiKey)` — one GET to intervals.icu API |
| `src/index.ts` | Add: `/configure` GET+POST, `/settings` GET, `/settings/callback`, `/settings/save` routes; update `apiHandler` |

No new dependencies. All crypto is `crypto.subtle` (Workers runtime built-in).

---

## Security Notes

- `CREDENTIALS_MASTER_KEY` is a CF secret — write-only, not visible in dashboard or logs
- Per-user derived keys mean a KV dump exposes ciphertext only; decryption requires the master key
- Settings session tokens are short-lived (1 hour) and stored in KV — can be revoked by deleting the KV entry
- Whitelist check applies to both the MCP OAuth flow and the settings page
- `/configure` is only reachable with a valid `stateId` from an in-progress OAuth flow — not an open endpoint
