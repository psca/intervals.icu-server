export class IntervalsClient {
  private static readonly BASE_URL = "https://intervals.icu/api/v1";
  readonly authHeader: string;
  readonly athleteId: string;

  constructor(apiKey: string, athleteId: string) {
    this.authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);
    this.athleteId = athleteId;
  }

  private url(path: string, params?: Record<string, string>): string {
    const url = new URL(IntervalsClient.BASE_URL + path);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path, params), {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown, params?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path, params), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async delete<T = void>(path: string, params?: Record<string, string>): Promise<T> {
    const res = await fetch(this.url(path, params), {
      method: "DELETE",
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
