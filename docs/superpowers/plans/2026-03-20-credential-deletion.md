# Credential Deletion & Account Disconnect Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Disconnect account" flow to the `/settings` page that revokes all OAuth grants and deletes stored credentials.

**Architecture:** All changes are in `src/index.ts` (two new routes, one updated route) and `test/index.test.ts` (new test cases + expanded mock). The `@cloudflare/workers-oauth-provider` `OAuthHelpers` interface provides `listUserGrants` and `revokeGrant` — no new dependencies.

**Tech Stack:** TypeScript, Cloudflare Workers, `@cloudflare/workers-oauth-provider`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-credential-deletion-design.md`

---

## Chunk 1: Test infrastructure + settings page UI

### Task 1: Expand `makeEnv` mock to include grant management methods

**Files:**
- Modify: `test/index.test.ts:16-18` (the `OAUTH_PROVIDER` mock object)

The existing mock only has `parseAuthRequest`, `completeAuthorization`, `lookupClient`. The new routes call `listUserGrants` and `revokeGrant`. Add them now so all subsequent tests can use them.

- [ ] **Step 1: Add `listUserGrants` and `revokeGrant` to the `OAUTH_PROVIDER` mock in `makeEnv`**

```typescript
OAUTH_PROVIDER: {
  parseAuthRequest: vi.fn(),
  completeAuthorization: vi.fn(),
  lookupClient: vi.fn(),
  listUserGrants: vi.fn().mockResolvedValue({ items: [], cursor: undefined }),
  revokeGrant: vi.fn().mockResolvedValue(undefined),
},
```

- [ ] **Step 2: Run existing tests to confirm nothing broke**

```bash
npm test
```
Expected: all existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/index.test.ts
git commit -m "test: add listUserGrants and revokeGrant to OAUTH_PROVIDER mock"
```

---

### Task 2: Settings page shows disconnect form when credentials exist

**Files:**
- Modify: `test/index.test.ts` — add two tests to the existing `describe("defaultHandler /settings")` block
- Modify: `src/index.ts` — update the `GET /settings` response HTML

- [ ] **Step 1: Write the two failing tests**

Add inside `describe("defaultHandler /settings", ...)`:

```typescript
it("GET /settings with credentials shows disconnect form", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce({ username: "testuser" })
    .mockResolvedValueOnce({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" });

  const req = new Request("https://mcp.example.com/settings", {
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);
  const body = await res.text();

  expect(body).toContain("/settings/disconnect");
  expect(body).toContain("Disconnect account");
});

it("GET /settings without credentials does not show disconnect form", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get
    .mockResolvedValueOnce({ username: "testuser" })
    .mockResolvedValueOnce(null); // no credentials

  const req = new Request("https://mcp.example.com/settings", {
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);
  const body = await res.text();

  expect(body).not.toContain("/settings/disconnect");
});
```

- [ ] **Step 2: Run to confirm both tests fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A2 "disconnect"
```
Expected: both new tests FAIL.

- [ ] **Step 3: Update the `GET /settings` HTML in `src/index.ts`**

Find the `return new Response(...)` block inside the `if (url.pathname === "/settings")` branch. After the closing `</form>` tag and before `</body>`, add the conditional danger zone. Replace the existing response with:

```typescript
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
      // script-src 'unsafe-inline' required for the onclick confirm dialog
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  }
);
```

- [ ] **Step 4: Run tests to confirm both new tests pass**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: show disconnect form on settings page when credentials exist"
```

---

## Chunk 2: POST /settings/disconnect handler

### Task 3: Disconnect handler — unhappy paths (auth failures)

**Files:**
- Modify: `test/index.test.ts` — add tests to a new `describe("defaultHandler /settings/disconnect")` block
- Modify: `src/index.ts` — add the route handler stub

- [ ] **Step 1: Write failing tests for auth failure cases**

Add a new describe block after the existing `/settings` describe block:

```typescript
describe("defaultHandler /settings/disconnect", () => {
  it("POST with no session cookie returns 401", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/settings/disconnect", {
      method: "POST",
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("POST with expired session returns 401", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce(null); // session not found in KV

    const req = new Request("https://mcp.example.com/settings/disconnect", {
      method: "POST",
      headers: { Cookie: "settings_session=expired" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to confirm both tests fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A2 "disconnect"
```
Expected: both FAIL (route not implemented yet, falls through to 200).

- [ ] **Step 3: Add the route skeleton to `src/index.ts`**

Add this block inside `defaultHandler.fetch`, before the final `return new Response("intervals-mcp worker", ...)` fallback. Place it after the `/settings/save` block:

```typescript
if (url.pathname === "/settings/disconnect" && request.method === "POST") {
  const sessionToken = getSessionToken(request);
  if (!sessionToken) return new Response("Unauthorized", { status: 401 });

  const session = await env.OAUTH_KV.get(`settings_session:${sessionToken}`, "json") as { username: string } | null;
  if (!session) return new Response("Session expired", { status: 401 });

  // Implementation continues in Task 4
  return new Response("ok");
}
```

- [ ] **Step 4: Run tests — auth failure cases should pass, happy path not yet**

```bash
npm test
```
Expected: the two new auth-failure tests pass, all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "test: disconnect handler auth failure cases + route skeleton"
```

---

### Task 4: Disconnect handler — happy path (revoke + delete + redirect)

**Files:**
- Modify: `test/index.test.ts` — add happy path + edge case tests
- Modify: `src/index.ts` — complete the handler implementation

- [ ] **Step 1: Write failing tests for the happy path and edge cases**

Add inside the existing `describe("defaultHandler /settings/disconnect")` block:

```typescript
it("POST with valid session revokes all grants, deletes credentials and session, redirects", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValueOnce({ username: "testuser" });
  env.OAUTH_PROVIDER.listUserGrants.mockResolvedValue({
    items: [{ id: "grant-1" }, { id: "grant-2" }],
    cursor: undefined,
  });

  const req = new Request("https://mcp.example.com/settings/disconnect", {
    method: "POST",
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://mcp.example.com/settings/disconnected");
  expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(res.headers.get("Set-Cookie")).toContain("Path=/settings");
  expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-1", "testuser");
  expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-2", "testuser");
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:testuser");
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_session:mytoken");
});

it("POST with no active grants still deletes credentials and session", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValueOnce({ username: "testuser" });
  env.OAUTH_PROVIDER.listUserGrants.mockResolvedValue({ items: [], cursor: undefined });

  const req = new Request("https://mcp.example.com/settings/disconnect", {
    method: "POST",
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(env.OAUTH_PROVIDER.revokeGrant).not.toHaveBeenCalled();
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:testuser");
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_session:mytoken");
});

it("POST paginates listUserGrants and revokes grants across all pages", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValueOnce({ username: "testuser" });
  env.OAUTH_PROVIDER.listUserGrants
    .mockResolvedValueOnce({ items: [{ id: "grant-1" }], cursor: "page2cursor" })
    .mockResolvedValueOnce({ items: [{ id: "grant-2" }], cursor: undefined });

  const req = new Request("https://mcp.example.com/settings/disconnect", {
    method: "POST",
    headers: { Cookie: "settings_session=mytoken" },
  });
  await defaultHandler.fetch(req, env);

  expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenCalledTimes(2);
  expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenNthCalledWith(1, "testuser");
  expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenNthCalledWith(2, "testuser", { cursor: "page2cursor" });
  expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-1", "testuser");
  expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-2", "testuser");
});

it("POST continues deleting credentials even if one revokeGrant fails", async () => {
  const env = makeEnv();
  env.OAUTH_KV.get.mockResolvedValueOnce({ username: "testuser" });
  env.OAUTH_PROVIDER.listUserGrants.mockResolvedValue({
    items: [{ id: "grant-1" }, { id: "grant-2" }],
    cursor: undefined,
  });
  env.OAUTH_PROVIDER.revokeGrant
    .mockResolvedValueOnce(undefined)         // grant-1 succeeds
    .mockRejectedValueOnce(new Error("KV error")); // grant-2 fails

  const req = new Request("https://mcp.example.com/settings/disconnect", {
    method: "POST",
    headers: { Cookie: "settings_session=mytoken" },
  });
  const res = await defaultHandler.fetch(req, env);

  expect(res.status).toBe(302);
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:testuser");
  expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_session:mytoken");
});
```

- [ ] **Step 2: Run to confirm all four new tests fail**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS).*(paginate|active|valid session|revokeGrant fails)"
```
Expected: all four FAIL.

- [ ] **Step 3: Replace the route skeleton with the full implementation in `src/index.ts`**

Replace the temporary `return new Response("ok")` at the end of the disconnect block:

```typescript
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
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: implement POST /settings/disconnect with grant revocation"
```

---

## Chunk 3: GET /settings/disconnected

### Task 5: Static confirmation page

**Files:**
- Modify: `test/index.test.ts` — add one test to a new describe block
- Modify: `src/index.ts` — add the route handler

- [ ] **Step 1: Write the failing test**

Add a new describe block after the disconnect block:

```typescript
describe("defaultHandler /settings/disconnected", () => {
  it("GET returns 200 with HTML confirmation", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/settings/disconnected");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("disconnected");
    expect(body).toContain("/settings");
  });
});
```

- [ ] **Step 2: Run to confirm test fails**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A2 "disconnected"
```
Expected: FAIL (falls through to 200 plain text, missing `text/html`).

- [ ] **Step 3: Add the route to `src/index.ts`**

Add this block before the `/settings/disconnect` POST handler (order matters — more specific paths first):

```typescript
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
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: add GET /settings/disconnected confirmation page"
```

---

## Final check

- [ ] **Run the full test suite one last time**

```bash
npm test
```
Expected: all tests pass, no warnings.

- [ ] **Smoke test locally (optional but recommended)**

```bash
npm run dev
```
Open `http://localhost:8787/settings` in a browser (you'll be redirected to GitHub auth). After authenticating, verify the danger zone appears, the confirm dialog fires, and clicking "Disconnect account" lands you on the disconnected page.
