# Google Login for Remote MCP Auth

## Goal

Add Google login to the remote Cloudflare Worker MCP server while keeping GitHub login available. The user experience should be a normal provider choice screen where users can continue with either GitHub or Google before entering their intervals.icu credentials.

This design intentionally does not migrate existing credential records. Current users will re-authenticate and re-enter their intervals.icu credentials after deployment.

## Current State

The Worker uses `@cloudflare/workers-oauth-provider` for the MCP OAuth server. The app-specific login layer is implemented in `src/index.ts` and `src/auth.ts`:

- `/authorize` parses the MCP authorization request, stores it in KV, and immediately redirects to GitHub.
- `/callback` exchanges a GitHub authorization code, reads the GitHub username, and either completes MCP authorization or sends first-time users to `/configure`.
- `/configure` collects intervals.icu athlete ID and API key, validates them, encrypts the API key, stores credentials in KV, and completes MCP authorization.
- `/settings` starts a GitHub OAuth loop to identify the user before allowing credential updates or disconnect.
- `apiHandler` receives the authenticated MCP token props from `OAuthProvider`, reads the matching credentials from KV, decrypts the intervals.icu API key, and serves MCP tools.

Credentials are currently keyed by GitHub username, such as `credentials:<username>`. The encryption key derivation also uses that username as context.

## Account Model

Use provider-scoped account identifiers:

```text
<provider>:<stable-subject>
```

Examples:

```text
github:12345678
google:108765432109876543210
```

This is the canonical identity used for:

- `OAuthProvider.completeAuthorization({ userId })`
- OAuth token props
- credentials KV keys
- settings sessions
- grant revocation
- per-user API key encryption context

Do not use email as an account key. Email can change, can be hidden, can be unverified, and is not globally unique across providers. Do not automatically link GitHub and Google accounts by email. Account linking can be added later as an explicit authenticated flow if needed.

Existing records such as `credentials:<github_login>` are not migrated. They will be ignored by the new code. Existing old OAuth grants may remain in KV until expiry or manual deletion, but they will not resolve credentials under the new account model.

## Identity Provider Abstraction

Replace GitHub-only helpers in `src/auth.ts` with a small provider abstraction.

```ts
export type AuthProvider = "github" | "google";

export interface AuthIdentity {
  provider: AuthProvider;
  subject: string;
  displayName: string;
  email?: string;
  emailVerified?: boolean;
}

export function accountId(identity: AuthIdentity): string {
  return `${identity.provider}:${identity.subject}`;
}
```

Each provider implementation must support:

- building an authorization URL
- exchanging an authorization code for an access token
- fetching or deriving an `AuthIdentity`

GitHub identity should use the stable numeric `id` from `https://api.github.com/user` as `subject`. The `login` field is only `displayName`.

Google identity should use OpenID Connect scopes:

```text
openid email profile
```

The implementation should exchange the code with Google and call the OIDC userinfo endpoint with the access token. It should use `sub` as `subject`. Email may be shown in the UI only when `email_verified` is true. Email must never be used as the credential key.

## Provider Choice Flow

Introduce a provider selection step for both MCP authorization and settings login.

For `/authorize`:

1. Parse the MCP OAuth request with `env.OAUTH_PROVIDER.parseAuthRequest(request)`.
2. Store the parsed request in `oauth_state:<stateId>` with a short TTL.
3. Render a login choice page at `/authorize` with buttons:
   - Continue with GitHub
   - Continue with Google
4. Buttons submit to a route such as `/login?flow=oauth&state=<stateId>&provider=<provider>`.
5. `/login` validates the state exists, stores the selected provider in the server-side state record, and redirects to the chosen provider authorization URL.

For `/settings`:

1. If there is no valid settings session, create `settings_state:<stateId>`.
2. Render the same provider choice page for the settings flow.
3. `/login?flow=settings&state=<stateId>&provider=<provider>` stores the provider in the settings state and redirects to the chosen provider authorization URL.

Provider selection must be trusted only after validating the server-side state. `/callback` must read the selected provider from KV state, not from callback query parameters.

## Callback Flow

`/callback` remains shared by both providers and both flows.

1. Read `code` and `state`.
2. Check `oauth_state:<state>` first.
3. If not found, check `settings_state:<state>`.
4. The matching state record must include the selected provider.
5. Exchange the code with that provider.
6. Resolve `AuthIdentity`.
7. Compute canonical `accountId`.

For the MCP authorization flow:

- Look up `credentials:<accountId>`.
- If credentials exist, call `completeAuthorization` immediately with:
  - `userId: accountId`
  - `metadata: { provider, subject, displayName, email }`
  - `props: { accountId, provider, subject, displayName, email }`
- If credentials do not exist, store `{ oauthReqInfo, identity }` in `configure_state:<stateId>` and redirect to `/configure`.

For the settings flow:

- Create a `settings_session:<sessionToken>` record containing the canonical identity fields.
- Set the existing `settings_session` cookie.
- Redirect to `/settings`.

## Configure and Settings

`/configure` should store credentials under:

```text
credentials:<accountId>
```

The intervals.icu API key should be encrypted using the same canonical `accountId` as the per-user encryption context.

`/settings` should display the signed-in identity using escaped HTML:

- GitHub: `Signed in with GitHub as <displayName>`
- Google: `Signed in with Google as <verified email or displayName>`

All user-controlled fields must be HTML-escaped before rendering, including display name, email, and stored athlete ID.

`/settings/save` should read the account id from the settings session and update `credentials:<accountId>`.

`/settings/disconnect` should:

1. Read the account id from the settings session.
2. Revoke grants using the same account id passed to `completeAuthorization`.
3. Delete `credentials:<accountId>`.
4. Delete the settings session.

## Configuration

Add environment variables:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

Keep existing GitHub variables:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

The Google OAuth client must be a web application with this authorized redirect URI:

```text
https://<worker-host>/callback
```

`wrangler.toml` should include `GOOGLE_CLIENT_ID` in `[vars]`. `GOOGLE_CLIENT_SECRET` should be set with `wrangler secret put`.

## Security Notes

- Do not auto-link providers by email.
- Do not use GitHub `login` as the canonical subject because it is mutable.
- Do not trust provider choice from callback query parameters.
- Keep OAuth state TTL short.
- Escape all identity and credential fields rendered into HTML.
- Prefer Google userinfo for the initial implementation to avoid local ID-token signature/JWKS validation complexity. If ID tokens are used later, validate issuer, audience, expiry, signature, and nonce.

## Tests

Add or update tests for:

- GitHub auth URL still uses GitHub and requests the expected scope.
- Google auth URL uses Google and requests `openid email profile`.
- GitHub identity returns numeric `id` as subject and `login` as display name.
- Google identity returns `sub` as subject and handles verified email display.
- `/authorize` renders provider choices and stores the MCP auth request in KV.
- `/login` rejects invalid provider and expired state.
- `/login` stores provider in state and redirects to the selected provider.
- `/callback` reads provider from server-side state and does not trust callback query provider values.
- First-time GitHub or Google users are redirected to `/configure`.
- Returning GitHub or Google users complete MCP authorization with canonical `userId`.
- `/configure` stores `credentials:<accountId>` and encrypts with `accountId`.
- `/settings` starts provider choice when no valid session exists.
- `/settings/save` updates provider-scoped credentials.
- `/settings/disconnect` revokes grants and deletes provider-scoped credentials.
- `apiHandler` reads credentials using `ctx.props.accountId`.
- Rendered settings/configure HTML escapes display name, email, and athlete ID.

## Documentation Updates

Update `README.md` and `AGENTS.md` to describe:

- Remote auth supports GitHub or Google.
- Users are separate per provider.
- Existing pre-Google credentials are not migrated.
- GitHub setup instructions.
- Google OAuth client setup instructions.
- New `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` configuration.

## Out of Scope

- Automatic account linking by email.
- Manual account linking between providers.
- Migrating existing `credentials:<github_login>` records.
- Changing local stdio mode.
