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

  it("throws on tampered ciphertext", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    const tampered = encryptedApiKey.slice(0, -2) + "XX";
    await expect(decryptApiKey(tampered, iv, "alice", MASTER_KEY)).rejects.toThrow();
  });

  it("throws on tampered IV", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("my-api-key", "alice", MASTER_KEY);
    // Flip first two chars to produce different IV bytes
    const tampered = "AA" + iv.slice(2);
    await expect(decryptApiKey(encryptedApiKey, tampered, "alice", MASTER_KEY)).rejects.toThrow();
  });

  it("round-trips an empty API key", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("", "alice", MASTER_KEY);
    const decrypted = await decryptApiKey(encryptedApiKey, iv, "alice", MASTER_KEY);
    expect(decrypted).toBe("");
  });

  it("round-trips with special characters in username", async () => {
    const username = "user@domain.com/special+chars";
    const { encryptedApiKey, iv } = await encryptApiKey("my-key", username, MASTER_KEY);
    const decrypted = await decryptApiKey(encryptedApiKey, iv, username, MASTER_KEY);
    expect(decrypted).toBe("my-key");
  });

  it("round-trips with unicode API key", async () => {
    const { encryptedApiKey, iv } = await encryptApiKey("key-with-emoji-🔑", "alice", MASTER_KEY);
    const decrypted = await decryptApiKey(encryptedApiKey, iv, "alice", MASTER_KEY);
    expect(decrypted).toBe("key-with-emoji-🔑");
  });
});
