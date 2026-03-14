// src/auth.ts

export function generateId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyPkce(
  codeChallenge: string,
  codeVerifier: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url === codeChallenge;
}

export function isAllowedUser(username: string, allowedUsers: string): boolean {
  return allowedUsers
    .split(",")
    .map((u) => u.trim())
    .includes(username);
}

export function buildGitHubAuthUrl(
  clientId: string,
  state: string,
  callbackUrl: string
): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("redirect_uri", callbackUrl);
  return url.toString();
}

export function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    revocation_endpoint: `${baseUrl}/revoke`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export async function exchangeGitHubCode(
  code: string,
  clientId: string,
  clientSecret: string,
  callbackUrl: string
): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(data.error ?? "no access_token");
  return data.access_token;
}

export async function getGitHubUsername(accessToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "intervals-mcp",
    },
  });
  const data = (await res.json()) as { login?: string };
  if (!data.login) throw new Error("could not get GitHub username");
  return data.login;
}
