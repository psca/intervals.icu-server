import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultHandler, apiHandler } from "../src/index";

// Minimal mock for env.OAUTH_PROVIDER
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(overrides: Partial<any> = {}): any {
  return {
    CREDENTIALS_MASTER_KEY: "00".repeat(32),
    GITHUB_CLIENT_ID: "gh_client",
    GITHUB_CLIENT_SECRET: "gh_secret",
    GITHUB_ALLOWED_USERS: "testuser",
    OAUTH_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(),
      completeAuthorization: vi.fn(),
      lookupClient: vi.fn(),
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

  it("returns 403 when user is not allowed", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(
      JSON.stringify({ clientId: "c", redirectUri: "https://r", scope: [], state: "s" })
    );

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ access_token: "gh_tok" }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ login: "hacker" }),
      })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(403);
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

