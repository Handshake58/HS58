/**
 * Macrocosmos SN13 Data Universe Provider
 *
 * DRAIN payment gateway for Macrocosmos SN13 social data APIs.
 * Agents pay per query via USDC micropayments to retrieve
 * social data from X (Twitter) and Reddit through a decentralized
 * miner network on the Bittensor blockchain.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, loadModels, getModelPricing, isModelSupported } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import {
  SN13_BASE_URL,
  SN13_DATA_REQUEST_PATH,
  SN13_SET_DESIRABILITIES_PATH,
  SN13_LIST_REPOS_PATH,
} from './constants.js';
import type { SocialDataRequest, ScrapingTaskRequest } from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter (per channel, sliding window) ---
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const hits = rateLimitMap.get(channelId) ?? [];
  const recent = hits.filter(t => now - t < windowMs);
  if (recent.length >= config.rateLimitPerMinute) return false;
  recent.push(now);
  rateLimitMap.set(channelId, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, hits] of rateLimitMap) {
    const active = hits.filter(t => t > cutoff);
    if (active.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, active);
  }
}, 5 * 60_000);

// --- Admin Auth Middleware ---
function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <ADMIN_PASSWORD>' });
    return false;
  }
  return true;
}

/**
 * Proxies a social data query to SN13.
 */
async function querySN13(request: SocialDataRequest): Promise<any> {
  const response = await fetch(`${SN13_BASE_URL}${SN13_DATA_REQUEST_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.macrocosmosApiKey,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SN13 returned ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * Creates a scraping task on SN13.
 */
async function createScrapingTask(request: ScrapingTaskRequest): Promise<any> {
  const response = await fetch(`${SN13_BASE_URL}${SN13_SET_DESIRABILITIES_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.macrocosmosApiKey,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SN13 returned ${response.status}: ${body.slice(0, 300)}`);
  }

  return response.json();
}

// ============================================================
// Routes
// ============================================================

app.get('/v1/pricing', (_req, res) => {
  const socialPrice = formatUnits(config.pricePerSocialQuery, 6);
  const scrapingPrice = formatUnits(config.pricePerScrapingTask, 6);

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'data-scraping',
    note: `Social data from X and Reddit via Bittensor SN13. $${socialPrice} per query, $${scrapingPrice} per scraping task.`,
    models: {
      'sn13/social-data': {
        inputPer1kTokens: socialPrice,
        outputPer1kTokens: '0',
      },
      'sn13/web-scraping': {
        inputPer1kTokens: scrapingPrice,
        outputPer1kTokens: '0',
      },
    },
  });
});

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'sn13/social-data',
        object: 'model',
        created: Date.now(),
        owned_by: 'macrocosmos',
        description: 'On-demand social data from X (Twitter) and Reddit via Bittensor SN13 miners',
      },
      {
        id: 'sn13/web-scraping',
        object: 'model',
        created: Date.now(),
        owned_by: 'macrocosmos',
        description: 'Create incentivized scraping tasks for specific keywords/hashtags on SN13',
      },
    ],
  });
});

app.get('/v1/docs', (_req, res) => {
  const socialPrice = formatUnits(config.pricePerSocialQuery, 6);
  const scrapingPrice = formatUnits(config.pricePerScrapingTask, 6);

  res.type('text/plain').send(`# Macrocosmos SN13 Data Universe — Agent Instructions

This is NOT a chat/LLM provider. It retrieves social media data from X (Twitter)
and Reddit through Bittensor's decentralized SN13 miner network.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "sn13/social-data" or "sn13/web-scraping"
   - messages: ONE user message containing a JSON query object

## Available Models

- sn13/social-data: On-demand social data from X and Reddit ($${socialPrice}/query)
- sn13/web-scraping: Create incentivized scraping tasks for keywords ($${scrapingPrice}/task)

## Input Format

The user message content must be a JSON string (not plain text).

For sn13/social-data:
  {
    "source": "x",              // required: "x" or "reddit"
    "keywords": ["bitcoin"],    // optional: up to 5 keywords
    "usernames": ["elonmusk"],  // optional: up to 10 usernames
    "start_date": "2025-01-01", // optional: ISO date
    "end_date": "2025-01-31",   // optional: ISO date
    "limit": 50                 // optional: 1-1000 (default 100)
  }

For sn13/web-scraping:
  {
    "keywords": ["AI", "bittensor"],  // required: keywords to scrape
    "hashtags": ["#TAO"]              // optional: hashtags
  }

## Examples

Search X for recent bitcoin posts:
model: "sn13/social-data"
messages: [{"role": "user", "content": "{\\"source\\": \\"x\\", \\"keywords\\": [\\"bitcoin\\"], \\"limit\\": 10}"}]

Search Reddit for bittensor content:
model: "sn13/social-data"
messages: [{"role": "user", "content": "{\\"source\\": \\"reddit\\", \\"keywords\\": [\\"/bittensor\\"], \\"limit\\": 20}"}]

Create a scraping task:
model: "sn13/web-scraping"
messages: [{"role": "user", "content": "{\\"keywords\\": [\\"AI\\", \\"bittensor\\"]}"}]

## Response

The assistant message content is a JSON string containing:
- status: "success" or "error"
- data: array of posts/items matching the query
- meta: metadata about the request (source, counts, timing)

## Pricing

Flat rate per request:
- sn13/social-data: $${socialPrice} USDC per query
- sn13/web-scraping: $${scrapingPrice} USDC per task
Check /v1/pricing for current USDC rates.

## Notes

- No streaming support — responses are returned as complete JSON
- Rate limit: ${config.rateLimitPerMinute} requests/min per payment channel
- Upstream rate limit: 100 requests/hour (Macrocosmos API)
- Scraping tasks remain active for 7 days on the network
- Responses include X-DRAIN-Cost, X-DRAIN-Remaining headers
`);
});

/**
 * POST /v1/chat/completions
 *
 * Chat-compatible proxy for SN13 data queries.
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  if (!voucherHeader) {
    res.status(402).json({ error: { message: 'Payment required. Include X-DRAIN-Voucher header.' } });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format.' } });
    return;
  }

  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({
      error: { message: `Model "${modelId}" not available. Use: sn13/social-data or sn13/web-scraping` },
    });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }> | undefined;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Provide query as JSON in the user message.' },
    });
    return;
  }

  let queryInput: any;
  try {
    queryInput = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON. See GET /v1/docs for format.',
      },
    });
    return;
  }

  if (!checkRateLimit(voucher.channelId)) {
    res.status(429).json({
      error: { message: `Rate limit exceeded. Max ${config.rateLimitPerMinute} requests/min per channel.` },
    });
    return;
  }

  const cost = modelId === 'sn13/social-data'
    ? config.pricePerSocialQuery
    : config.pricePerScrapingTask;

  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  try {
    let resultData: any;

    if (modelId === 'sn13/social-data') {
      if (!queryInput.source || !['x', 'reddit'].includes(queryInput.source)) {
        res.status(400).json({
          error: { message: '"source" is required and must be "x" or "reddit"' },
        });
        return;
      }

      const sn13Request: SocialDataRequest = {
        source: queryInput.source,
        usernames: queryInput.usernames,
        keywords: queryInput.keywords,
        start_date: queryInput.start_date,
        end_date: queryInput.end_date,
        limit: queryInput.limit,
      };

      resultData = await querySN13(sn13Request);
    } else {
      if (!queryInput.keywords || !Array.isArray(queryInput.keywords) || queryInput.keywords.length === 0) {
        res.status(400).json({
          error: { message: '"keywords" array is required for scraping tasks' },
        });
        return;
      }

      const scrapingRequest: ScrapingTaskRequest = {
        keywords: queryInput.keywords,
        hashtags: queryInput.hashtags,
      };

      resultData = await createScrapingTask(scrapingRequest);
    }

    drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

    const totalCharged = voucherValidation.channel!.totalCharged + cost;
    const remaining = voucherValidation.channel!.deposit - totalCharged;
    const resultContent = JSON.stringify(resultData, null, 2);

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `sn13-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: resultContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    });
  } catch (error: any) {
    console.error('[sn13] Query error:', error.message);
    res.status(502).json({
      error: { message: `SN13 query failed: ${error.message?.slice(0, 300)}` },
    });
  }
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      res.status(400).json({ error: 'channelId required' });
      return;
    }
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

app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    pricePerSocialQuery: formatUnits(config.pricePerSocialQuery, 6),
    pricePerScrapingTask: formatUnits(config.pricePerScrapingTask, 6),
  });
});

app.get('/v1/admin/vouchers', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    upstream: 'sn13.api.macrocosmos.ai',
    models: ['sn13/social-data', 'sn13/web-scraping'],
  });
});

async function start() {
  loadModels(config.markup);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Social query price: $${formatUnits(config.pricePerSocialQuery, 6)} USDC`);
    console.log(`Scraping task price: $${formatUnits(config.pricePerScrapingTask, 6)} USDC`);
    console.log(`Rate limit: ${config.rateLimitPerMinute} req/min per channel`);
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
