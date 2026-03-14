import { describe, it, expect, vi, beforeEach } from "vitest";
import { IntervalsClient } from "../src/client";

describe("IntervalsClient", () => {
  describe("auth header", () => {
    it("constructs Basic auth with API_KEY username", () => {
      const client = new IntervalsClient("mysecretkey", "i12345");
      const expected = "Basic " + btoa("API_KEY:mysecretkey");
      expect(client.authHeader).toBe(expected);
    });

    it("exposes athleteId", () => {
      const client = new IntervalsClient("key", "i99999");
      expect(client.athleteId).toBe("i99999");
    });
  });

  describe("GET request", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    it("appends query params to URL", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "a1" }]), { status: 200 })
      );

      const client = new IntervalsClient("key", "i12345");
      await client.get("/athlete/i12345/activities", { oldest: "2026-01-01" });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("oldest=2026-01-01");
      expect(calledUrl).toContain("https://intervals.icu/api/v1");
    });

    it("throws on non-200 response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 })
      );

      const client = new IntervalsClient("bad-key", "i12345");
      await expect(client.get("/athlete/i12345/activities")).rejects.toThrow("401");
    });
  });

  describe("POST request", () => {
    it("sends JSON body with Content-Type header", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "e1" }), { status: 200 })
      ));

      const client = new IntervalsClient("key", "i12345");
      await client.post("/athlete/i12345/events", { name: "Test Ride" });

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ name: "Test Ride" }));
    });
  });

  describe("DELETE request", () => {
    it("sends DELETE method with no body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 204 })
      ));

      const client = new IntervalsClient("key", "i12345");
      await client.delete("/athlete/i12345/events/e1");

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
    });
  });
});
