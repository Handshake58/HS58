/**
 * Apify Platform Service
 *
 * Handles Store listing, Actor execution, and dataset retrieval.
 */

import type { RunResult } from './types.js';

const APIFY_BASE = 'https://api.apify.com/v2';

/** Apify API paths require tilde (user~actor), not slash (user/actor) */
const apiActorId = (id: string) => id.replace('/', '~');

export class ApifyService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Fetch popular actors from the Apify Store.
   * No auth needed for public store listing.
   */
  async fetchStoreActors(limit: number): Promise<any[]> {
    const url = `${APIFY_BASE}/store?sortBy=popularity&limit=${limit}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Apify Store API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as any;
    return data.data?.items ?? [];
  }

  /**
   * Run an Actor asynchronously with waitForFinish.
   * Uses POST /v2/acts/{actorId}/runs?waitForFinish=60
   * Polls up to maxWaitSecs total.
   */
  async runActor(
    actorId: string,
    input: object,
    opts: { maxTotalChargeUsd: number; maxWaitSecs: number }
  ): Promise<RunResult> {
    const params = new URLSearchParams({
      waitForFinish: '60',
      maxTotalChargeUsd: opts.maxTotalChargeUsd.toFixed(4),
    });

    const runRes = await fetch(
      `${APIFY_BASE}/acts/${apiActorId(actorId)}/runs?${params}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
      }
    );

    if (!runRes.ok) {
      const errBody = await runRes.text().catch(() => '');
      throw new Error(`Apify run failed (${runRes.status}): ${errBody.slice(0, 200)}`);
    }

    let run = (await runRes.json() as any).data;

    // Poll if still running (up to one more round of waitForFinish)
    const elapsed = 60;
    if (run.status === 'RUNNING' && elapsed < opts.maxWaitSecs) {
      const remainWait = Math.min(60, opts.maxWaitSecs - elapsed);
      const pollRes = await fetch(
        `${APIFY_BASE}/actor-runs/${run.id}?waitForFinish=${remainWait}`,
        { headers: this.headers() }
      );

      if (pollRes.ok) {
        run = (await pollRes.json() as any).data;
      }
    }

    return {
      status: run.status,
      defaultDatasetId: run.defaultDatasetId ?? undefined,
      usageUsd: run.usageTotalUsd ?? run.usageUsd ?? undefined,
    };
  }

  /**
   * Get dataset items from a completed Actor run.
   */
  async getDatasetItems(datasetId: string, limit: number): Promise<{ items: unknown[]; total: number }> {
    const res = await fetch(
      `${APIFY_BASE}/datasets/${datasetId}/items?limit=${limit}&format=json`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      throw new Error(`Apify dataset error: ${res.status}`);
    }

    const items = await res.json() as unknown[];
    const totalHeader = res.headers.get('x-apify-pagination-total');
    const total = totalHeader ? parseInt(totalHeader, 10) : items.length;

    return { items, total };
  }

  /**
   * Get Actor details (for input schema discovery).
   */
  async getActorDetails(actorId: string): Promise<any> {
    const res = await fetch(
      `${APIFY_BASE}/acts/${apiActorId(actorId)}`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      throw new Error(`Apify actor not found: ${actorId}`);
    }

    return (await res.json() as any).data;
  }
}
