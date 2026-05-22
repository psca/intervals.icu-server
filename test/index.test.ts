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
    GOOGLE_CLIENT_ID: "goog_client",
    GOOGLE_CLIENT_SECRET: "goog_secret",
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

describe("defaultHandler /help", () => {
  it("GET /help returns a public help page with sections", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/help");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="chatgpt"');
    expect(body).toContain('id="claude"');
    expect(body).toContain('id="intervals-icu"');
    expect(body).toContain("/mcp");
    expect(body).toContain("https://intervals.icu/settings");
    expect(body).toContain("Developer Settings");
  });
});

describe("defaultHandler /authorize", () => {
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
    expect(body).not.toContain('href="/help"');
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^oauth_state:/),
      expect.stringContaining("client123"),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("returns 400 when parseAuthRequest throws", async () => {
    const env = makeEnv();
    env.OAUTH_PROVIDER.parseAuthRequest.mockRejectedValue(new Error("bad request"));

    const req = new Request("https://mcp.example.com/authorize");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

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

  it("creates a fresh provider-bound oauth callback state and redirects to GitHub", async () => {
    const env = makeEnv();
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn().mockReturnValue("fresh-oauth-state"),
    } as unknown as Crypto);
    env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({
      oauthReqInfo: {
        clientId: "client123",
        redirectUri: "https://claude.ai/callback",
        scope: ["mcp"],
        state: "abc",
      },
    }));

    const req = new Request("https://mcp.example.com/login?flow=oauth&state=s1&provider=github");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("github.com/login/oauth/authorize");
    expect(res.headers.get("Location")).toContain("state=fresh-oauth-state");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "oauth_state:fresh-oauth-state",
      expect.stringContaining('"provider":"github"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "oauth_state:fresh-oauth-state",
      expect.stringContaining('"client123"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("oauth_state:s1");
    expect(env.OAUTH_KV.put).not.toHaveBeenCalledWith(
      "oauth_state:s1",
      expect.any(String),
      expect.any(Object)
    );
  });

  it("does not let a reused chooser state poison an already-issued callback state", async () => {
    const env = makeEnv();
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn().mockReturnValue("first-callback-state"),
    } as unknown as Crypto);
    env.OAUTH_KV.get
      .mockResolvedValueOnce(JSON.stringify({ flow: "settings" }))
      .mockResolvedValueOnce(null);

    const firstReq = new Request(
      "https://mcp.example.com/login?flow=settings&state=s1&provider=google"
    );
    const firstRes = await defaultHandler.fetch(firstReq, env);

    expect(firstRes.status).toBe(302);
    expect(firstRes.headers.get("Location")).toContain("state=first-callback-state");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      "settings_state:first-callback-state",
      expect.stringContaining('"provider":"google"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_state:s1");

    const secondReq = new Request(
      "https://mcp.example.com/login?flow=settings&state=s1&provider=github"
    );
    const secondRes = await defaultHandler.fetch(secondReq, env);

    expect(secondRes.status).toBe(400);
    expect(env.OAUTH_KV.put).not.toHaveBeenCalledWith(
      "settings_state:first-callback-state",
      expect.stringContaining('"provider":"github"'),
      expect.any(Object)
    );
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
      JSON.stringify({
        oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: [], state: "s" },
        provider: "github",
      })
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
    env.OAUTH_KV.get
      .mockResolvedValueOnce(JSON.stringify({
        oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: ["mcp"], state: "s" },
        provider: "github",
      }))
      .mockResolvedValueOnce(JSON.stringify({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" }));
    env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({
      redirectTo: "https://claude.ai/callback?code=authcode",
    });

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ access_token: "gh_tok" }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ id: 12345, login: "testuser" }),
      })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("claude.ai");
    expect(env.OAUTH_KV.get).toHaveBeenCalledWith("credentials:github:12345");
  });

  it("redirects to /configure when user has no credentials", async () => {
    const env = makeEnv();
    // KV: first call returns oauth_state (oauthReqInfo), second call returns null (no credentials)
    env.OAUTH_KV.get
      .mockResolvedValueOnce(JSON.stringify({
        oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: [], state: "s" },
        provider: "github",
      }))
      .mockResolvedValueOnce(null); // credentials:<username> not found

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ id: 12345, login: "testuser" }) })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/configure?state=");
    // oauth_state deleted, configure_state written
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("oauth_state:validstate");
    expect(env.OAUTH_KV.get).toHaveBeenCalledWith("credentials:github:12345");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^configure_state:/),
      expect.stringContaining('"accountId":"github:12345"'),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("returns 400 when oauth state has no selected provider", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue(JSON.stringify({
      oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: [], state: "s" },
    }));

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("issues session cookie and redirects to /settings when state is a settings_state", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get
      .mockResolvedValueOnce(null) // oauth_state:<id> not found
      .mockResolvedValueOnce(JSON.stringify({ flow: "settings", provider: "github" })); // settings_state:<id> found

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ id: 12345, login: "testuser" }) })
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
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_session:/),
      expect.stringContaining('"accountId":"github:12345"'),
      expect.objectContaining({ expirationTtl: 3600 })
    );
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_session:/),
      expect.stringContaining('"provider":"github"'),
      expect.objectContaining({ expirationTtl: 3600 })
    );
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_session:/),
      expect.stringContaining('"subject":"12345"'),
      expect.objectContaining({ expirationTtl: 3600 })
    );
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_session:/),
      expect.stringContaining('"displayName":"testuser"'),
      expect.objectContaining({ expirationTtl: 3600 })
    );
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

  it("calls completeAuthorization directly when credentials already exist", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get
      .mockResolvedValueOnce(JSON.stringify({
        oauthReqInfo: { clientId: "c", redirectUri: "https://r", scope: [], state: "s" },
        provider: "github",
      }))
      .mockResolvedValueOnce(JSON.stringify({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" }));
    env.OAUTH_PROVIDER.completeAuthorization.mockResolvedValue({ redirectTo: "https://claude.ai/cb" });

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ access_token: "gh_tok" }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ id: 12345, login: "testuser" }) })
    );

    const req = new Request("https://mcp.example.com/callback?code=code&state=validstate");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("claude.ai");
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalled();
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
      userId: "Z29vZ2xlOjEwODc2NTQzMjEwOTg3NjU0MzIxMA",
      metadata: expect.objectContaining({ provider: "google", email: "ada@example.com" }),
      props: expect.objectContaining({ accountId: "google:108765432109876543210" }),
    }));
  });

  it("preserves plus signs in Google callback authorization codes", async () => {
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

    const req = new Request("https://mcp.example.com/callback?code=4%2F0AQSTgQ+abc123&state=validstate");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).body).toContain("code=4%2F0AQSTgQ%2Babc123");
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
      JSON.stringify({
        oauthReqInfo: { scope: [] },
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
        accountId: "github:12345",
      })
    );
    const req = new Request("https://mcp.example.com/configure?state=validstate");
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("athleteId");
    expect(body).toContain("apiKey");
    expect(body).not.toContain('href="/help#intervals-icu"');
    expect(body).not.toContain('target="_blank"');
  });

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
      JSON.stringify({
        oauthReqInfo: { scope: [] },
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
        accountId: "github:12345",
      })
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
      JSON.stringify({
        oauthReqInfo,
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
        accountId: "github:12345",
      })
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
      "credentials:github:12345",
      expect.stringContaining("athleteId")
    );
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId: "Z2l0aHViOjEyMzQ1",
      props: expect.objectContaining({ accountId: "github:12345" }),
    }));
  });
});

describe("defaultHandler /settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET /settings with no cookie renders provider choices", async () => {
    const env = makeEnv();
    const req = new Request("https://mcp.example.com/settings");
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Continue with GitHub");
    expect(body).toContain("Continue with Google");
    expect(body).toContain("/login?flow=settings");
    expect(body).not.toContain('href="/help"');
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_state:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it("GET /settings with valid session shows form", async () => {
    const env = makeEnv();
    // KV "json" mode returns parsed objects — mock accordingly
    env.OAUTH_KV.get
      .mockResolvedValueOnce({
        accountId: "github:12345",
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
      })
      .mockResolvedValueOnce({ athleteId: "i123", encryptedApiKey: "enc", iv: "iv" });

    const req = new Request("https://mcp.example.com/settings", {
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("i123");
    expect(body).toContain("••••••••");
    expect(body).toContain('href="/help"');
  });

  it("escapes identity display and athlete ID in settings HTML", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get
      .mockResolvedValueOnce({
        accountId: "github:sub1",
        identity: {
          provider: "github",
          subject: "sub1",
          displayName: "<script>alert(1)</script>",
        },
      })
      .mockResolvedValueOnce({
        athleteId: 'i123"><script>alert(2)</script>',
        encryptedApiKey: "enc",
        iv: "iv",
      });

    const req = new Request("https://mcp.example.com/settings", {
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);
    const body = await res.text();

    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("i123&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert");
  });

  it("GET /settings with legacy session payload renders provider choices", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get
      .mockResolvedValueOnce({ username: "testuser" })
      .mockResolvedValueOnce(null);

    const req = new Request("https://mcp.example.com/settings", {
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("Continue with GitHub");
    expect(body).toContain("Continue with Google");
    expect(env.OAUTH_KV.get).not.toHaveBeenCalledWith("credentials:undefined", "json");
    expect(env.OAUTH_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^settings_state:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 600 })
    );
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

  it("POST /settings/save returns 401 with legacy session payload", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValue({ username: "testuser" });

    const req = new Request("https://mcp.example.com/settings/save", {
      method: "POST",
      body: new URLSearchParams({ athleteId: "i123", apiKey: "key" }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "settings_session=mytoken",
      },
    });
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(401);
    expect(env.OAUTH_KV.get).not.toHaveBeenCalledWith("credentials:undefined", "json");
  });

  it("POST /settings/save updates credentials on valid input", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    // KV "json" mode returns parsed object
    env.OAUTH_KV.get.mockResolvedValue({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });
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
      "credentials:github:12345",
      expect.stringContaining("i999")
    );
  });

  it("POST /settings/save with blank athleteId returns 400", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    env.OAUTH_KV.get.mockResolvedValue({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });

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
    const encrypted = await encryptApiKey("existingkey", "github:12345", masterKey);
    // First get: session lookup; Second get: existing credentials
    env.OAUTH_KV.get
      .mockResolvedValueOnce({
        accountId: "github:12345",
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
      })
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
      "credentials:github:12345",
      expect.stringContaining(encrypted.encryptedApiKey)
    );
  });

  it("POST /settings/save with blank apiKey and no existing creds returns 400", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    // First get: session lookup; Second get: no existing credentials
    env.OAUTH_KV.get
      .mockResolvedValueOnce({
        accountId: "github:12345",
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
      })
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
      .mockResolvedValueOnce({
        accountId: "github:12345",
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
      })
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
      .mockResolvedValueOnce({
        accountId: "github:12345",
        identity: { provider: "github", subject: "12345", displayName: "testuser" },
      })
      .mockResolvedValueOnce(null); // no credentials

    const req = new Request("https://mcp.example.com/settings", {
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);
    const body = await res.text();

    expect(body).not.toContain("/settings/disconnect");
  });

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

  it("POST with legacy session payload returns 401", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce({ username: "testuser" });

    const req = new Request("https://mcp.example.com/settings/disconnect", {
      method: "POST",
      headers: { Cookie: "settings_session=legacy" },
    });
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(401);
    expect(env.OAUTH_PROVIDER.listUserGrants).not.toHaveBeenCalled();
    expect(env.OAUTH_KV.delete).not.toHaveBeenCalledWith("credentials:undefined");
  });

  it("POST with valid session revokes all grants, deletes credentials and session, redirects", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });
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
    expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-1", "Z2l0aHViOjEyMzQ1");
    expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-2", "Z2l0aHViOjEyMzQ1");
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:github:12345");
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_session:mytoken");
  });

  it("POST with no active grants still deletes credentials and session", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });
    env.OAUTH_PROVIDER.listUserGrants.mockResolvedValue({ items: [], cursor: undefined });

    const req = new Request("https://mcp.example.com/settings/disconnect", {
      method: "POST",
      headers: { Cookie: "settings_session=mytoken" },
    });
    const res = await defaultHandler.fetch(req, env);

    expect(res.status).toBe(302);
    expect(env.OAUTH_PROVIDER.revokeGrant).not.toHaveBeenCalled();
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:github:12345");
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("settings_session:mytoken");
  });

  it("POST paginates listUserGrants and revokes grants across all pages", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });
    env.OAUTH_PROVIDER.listUserGrants
      .mockResolvedValueOnce({ items: [{ id: "grant-1" }], cursor: "page2cursor" })
      .mockResolvedValueOnce({ items: [{ id: "grant-2" }], cursor: undefined });

    const req = new Request("https://mcp.example.com/settings/disconnect", {
      method: "POST",
      headers: { Cookie: "settings_session=mytoken" },
    });
    await defaultHandler.fetch(req, env);

    expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenCalledTimes(2);
    expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenNthCalledWith(1, "Z2l0aHViOjEyMzQ1");
    expect(env.OAUTH_PROVIDER.listUserGrants).toHaveBeenNthCalledWith(2, "Z2l0aHViOjEyMzQ1", { cursor: "page2cursor" });
    expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-1", "Z2l0aHViOjEyMzQ1");
    expect(env.OAUTH_PROVIDER.revokeGrant).toHaveBeenCalledWith("grant-2", "Z2l0aHViOjEyMzQ1");
  });

  it("POST continues deleting credentials even if one revokeGrant fails", async () => {
    const env = makeEnv();
    env.OAUTH_KV.get.mockResolvedValueOnce({
      accountId: "github:12345",
      identity: { provider: "github", subject: "12345", displayName: "testuser" },
    });
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
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("credentials:github:12345");
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
    const ctx = { props: { accountId: "github:12345" } };

    const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
    const res = await apiHandler.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("/settings");
  });

  it("returns 401 when token props do not include accountId", async () => {
    const env = makeEnv({ CREDENTIALS_MASTER_KEY: "a".repeat(64) });
    const ctx = { props: { username: "testuser" } };

    const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
    const res = await apiHandler.fetch(req, env, ctx);

    expect(res.status).toBe(401);
    expect(env.OAUTH_KV.get).not.toHaveBeenCalled();
  });

  it("creates IntervalsClient with decrypted credentials", async () => {
    const { encryptApiKey: enc } = await import("../src/crypto");
    const masterKey = "a".repeat(64);
    const userAccountId = "github:12345";
    const { encryptedApiKey, iv } = await enc("real-api-key", userAccountId, masterKey);

    const env = makeEnv({ CREDENTIALS_MASTER_KEY: masterKey });
    // KV "json" mode returns parsed object — mock accordingly
    env.OAUTH_KV.get.mockResolvedValue({ athleteId: "i123", encryptedApiKey, iv });
    const ctx = { props: { accountId: userAccountId } };

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
