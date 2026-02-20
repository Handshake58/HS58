/**
 * Taostats API Client
 *
 * Wraps the Taostats API at https://api.taostats.io
 * Auth: Authorization header with API key
 * All endpoints: GET /api/{path}/v1?params
 * Response: { pagination: {...}, data: [...] }
 */

import type { TaostatsResponse } from './types.js';

export class TaostatsService {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async query(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<TaostatsResponse> {
    const url = new URL(`/api/${endpoint}/v1`, this.baseUrl);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': this.apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Taostats API ${res.status}: ${text.slice(0, 300)}`);
    }

    return await res.json() as TaostatsResponse;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/price/latest/v1?asset=tao&limit=1`, {
        headers: { 'Authorization': this.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
