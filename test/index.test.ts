import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultHandler, apiHandler } from "../src/index";
import { encryptApiKey } from "../src/crypto";

// Minimal mock for env.OAUTH_PROVIDER
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(overrides: Partial<any> = {}): any {
  return {
    CREDENTIALS_MASTER_KEY: "00".repeat(32),
    GITHUB_CLIENT_ID: "gh_client",
    GITHUB_CLIENT_SECRET: "gh_secret",
    OAUTH_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(),
      completeAuthorization: vi.fn(),
      lookupClient: vi.fn(),
      listUserGrants: vi.fn().mockResolvedValue({ items: [], cursor: undefined }),
      revokeGrant: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe("defaultHandler /authorize", () => {
  it("redirects to GitHub when oauthReqInfo is valid", async () => {
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

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=gh_client");
    expect(env.OAUTH_KV.put).toHaveBeenCalled();
  });

  it("returns 400 when parseAuthRequest throws", async () => {
    const env = makeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest.mockRejectedValue(new Error("bad request"));

    const req = new Request("https://mcp.example.com/authorize");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

describe("defaultHandler /callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 400 when state is missing", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/callback?code=ghcode");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 when state not found in KV", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(null);

    const req = new Request("https://mcp.example.com/callback?code=ghcode&state=unknownstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 502 when GitHub token exchange fails", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: [], state: "s" })
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ error: "bad_code" }),
    }));

    const req = new Request("https://mcp.example.com/callback?code=badcode&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(502);
  });

  it("redirects to client after successful auth", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: ["mcp"], state: "s" })
    );
    env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({
      redirectTo: "https://claude.ai/callback?code=authcode",
    });

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ access_token: "gh_tok" }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ login: "testuser" }),
      })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("claude.ai");
  });

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

  it("issues session cookie and redirects to /settings when state is a settings_state", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get
      .mockResolvedValueOnce(null) // oauth_state:<id> not found
      .mockResolvedValueOnce(JSON.stringify({ placeholder: true })); // settings_state:<id> found

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ login: "testuser" }) })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://mcp.example.com/settings");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("settings_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_state:validstate");
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
});

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

  it("GET /settings with no cookie redirects to /callback (not /settings/callback)", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/settings");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("redirect_uri=https%3A%2F%2Fmcp.example.com%2Fcallback");
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

  it("POST /settings/save with blank athleteId returns 400", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    env.OAUTH_KV.get.mockResolvedValue({ username: "testuser" });

    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "", apiKey: "somekey" }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "settings_session=mytoken",
      },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing athlete ID");
  });

  it("POST /settings/save with blank apiKey keeps existing credentials", async () => {
    const masterKey = "a".repeat(64);
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: masterKey });
    // Encrypt a real key so decryptApiKey succeeds
    const encrypted = await encryptApiKey("existingkey", "testuser", masterKey);
    // First get: session lookup; Second get: existing credentials
    env.OAUTH_KV.get
      .mockResolvedValueOnce({ username: "testuser" })
      .mockResolvedValueOnce({ athleteId: "i123", encryptedApiKey: encrypted.encryptedApiKey, iv: encrypted.iv });
    // validateIntervalsCredentials will call fetch
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "" }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "settings_session=mytoken",
      },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    // Should store the existing encrypted key, not re-encrypt
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "credentials:testuser",
      expect.stringContaining(encrypted.encryptedApiKey)
    );
  });

  it("POST /settings/save with blank apiKey and no existing creds returns 400", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    // First get: session lookup; Second get: no existing credentials
    env.OAUTH_KV.get
      .mockResolvedValueOnce({ username: "testuser" })
      .mockResolvedValueOnce(null);

    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "" }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "settings_session=mytoken",
      },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("API key required");
  });

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
});

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
});

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

