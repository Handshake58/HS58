/**
 * TAO.app API Client
 *
 * Wraps the TAO.app API at https://api.tao.app
 * Auth: X-API-Key header
 * All endpoints: GET /api/beta/{path}?params
 */
export class TaoAppService {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async query(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<any> {
    const url = new URL(`/api/beta/${endpoint}`, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TAO.app API ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/beta/current`, {
        headers: { 'X-API-Key': this.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
