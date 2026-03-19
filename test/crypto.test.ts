import { describe, it, expect } from "vitest";
import { hexToBytes, encryptApiKey, decryptApiKey } from "../src/crypto";

const MASTER_KEY = "a".repeat(64); // 64 hex chars = valid

describe("hexToBytes", () => {
  it("converts 64-char hex string to 32-byte Uint8Array", () => {
    const bytes = hexToBytes("00".repeat(32));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(0);
  });

  it("throws on wrong length", () => {
    expect(() => hexToBytes("aabb")).toThrow("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  });

  it("throws on non-hex characters", () => {
    expect(() => hexToBytes("z".repeat(64))).toThrow("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  });
});

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips an API key for a given username", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    expect(typeof encryptedApiKey).toBe("string");
    expect(typeof iv).toBe("string");

    const decrypted = await decryptApiKey(encryptedApiKey, iv, "alice", MASTER_KEY);
    expect(decrypted).toBe("my-api-key");
  });

  it("fails to decrypt with a different username", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    await expect(decryptApiKey(encryptedApiKey, iv, "bob", MASTER_KEY)).rejects.toThrow();
  });

  it("produces different ciphertext on each call (random IV)", async () => {
    const r1 = await encryptApiKey("key", "alice", MASTER_KEY);
    const r2 = await encryptApiKey("key", "alice", MASTER_KEY);
    expect(r1.iv).not.toBe(r2.iv);
    expect(r1.encryptedApiKey).not.toBe(r2.encryptedApiKey);
  });
});
