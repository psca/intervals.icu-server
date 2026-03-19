import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("auth", () => {
  it("returns 401 with no Authorization header", async () => {
    const env = { API_KEY: "key", ATHLETE_ID: "i123", WORKER_SECRET: "secret" };
    const req = new Request("https://example.com/mcp", { method: "POST" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const env = { API_KEY: "key", ATHLETE_ID: "i123", WORKER_SECRET: "secret" };
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer wrongtoken" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("does not return 401 with correct token", async () => {
    const env = { API_KEY: "key", ATHLETE_ID: "i123", WORKER_SECRET: "secret" };
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).not.toBe(401);
  });

  it("allows valid multi-user token with no env secrets", async () => {
    const env = {};
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer i12345:validapikey" },
    });
    const res = await worker.fetch(req, env as any);
    expect(res.status).not.toBe(401);
  });

  it("returns 401 with invalid athleteId format (missing leading i)", async () => {
    const env = {};
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer 12345:myapikey" },
    });
    const res = await worker.fetch(req, env as any);
    expect(res.status).toBe(401);
  });

  it("returns 401 with empty apiKey", async () => {
    const env = {};
    const req = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer i12345:" },
    });
    const res = await worker.fetch(req, env as any);
    expect(res.status).toBe(401);
  });
});
