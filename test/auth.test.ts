import { describe, it, expect } from "vitest";
import {
  isAllowedUser,
  buildGitHubAuthUrl,
} from "../src/auth";

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

  it("includes redirect_uri", () => {
    const url = buildGitHubAuthUrl("c", "s", "https://example.com/callback");
    expect(url).toContain("redirect_uri=");
  });
});
