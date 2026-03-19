// src/crypto.ts

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("CREDENTIALS_MASTER_KEY must be 64 hex characters");
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

async function deriveUserKey(username: string, masterKeyHex: string): Promise<CryptoKey> {
  const rawMaster = hexToBytes(masterKeyHex);
  const masterKey = await crypto.subtle.importKey("raw", rawMaster, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(username),
    },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptApiKey(
  apiKey: string,
  username: string,
  masterKeyHex: string
): Promise<{ encryptedApiKey: string; iv: string }> {
  const userKey = await deriveUserKey(username, masterKeyHex);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    userKey,
    new TextEncoder().encode(apiKey)
  );
  return {
    encryptedApiKey: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...ivBytes)),
  };
}

export async function decryptApiKey(
  encryptedApiKey: string,
  iv: string,
  username: string,
  masterKeyHex: string
): Promise<string> {
  const userKey = await deriveUserKey(username, masterKeyHex);
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(encryptedApiKey), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    userKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}
