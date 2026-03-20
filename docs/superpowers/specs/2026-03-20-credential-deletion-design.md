# Credential Deletion & Account Disconnect

**Date:** 2026-03-20
**Status:** Approved
**Scope:** `src/index.ts` only — no new files, no new dependencies

---

## Problem

Users have no way to remove their stored intervals.icu credentials or disconnect MCP clients (e.g. Claude Desktop). Deleting credentials without revoking OAuth grants would leave active tokens that hit `apiHandler`, receive a confusing 401, and require the user to debug why their MCP client stopped working.

## Out of scope

- Rate limiting (deferred — no active problem at current scale)
- Email/notification on disconnect
- Admin tooling to delete other users' credentials

---

## Design

### Settings page UI (`GET /settings`)

The handler already fetches `credentials:<username>` before rendering. Use that to conditionally render a "Danger zone" section when credentials exist:

```
[ Athlete ID field        ]
[ API Key field           ]
[ Save button             ]

────────────────────────────
Danger zone

[ Disconnect account ]
```

The "Disconnect account" button lives inside its own `<form method="POST" action="/settings/disconnect">`. It has an `onclick="return confirm('...')"` guard before submission. No JS framework — native browser confirm dialog.

Confirm dialog text:
> "This will remove your intervals.icu credentials and disconnect all MCP clients (e.g. Claude Desktop). You'll need to re-authorise from scratch. Continue?"

The danger zone section is only rendered when `creds !== null`. If credentials are absent (edge case), only the update form is shown.

---

### New route: `POST /settings/disconnect`

**Auth:** same `settings_session` cookie guard as `/settings/save`.

**Handler sequence:**

1. Read and validate `settings_session` cookie → resolve `username`
2. Paginate `env.OAUTH_PROVIDER.listUserGrants(username)` until `result.cursor` is undefined, accumulating all grant IDs
3. Call `env.OAUTH_PROVIDER.revokeGrant(grant.id, username)` for each grant via `Promise.allSettled` — best-effort; a single revocation failure does not block the remaining steps
4. Delete `credentials:<username>` from `OAUTH_KV`
5. Delete `settings_session:<sessionToken>` from `OAUTH_KV`
6. Respond with `302` to `/settings/disconnected`, clearing the session cookie with: `Set-Cookie: settings_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/settings`

**Error handling:** if the session is missing or expired, return `401`. If `listUserGrants` returns an empty list (no active grants), skip step 3 and continue — credentials are still deleted.

**CSRF posture:** relies on `SameSite=Lax` cookie attribute, consistent with `/settings/save`. Cross-site POSTs from third-party origins are blocked by the browser. Deliberate decision appropriate for this application tier.

---

### New route: `GET /settings/disconnected`

Static pure-HTML confirmation page. No session required. Content:

- Confirmation that credentials have been removed
- Note that all MCP clients have been disconnected
- Link to `/settings` to reconnect (which will trigger the GitHub OAuth → `/configure` flow for a fresh setup)

---

### What happens to connected MCP clients

Revoking a grant invalidates the associated access and refresh tokens at the OAuth provider level. The next request from any MCP client using a revoked token receives a `401` from `OAuthProvider` before reaching `apiHandler`. The MCP client (e.g. Claude Desktop) will prompt the user to re-authorise, which restarts the full OAuth → `/configure` flow.

---

## KV operations summary

| Step | Operation |
|---|---|
| Revoke grants | `OAUTH_PROVIDER.listUserGrants(username)` + `revokeGrant()` per grant |
| Delete credentials | `OAUTH_KV.delete("credentials:" + username)` |
| Invalidate session | `OAUTH_KV.delete("settings_session:" + sessionToken)` |

---

## Routes added

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/settings/disconnect` | `settings_session` cookie | Revoke grants, delete credentials, end session |
| `GET` | `/settings/disconnected` | None | Static confirmation page |

---

## What is not changed

- `/settings/save` — unchanged
- `/settings` GET — additive only (danger zone section appended)
- `apiHandler` — unchanged
- All existing KV key patterns — unchanged
- No new dependencies

---

## Testing

- Unit test: `POST /settings/disconnect` with valid session → grants revoked, credentials deleted, session deleted, 302 to `/settings/disconnected`
- Unit test: `POST /settings/disconnect` with missing/expired session → 401
- Unit test: `POST /settings/disconnect` with no active grants → credentials still deleted (graceful)
- Unit test: `POST /settings/disconnect` with two pages of grants → all grants across both pages are revoked
- Unit test: `POST /settings/disconnect` where one `revokeGrant` call fails → remaining grants still revoked, credentials and session still deleted
- Unit test: `GET /settings` with credentials present → response includes disconnect form
- Unit test: `GET /settings` with no credentials → response does not include disconnect form
- Unit test: `GET /settings/disconnected` → 200, pure HTML
