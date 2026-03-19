// src/auth.ts

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

export async function validateIntervalsCredentials(
  athleteId: string,
  apiKey: string
): Promise<boolean> {
  try {
    const res = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}`, {
      headers: {
        Authorization: "Basic " + btoa(`API_KEY:${apiKey}`),
        Accept: "application/json",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

