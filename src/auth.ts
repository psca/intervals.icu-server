// src/auth.ts

export type AuthProvider = "github" | "google";

export interface AuthIdentity {
  provider: AuthProvider;
  subject: string;
  displayName: string;
  email?: string;
  emailVerified?: boolean;
}

export function isAuthProvider(value: unknown): value is AuthProvider {
  return value === "github" || value === "google";
}

export function accountId(identity: AuthIdentity): string {
  return `${identity.provider}:${identity.subject}`;
}

export function credentialsKey(userAccountId: string): string {
  return `credentials:${userAccountId}`;
}

export function buildProviderAuthUrl(
  provider: AuthProvider,
  clientId: string,
  state: string,
  callbackUrl: string
): string {
  const url = new URL(
    provider === "github"
      ? "https://github.com/login/oauth/authorize"
      : "https://accounts.google.com/o/oauth2/v2/auth"
  );
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", callbackUrl);

  if (provider === "github") {
    url.searchParams.set("scope", "read:user");
  } else {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("response_type", "code");
  }

  return url.toString();
}

export async function exchangeProviderCode(
  provider: AuthProvider,
  code: string,
  clientId: string,
  clientSecret: string,
  callbackUrl: string
): Promise<string> {
  const isGoogle = provider === "google";
  const res = await fetch(
    provider === "github"
      ? "https://github.com/login/oauth/access_token"
      : "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": isGoogle
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body: isGoogle
        ? new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: callbackUrl,
            grant_type: "authorization_code",
          }).toString()
        : JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: callbackUrl,
          }),
    }
  );
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) throw new Error(data.error_description ?? data.error ?? "no access_token");
  return data.access_token;
}

export async function getProviderIdentity(
  provider: AuthProvider,
  accessToken: string
): Promise<AuthIdentity> {
  if (provider === "github") {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "intervals-mcp",
      },
    });
    const data = (await res.json()) as { id?: number; login?: string };
    if (data.id === undefined || !data.login) throw new Error("could not get GitHub identity");
    return {
      provider: "github",
      subject: String(data.id),
      displayName: data.login,
    };
  }

  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    sub?: string;
    name?: string;
    email?: string;
    email_verified?: boolean | string | number | null;
  };
  if (!data.sub) throw new Error("could not get Google identity");
  const emailVerified = data.email_verified === true;
  const verifiedEmail = emailVerified && data.email ? data.email : undefined;
  return {
    provider: "google",
    subject: data.sub,
    displayName: data.name ?? verifiedEmail ?? "Google user",
    email: verifiedEmail,
    emailVerified,
  };
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
