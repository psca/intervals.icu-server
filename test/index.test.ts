import { describe, it, expect, vi } from "vitest";
import { defaultHandler, apiHandler } from "../src/index";

// Minimal mock for env.OAUTH_PROVIDER
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEnv(overrides: Partial<any> = {}): any {
  return {
    API_KEY: "key",
    ATHLETE_ID: "i123",
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

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  });
});

describe("apiHandler geo-lock", () => {
  it("returns 403 for non-SG requests", async () => {
    const env = makeEnv();
    const req = Object.assign(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      { cf: { country: "US" } }
    );
    const res = await apiHandler.fetch(req, env, {});
    expect(res.status).toBe(403);
  });

  it("does not geo-block SG requests", async () => {
    const env = makeEnv();
    const req = Object.assign(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      }),
      { cf: { country: "SG" } }
    );
    const res = await apiHandler.fetch(req, env, {});
    expect(res.status).not.toBe(403);
  });
});
