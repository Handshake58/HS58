/**
 * TPN API Client
 *
 * Wraps the TPN API (Bittensor Subnet 65) at https://api.taoprivatenetwork.com
 */

import type { LeaseParams, TpnApiRequest, TpnApiResponse, TpnLeaseType } from './types.js';

export class TpnService {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async requestLease(
    type: TpnLeaseType,
    params: LeaseParams
  ): Promise<TpnApiResponse> {
    const body: TpnApiRequest = {
      minutes: params.minutes ?? 60,
      type,
      residential: params.residential ? 'true' : 'false',
    };

    if (params.country) {
      body.country = params.country;
    }

    const res = await fetch(`${this.baseUrl}/api/v1/vpn/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TPN API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data: TpnApiResponse = await res.json();

    if (!data.success) {
      throw new Error('TPN API returned success=false');
    }

    return data;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, {
        signal: AbortSignal.timeout(10000),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}
