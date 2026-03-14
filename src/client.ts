export class IntervalsClient {
  private static readonly BASE_URL = "https://intervals.icu/api/v1";
  readonly authHeader: string;
  readonly athleteId: string;

  constructor(apiKey: string, athleteId: string) {
    this.authHeader = "Basic " + btoa(`API_KEY:${apiKey}`);
    this.athleteId = athleteId;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(IntervalsClient.BASE_URL + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.authHeader, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(IntervalsClient.BASE_URL + path, {
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
    const res = await fetch(IntervalsClient.BASE_URL + path, {
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

  async delete(path: string): Promise<void> {
    const res = await fetch(IntervalsClient.BASE_URL + path, {
      method: "DELETE",
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  }
}
