import { describe, it, expect } from "vitest";
import {
  generateId,
  verifyPkce,
  isAllowedUser,
  buildGitHubAuthUrl,
  buildOAuthMetadata,
} from "../src/auth";

describe("generateId", () => {
  it("returns a non-empty string", () => {
    expect(generateId().length).toBeGreaterThan(0);
  });

  it("returns unique values", () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe("verifyPkce", () => {
  it("returns true when code_verifier hashes to code_challenge", async () => {
    // SHA256("abc") base64url = "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
    const verifier = "abc";
    const challenge = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0";
    expect(await verifyPkce(challenge, verifier)).toBe(true);
  });

  it("returns false for wrong verifier", async () => {
    const challenge = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0";
    expect(await verifyPkce(challenge, "wrong")).toBe(false);
  });
});

describe("isAllowedUser", () => {
  it("returns true for exact match", () => {
    expect(isAllowedUser("alice", "alice,bob")).toBe(true);
  });

  it("returns true for second in list", () => {
    expect(isAllowedUser("bob", "alice,bob")).toBe(true);
  });

  it("returns false when not in list", () => {
    expect(isAllowedUser("eve", "alice,bob")).toBe(false);
  });

  it("handles whitespace around names", () => {
    expect(isAllowedUser("alice", "alice, bob")).toBe(true);
  });
});

describe("buildGitHubAuthUrl", () => {
  it("includes client_id, state, and scope", () => {
    const url = buildGitHubAuthUrl("client123", "state456", "https://example.com/callback");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("state=state456");
    expect(url).toContain("read%3Auser");
  });
});

describe("buildOAuthMetadata", () => {
  it("returns required MCP OAuth fields", () => {
    const meta = buildOAuthMetadata("https://mcp.example.com");
    expect(meta.issuer).toBe("https://mcp.example.com");
    expect(meta.authorization_endpoint).toBeDefined();
    expect(meta.token_endpoint).toBeDefined();
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });
});
