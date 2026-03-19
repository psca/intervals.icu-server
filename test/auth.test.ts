import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildGitHubAuthUrl,
  validateIntervalsCredentials,
} from "../src/auth";

describe("buildGitHubAuthUrl", () => {
  it("includes client_id, state, and scope", () => {
    const url = buildGitHubAuthUrl("client123", "state456", "https://example.com/callback");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("state=state456");
    expect(url).toContain("read%3Auser");
  });

  it("includes redirect_uri", () => {
    const url = buildGitHubAuthUrl("c", "s", "https://example.com/callback");
    expect(url).toContain("redirect_uri=");
  });
});

describe("validateIntervalsCredentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns true when intervals.icu responds 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await validateIntervalsCredentials("i12345", "mykey");
    expect(result).toBe(true);
    // verify auth header format
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://intervals.icu/api/v1/athlete/i12345");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Basic " + btoa("API_KEY:mykey"),
    });
  });

  it("returns false when intervals.icu responds non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await validateIntervalsCredentials("i12345", "badkey");
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await validateIntervalsCredentials("i12345", "mykey");
    expect(result).toBe(false);
  });
});
