/**
 * HS58-CronJob Provider
 *
 * DRAIN payment gateway for cron-job.org.
 * Agents pay to create, manage, and monitor scheduled HTTP jobs
 * using DRAIN micropayments on Polygon.
 *
 * Operations (= "models"):
 *   cronjob/create   — Schedule a new recurring HTTP request
 *   cronjob/update   — Modify an existing job (schedule, URL, enable/disable)
 *   cronjob/delete   — Remove a job permanently
 *   cronjob/list     — List all jobs in this provider account
 *   cronjob/get      — Get details of one specific job
 *   cronjob/history  — Get execution logs for a job
 *
 * Input format: Send the operation parameters as JSON in the last user message.
 * Output: JSON result as an assistant message.
 */

import express from 'express';
import cors from 'cors';
import {
  loadConfig,
  getModelPricing,
  isModelSupported,
  getSupportedModels,
  OPERATION_DESCRIPTIONS,
  OPERATION_BASE_PRICES_USD,
} from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { CronJobOrgService } from './cronjob.js';
import { formatUnits } from 'viem';
import type {
  CreateJobInput,
  UpdateJobInput,
  DeleteJobInput,
  GetJobInput,
  GetHistoryInput,
} from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const cronService = new CronJobOrgService(config.cronjobApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// GET /v1/pricing
// ---------------------------------------------------------------------------

app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const op of getSupportedModels()) {
    const p = getModelPricing(op)!;
    const priceUsd = (Number(p.inputPer1k) / 1_000_000).toFixed(4);
    pricing[op] = {
      pricePerCall: priceUsd,
      inputPer1kTokens: priceUsd,
      outputPer1kTokens: '0',
      description: OPERATION_DESCRIPTIONS[op] ?? '',
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'cronjob-scheduler',
    note: 'Flat rate per API call. Create, manage, and monitor scheduled HTTP jobs via cron-job.org.',
    models: pricing,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

app.get('/v1/models', (_req, res) => {
  const models = getSupportedModels().map(op => ({
    id: op,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cron-job.org',
    description: OPERATION_DESCRIPTIONS[op] ?? '',
    pricing_model: 'flat_per_call',
  }));

  res.json({ object: 'list', data: models });
});

// ---------------------------------------------------------------------------
// GET /v1/docs
// ---------------------------------------------------------------------------

app.get('/v1/docs', (_req, res) => {
  const markupPct = Math.round((config.markupMultiplier - 1) * 100);

  res.type('text/plain').send(`# HS58-CronJob Provider — Agent Instructions

This provider schedules and manages HTTP cron jobs via cron-job.org.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the operation IDs listed below
   - messages: ONE user message containing valid JSON = the operation input

## Available Operations

### cronjob/create  — $${OPERATION_BASE_PRICES_USD['cronjob/create']} base
Schedule a new recurring HTTP request.
Input: {"url": "https://example.com/webhook", "title": "My Job", "schedule": {"timezone": "UTC", "hours": [-1], "mdays": [-1], "minutes": [0], "months": [-1], "wdays": [-1]}}

Schedule fields: hours/mdays/minutes/months/wdays = arrays of ints, -1 means "every".
Examples:
  Every hour at :00       → minutes:[0], hours:[-1]
  Every day at 08:30      → minutes:[30], hours:[8]
  Every Mon at midnight   → minutes:[0], hours:[0], wdays:[1]
  Every 15 min            → minutes:[0,15,30,45]

requestMethod: 0=GET, 1=POST, 2=OPTIONS, 3=HEAD, 4=PUT, 5=DELETE, 8=PATCH

### cronjob/update  — $${OPERATION_BASE_PRICES_USD['cronjob/update']} base
Modify an existing job. Include only the fields you want to change.
Input: {"jobId": 12345, "enabled": false}
Input: {"jobId": 12345, "schedule": {"minutes": [0, 30]}}

### cronjob/delete  — $${OPERATION_BASE_PRICES_USD['cronjob/delete']} base
Delete a cron job permanently.
Input: {"jobId": 12345}

### cronjob/list  — $${OPERATION_BASE_PRICES_USD['cronjob/list']} base
List all cron jobs in this provider's account.
Input: {} (or empty string)

### cronjob/get  — $${OPERATION_BASE_PRICES_USD['cronjob/get']} base
Get full details of a specific job.
Input: {"jobId": 12345}

### cronjob/history  — $${OPERATION_BASE_PRICES_USD['cronjob/history']} base
Get the execution history and next predicted runs.
Input: {"jobId": 12345}

## Pricing
Flat rate per API call (${markupPct}% markup on base prices). Check /v1/pricing for current prices.

## Notes
- Jobs are created under this provider's cron-job.org account.
- Store jobId from cronjob/create response to manage the job later.
- Free tier: 100 API requests/day. Sustained tier: 5,000/day.
- Minimum execution interval: every minute.
`);
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions  — Main paid endpoint
// ---------------------------------------------------------------------------

app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({
      error: { message: 'Payment required. Include X-DRAIN-Voucher header.' },
    });
    return;
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format.' } });
    return;
  }

  // 3. Resolve operation
  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({
      error: {
        message: `Unknown operation "${modelId}". Available: ${getSupportedModels().join(', ')}`,
      },
    });
    return;
  }

  const pricing = getModelPricing(modelId)!;
  const cost = pricing.inputPer1k; // flat rate per call

  // 4. Validate voucher
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${validation.error}` },
      ...(validation.error === 'insufficient_funds' && {
        required: cost.toString(),
      }),
    });
    return;
  }

  // 5. Extract and parse operation input from last user message
  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  let input: Record<string, any> = {};
  if (lastUserMsg?.content && lastUserMsg.content.trim() !== '') {
    try {
      input = JSON.parse(lastUserMsg.content);
    } catch {
      res.status(400).json({
        error: {
          message: `User message must be valid JSON (operation input). See /v1/docs for examples.`,
        },
      });
      return;
    }
  }

  // 6. Execute the operation
  let result: unknown;

  try {
    switch (modelId) {
      case 'cronjob/create': {
        const jobInput = input as CreateJobInput;
        if (!jobInput.url) {
          res.status(400).json({ error: { message: 'cronjob/create requires "url" field.' } });
          return;
        }
        const created = await cronService.createJob({
          url: jobInput.url,
          title: jobInput.title,
          enabled: jobInput.enabled ?? true,
          schedule: jobInput.schedule,
          requestMethod: jobInput.requestMethod ?? 0,
          extendedData: jobInput.extendedData,
          auth: jobInput.auth,
          saveResponses: jobInput.saveResponses ?? false,
          requestTimeout: jobInput.requestTimeout,
          redirectSuccess: jobInput.redirectSuccess,
        });
        result = {
          operation: 'created',
          jobId: created.jobId,
          message: `Cron job created successfully. Store jobId ${created.jobId} to manage this job later.`,
        };
        break;
      }

      case 'cronjob/update': {
        const upd = input as UpdateJobInput;
        if (!upd.jobId) {
          res.status(400).json({ error: { message: 'cronjob/update requires "jobId" field.' } });
          return;
        }
        const { jobId, ...delta } = upd;
        await cronService.updateJob(jobId, delta);
        result = { operation: 'updated', jobId, message: 'Cron job updated successfully.' };
        break;
      }

      case 'cronjob/delete': {
        const del = input as DeleteJobInput;
        if (!del.jobId) {
          res.status(400).json({ error: { message: 'cronjob/delete requires "jobId" field.' } });
          return;
        }
        await cronService.deleteJob(del.jobId);
        result = {
          operation: 'deleted',
          jobId: del.jobId,
          message: 'Cron job deleted successfully.',
        };
        break;
      }

      case 'cronjob/list': {
        const list = await cronService.listJobs();
        result = {
          operation: 'list',
          count: list.jobs.length,
          jobs: list.jobs,
          someFailed: list.someFailed,
        };
        break;
      }

      case 'cronjob/get': {
        const g = input as GetJobInput;
        if (!g.jobId) {
          res.status(400).json({ error: { message: 'cronjob/get requires "jobId" field.' } });
          return;
        }
        const detail = await cronService.getJob(g.jobId);
        result = { operation: 'get', jobDetails: detail.jobDetails };
        break;
      }

      case 'cronjob/history': {
        const h = input as GetHistoryInput;
        if (!h.jobId) {
          res.status(400).json({ error: { message: 'cronjob/history requires "jobId" field.' } });
          return;
        }
        const hist = await cronService.getHistory(h.jobId);
        result = {
          operation: 'history',
          jobId: h.jobId,
          history: hist.history,
          nextPredictedRuns: hist.predictions.map(ts =>
            new Date(ts * 1000).toISOString()
          ),
        };
        break;
      }

      default:
        res.status(400).json({ error: { message: `Unknown operation: ${modelId}` } });
        return;
    }
  } catch (error: any) {
    console.error(`[cronjob] Operation ${modelId} failed:`, error.message);
    res.status(502).json({
      error: { message: `cron-job.org API error: ${error.message?.slice(0, 300)}` },
    });
    return;
  }

  // 7. Store voucher and update channel state
  drainService.storeVoucher(voucher, validation.channel!, cost);

  const totalCharged = validation.channel!.totalCharged + cost;
  const remaining = validation.channel!.deposit - totalCharged;

  // 8. Respond in OpenAI chat completion format
  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  });

  res.json({
    id: `cronjob-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify(result, null, 2),
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 1,
      total_tokens: 1,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/claim
// ---------------------------------------------------------------------------

app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/admin/stats
// ---------------------------------------------------------------------------

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    operationsSupported: getSupportedModels().length,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/vouchers
// ---------------------------------------------------------------------------

app.get('/v1/admin/vouchers', (_req, res) => {
  const unclaimed = storage.getUnclaimedVouchers();
  res.json({
    count: unclaimed.length,
    vouchers: unclaimed.map(v => ({
      channelId: v.channelId,
      amount: v.amount.toString(),
      nonce: v.nonce.toString(),
      consumer: v.consumer,
      receivedAt: new Date(v.receivedAt).toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/close-channel
// ---------------------------------------------------------------------------

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const result = await drainService.signCloseAuthorization(channelId);
    res.json({
      channelId,
      finalAmount: result.finalAmount.toString(),
      signature: result.signature,
    });
  } catch (error: any) {
    console.error('[close-channel] Error:', error?.message || error);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    operationsSupported: getSupportedModels(),
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Verify API key works by fetching the job list (no cost, just a connectivity check)
  try {
    await cronService.listJobs();
    console.log('[startup] cron-job.org API connection verified.');
  } catch (error: any) {
    console.warn(`[startup] WARNING: cron-job.org API check failed: ${error.message}`);
    console.warn('[startup] Continuing anyway — check CRONJOB_API_KEY if requests fail.');
  }

  // Start auto-claiming expiring channels
  drainService.startAutoClaim(
    config.autoClaimIntervalMinutes,
    config.autoClaimBufferSeconds,
  );

  app.listen(config.port, config.host, () => {
    const markup = Math.round((config.markupMultiplier - 1) * 100);
    console.log(`\nHS58-CronJob Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
    console.log(`Operations: ${getSupportedModels().join(', ')}`);
    console.log(`Markup: ${markup}%`);
    console.log(`\nPricing:`);
    for (const op of getSupportedModels()) {
      const p = getModelPricing(op)!;
      const usd = (Number(p.inputPer1k) / 1_000_000).toFixed(4);
      console.log(`  ${op}: $${usd}`);
    }
    console.log();
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
