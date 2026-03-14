import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

const baseEnv = {
  API_KEY: "key",
  ATHLETE_ID: "i123",
  GITHUB_CLIENT_ID: "gh_client",
  GITHUB_CLIENT_SECRET: "gh_secret",
  GITHUB_ALLOWED_USERS: "testuser",
  OAUTH_KV: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
};

describe("OAuth metadata", () => {
  it("returns OAuth metadata at well-known endpoint", async () => {
    const req = new Request("https://mcp.example.com/.well-known/oauth-authorization-server");
    const res = await worker.fetch(req, baseEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.issuer).toBe("https://mcp.example.com");
    expect(body.authorization_endpoint).toBeDefined();
  });
});

describe("Dynamic client registration", () => {
  it("returns 201 with client_id for any registration", async () => {
    const req = new Request("https://mcp.example.com/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/callback"] }),
    });
    const res = await worker.fetch(req, baseEnv);
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.client_id).toBeDefined();
  });
});

describe("MCP auth guard", () => {
  it("returns 401 with no Authorization header", async () => {
    (baseEnv.OAUTH_KV.get as any).mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/mcp", { method: "POST" });
    const res = await worker.fetch(req, baseEnv);
    expect(res.status).toBe(401);
  });

  it("returns 401 with unknown token", async () => {
    (baseEnv.OAUTH_KV.get as any).mockResolvedValue(null);
    const req = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer unknowntoken" },
    });
    const res = await worker.fetch(req, baseEnv);
    expect(res.status).toBe(401);
  });

  it("proceeds past auth with valid KV token", async () => {
    (baseEnv.OAUTH_KV.get as any).mockResolvedValue(
      JSON.stringify({ expiresAt: Date.now() + 86400000 })
    );
    const req = new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer validtoken" },
    });
    const res = await worker.fetch(req, baseEnv);
    expect(res.status).not.toBe(401);
  });
});
