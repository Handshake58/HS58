/**
 * cron-job.org API Service
 *
 * Wraps the cron-job.org REST API for creating, managing,
 * and monitoring scheduled HTTP jobs.
 *
 * API docs: https://docs.cron-job.org/rest-api.html
 */

import type { CronJob, HistoryItem } from './types.js';

const CRONJOB_BASE = 'https://api.cron-job.org';

export class CronJobOrgService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${CRONJOB_BASE}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`cron-job.org API error ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new Error(
        `cron-job.org API error ${res.status}: ${data?.error ?? text.slice(0, 200)}`
      );
    }

    return data as T;
  }

  /**
   * List all cron jobs in the account.
   */
  async listJobs(): Promise<{ jobs: CronJob[]; someFailed: boolean }> {
    return this.request('GET', '/jobs');
  }

  /**
   * Get details of a specific cron job.
   */
  async getJob(jobId: number): Promise<{ jobDetails: CronJob }> {
    return this.request('GET', `/jobs/${jobId}`);
  }

  /**
   * Create a new cron job.
   * Only `url` is mandatory; all other fields are optional.
   */
  async createJob(job: Omit<CronJob, 'jobId'>): Promise<{ jobId: number }> {
    return this.request('PUT', '/jobs', { job });
  }

  /**
   * Update an existing cron job (partial update, only include changed fields).
   */
  async updateJob(jobId: number, delta: Partial<Omit<CronJob, 'jobId'>>): Promise<void> {
    await this.request('PATCH', `/jobs/${jobId}`, { job: delta });
  }

  /**
   * Delete a cron job.
   */
  async deleteJob(jobId: number): Promise<void> {
    await this.request('DELETE', `/jobs/${jobId}`);
  }

  /**
   * Get the execution history for a cron job.
   */
  async getHistory(jobId: number): Promise<{
    history: HistoryItem[];
    predictions: number[];
  }> {
    return this.request('GET', `/jobs/${jobId}/history`);
  }

  /**
   * Get details for a specific history entry.
   */
  async getHistoryItem(jobId: number, identifier: string): Promise<{
    jobHistoryDetails: HistoryItem;
  }> {
    return this.request('GET', `/jobs/${jobId}/history/${identifier}`);
  }
}
