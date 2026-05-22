import { describe, it, expect, vi, afterEach } from "vitest";
import {
  accountId,
  buildProviderAuthUrl,
  credentialsKey,
  exchangeProviderCode,
  getProviderIdentity,
  isAuthProvider,
  validateIntervalsCredentials,
} from "../src/auth";

describe("auth provider helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes supported providers", () => {
    expect(isAuthProvider("github")).toBe(true);
    expect(isAuthProvider("google")).toBe(true);
    expect(isAuthProvider("email")).toBe(false);
    expect(isAuthProvider(null)).toBe(false);
  });

  it("builds canonical account ids", () => {
    expect(accountId({
      provider: "github",
      subject: "12345",
      displayName: "octo",
    })).toBe("github:12345");
  });

  it("builds credentials storage keys from account ids", () => {
    expect(credentialsKey("google:108765432109876543210")).toBe(
      "credentials:google:108765432109876543210"
    );
  });

  it("builds GitHub auth URL with read:user scope", () => {
    const url = buildProviderAuthUrl("github", "client123", "state456", "https://example.com/callback");
    expect(url).toContain("github.com/login/oauth/authorize");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("state=state456");
    expect(url).toContain("read%3Auser");
    expect(url).toContain("redirect_uri=");
  });

  it("builds Google auth URL with OpenID scopes", () => {
    const url = buildProviderAuthUrl("google", "google-client", "state456", "https://example.com/callback");
    expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("client_id=google-client");
    expect(url).toContain("state=state456");
    expect(url).toContain("openid+email+profile");
    expect(url).toContain("response_type=code");
    expect(url).toContain("redirect_uri=");
  });

  it("exchanges GitHub auth code at GitHub token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ access_token: "gh_tok" }),
    }));

    const token = await exchangeProviderCode("github", "code", "client", "secret", "https://example.com/callback");
    expect(token).toBe("gh_tok");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      client_id: "client",
      client_secret: "secret",
      code: "code",
      redirect_uri: "https://example.com/callback",
    });
  });

  it("exchanges Google auth code at Google token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ access_token: "goog_tok" }),
    }));

    const token = await exchangeProviderCode("google", "code", "client", "secret", "https://example.com/callback");
    expect(token).toBe("goog_tok");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect((init as RequestInit).headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect((init as RequestInit).body).toBe(
      "code=code&client_id=client&client_secret=secret&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&grant_type=authorization_code"
    );
  });

  it("returns GitHub numeric id as subject and login as display name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ id: 12345, login: "octo" }),
    }));

    const identity = await getProviderIdentity("github", "gh_tok");
    expect(identity).toEqual({
      provider: "github",
      subject: "12345",
      displayName: "octo",
    });
  });

  it("returns Google sub as subject and verified email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        sub: "108765432109876543210",
        name: "Ada User",
        email: "ada@example.com",
        email_verified: true,
      }),
    }));

    const identity = await getProviderIdentity("google", "goog_tok");
    expect(identity).toEqual({
      provider: "google",
      subject: "108765432109876543210",
      displayName: "Ada User",
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  it("falls back to verified email when Google name is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        sub: "108765432109876543210",
        email: "ada@example.com",
        email_verified: true,
      }),
    }));

    const identity = await getProviderIdentity("google", "goog_tok");
    expect(identity).toEqual({
      provider: "google",
      subject: "108765432109876543210",
      displayName: "ada@example.com",
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  it("does not treat non-boolean email_verified as a verified email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        sub: "108765432109876543210",
        email: "ada@example.com",
        email_verified: "true",
      }),
    }));

    const identity = await getProviderIdentity("google", "goog_tok");
    expect(identity).toEqual({
      provider: "google",
      subject: "108765432109876543210",
      displayName: "Google user",
      email: undefined,
      emailVerified: false,
    });
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
