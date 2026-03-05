/**
 * HS58-Desearch Provider
 *
 * DRAIN payment gateway for Desearch AI (desearch.ai).
 * Bittensor Subnet 22 powered search and data APIs.
 *
 * Supported endpoints (= "models"):
 *
 *   AI Search:
 *     desearch/ai-search            — AI Contextual Search (web, X, Reddit, YouTube, HN, arXiv)
 *     desearch/ai-web-search        — AI Web Links Search
 *     desearch/ai-twitter-search    — AI X Posts Links Search
 *
 *   X / Twitter:
 *     desearch/twitter              — X Search with rich filters
 *     desearch/twitter-urls         — Fetch posts by URLs
 *     desearch/twitter-post         — Retrieve single post by ID
 *     desearch/twitter-user-search  — Search posts by user
 *     desearch/twitter-retweeters   — Get retweeters of a post
 *     desearch/twitter-user-posts   — Get user timeline posts
 *     desearch/twitter-replies      — Fetch user's tweets & replies
 *     desearch/twitter-post-replies — Fetch replies to a post
 *
 *   Web:
 *     desearch/web                  — SERP Web Search
 *     desearch/web-crawl            — Crawl a URL (text or HTML)
 *
 * Pricing: dynamic per request based on item count.
 *   AI search: $0.40/1000 items | Twitter: $0.15/1000 posts
 *   Web search: $1.00/1000 | Crawl: $0.50/1000 pages
 *
 * Input:  JSON params in the last user message.
 * Output: Raw API result as JSON assistant message.
 */

import express from 'express';
import cors from 'cors';
import DesearchLib from 'desearch-js';
// desearch-js uses default export; handle both CJS interop patterns
const DesearchClass = (DesearchLib as any).default ?? DesearchLib;
import {
  loadConfig,
  getModelPricing,
  isModelSupported,
  getSupportedModels,
  calculateRequestCost,
  MODEL_DESCRIPTIONS,
  PRICE_PER_1000_USD,
  DEFAULT_UNITS,
} from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const desearch = new DesearchClass(config.desearchApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// GET /v1/pricing
// ---------------------------------------------------------------------------

app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const model of getSupportedModels()) {
    const p = getModelPricing(model)!;
    const typicalUsd = (Number(p.inputPer1k) / 1_000_000).toFixed(6);
    const units = DEFAULT_UNITS[model] ?? 10;
    const pricePerK = PRICE_PER_1000_USD[model];

    pricing[model] = {
      typicalPrice: typicalUsd,
      inputPer1kTokens: typicalUsd,
      outputPer1kTokens: '0',
      pricePerK: (pricePerK * config.markupMultiplier).toFixed(4),
      typicalUnits: units,
      description: MODEL_DESCRIPTIONS[model] ?? '',
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'search-and-scraping',
    note: 'Prices are dynamic: cost = (count / 1000) × pricePerK. Check /v1/docs for pricing formulas.',
    markup: `${Math.round((config.markupMultiplier - 1) * 100)}%`,
    models: pricing,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

app.get('/v1/models', (_req, res) => {
  const models = getSupportedModels().map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'desearch.ai',
    description: MODEL_DESCRIPTIONS[model] ?? '',
    pricing_model: 'per_item',
  }));

  res.json({ object: 'list', data: models });
});

// ---------------------------------------------------------------------------
// GET /v1/docs
// ---------------------------------------------------------------------------

app.get('/v1/docs', (_req, res) => {
  const markup = Math.round((config.markupMultiplier - 1) * 100);

  res.type('text/plain').send(`# HS58-Desearch Provider — Agent Instructions

Desearch provides AI-powered search, X/Twitter data, web search, and web crawling
powered by Bittensor Subnet 22.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the endpoint IDs below
   - messages: ONE user message containing valid JSON = the request parameters

## Pricing (${markup}% markup applied)

Prices are dynamic based on item count. Formula: cost = (count / 1000) × pricePerK
  AI search endpoints:   $${(0.40 * config.markupMultiplier).toFixed(4)} per 1000 items (base $0.40 × ${config.markupMultiplier.toFixed(2)})
  Twitter endpoints:     $${(0.15 * config.markupMultiplier).toFixed(4)} per 1000 posts (base $0.15 × ${config.markupMultiplier.toFixed(2)})
  Web SERP search:       $${(0.001 * config.markupMultiplier).toFixed(6)} per search (base $0.001 × ${config.markupMultiplier.toFixed(2)})
  Web crawl:             $${(0.0005 * config.markupMultiplier).toFixed(6)} per page (base $0.0005 × ${config.markupMultiplier.toFixed(2)})

## Endpoints

### desearch/ai-search
AI Contextual Search across multiple sources.
Input: {"prompt": "Bittensor latest news", "tools": ["web","twitter","reddit"], "count": 10, "date_filter": "PAST_24_HOURS", "result_type": "LINKS_WITH_FINAL_SUMMARY"}
tools options: web, twitter, reddit, youtube, hackernews, wikipedia, arxiv
result_type options: LINKS_WITH_FINAL_SUMMARY, ONLY_LINKS, NO_LINKS_ONLY_SUMMARY
date_filter options: PAST_24_HOURS, PAST_WEEK, PAST_MONTH, PAST_YEAR

### desearch/ai-web-search
AI Web Links Search (no AI summary, just structured links).
Input: {"prompt": "latest AI news", "tools": ["web","hackernews","reddit"], "count": 10}
tools: web, hackernews, reddit, wikipedia, youtube, arxiv

### desearch/ai-twitter-search
AI X Posts Links Search.
Input: {"prompt": "Bittensor TAO price", "count": 10}

### desearch/twitter
X Search with rich filters.
Input: {"query": "Bittensor", "sort": "Top", "count": 20, "lang": "en", "start_date": "2026-01-01", "min_likes": 10}

### desearch/twitter-urls
Fetch full post data by URL list.
Input: {"urls": ["https://x.com/user/status/123456"]}

### desearch/twitter-post
Get a single post by ID.
Input: {"id": "1234567890"}

### desearch/twitter-user-search
Search posts by a specific user.
Input: {"user": "elonmusk", "query": "AI", "count": 10}

### desearch/twitter-retweeters
Get users who retweeted a post.
Input: {"id": "1234567890", "cursor": null}

### desearch/twitter-user-posts
Get a user's timeline posts.
Input: {"username": "elonmusk", "cursor": null}

### desearch/twitter-replies
Fetch a user's tweets and replies.
Input: {"user": "elonmusk", "count": 10, "query": ""}

### desearch/twitter-post-replies
Fetch replies to a specific post.
Input: {"post_id": "1234567890", "count": 10, "query": ""}

### desearch/web
SERP Web Search (paginated).
Input: {"query": "latest AI research", "start": 0}

### desearch/web-crawl
Crawl a URL and return its content.
Input: {"url": "https://example.com", "format": "text"}
format: "text" or "html"
`);
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — Main paid endpoint
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

  // 3. Resolve model
  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({
      error: {
        message: `Unknown model "${modelId}". Available: ${getSupportedModels().join(', ')}`,
      },
    });
    return;
  }

  // 4. Parse input JSON from last user message
  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content?.trim()) {
    res.status(400).json({
      error: { message: 'No input provided. Send request parameters as JSON in the user message.' },
    });
    return;
  }

  let params: Record<string, any> = {};
  try {
    params = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: { message: 'User message must be valid JSON. See /v1/docs for parameter reference.' },
    });
    return;
  }

  // 5. Calculate dynamic cost based on count/urls
  const cost = calculateRequestCost(modelId, params, config.markupMultiplier);

  // 6. Validate voucher covers cost
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${validation.error}` },
      ...(validation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  // 7. Execute Desearch API call
  let result: unknown;

  try {
    switch (modelId) {
      case 'desearch/ai-search':
        result = await desearch.aiSearch(params as any);
        break;

      case 'desearch/ai-web-search':
        result = await desearch.aiWebLinksSearch(params as any);
        break;

      case 'desearch/ai-twitter-search':
        result = await desearch.aiXLinksSearch(params as any);
        break;

      case 'desearch/twitter':
        result = await desearch.xSearch(params as any);
        break;

      case 'desearch/twitter-urls': {
        if (!params.urls || !Array.isArray(params.urls) || params.urls.length === 0) {
          res.status(400).json({ error: { message: 'desearch/twitter-urls requires "urls" array.' } });
          return;
        }
        result = await desearch.xPostsByUrls(params as any);
        break;
      }

      case 'desearch/twitter-post': {
        if (!params.id) {
          res.status(400).json({ error: { message: 'desearch/twitter-post requires "id".' } });
          return;
        }
        result = await desearch.xPostById(params as any);
        break;
      }

      case 'desearch/twitter-user-search': {
        if (!params.user) {
          res.status(400).json({ error: { message: 'desearch/twitter-user-search requires "user".' } });
          return;
        }
        result = await desearch.xPostsByUser(params as any);
        break;
      }

      case 'desearch/twitter-retweeters': {
        if (!params.id) {
          res.status(400).json({ error: { message: 'desearch/twitter-retweeters requires "id".' } });
          return;
        }
        result = await desearch.xPostRetweeters(params as any);
        break;
      }

      case 'desearch/twitter-user-posts': {
        if (!params.username) {
          res.status(400).json({ error: { message: 'desearch/twitter-user-posts requires "username".' } });
          return;
        }
        result = await desearch.xUserPosts(params as any);
        break;
      }

      case 'desearch/twitter-replies': {
        if (!params.user) {
          res.status(400).json({ error: { message: 'desearch/twitter-replies requires "user".' } });
          return;
        }
        result = await desearch.xUserReplies(params as any);
        break;
      }

      case 'desearch/twitter-post-replies': {
        if (!params.post_id) {
          res.status(400).json({ error: { message: 'desearch/twitter-post-replies requires "post_id".' } });
          return;
        }
        result = await desearch.xPostReplies(params as any);
        break;
      }

      case 'desearch/web': {
        if (!params.query) {
          res.status(400).json({ error: { message: 'desearch/web requires "query".' } });
          return;
        }
        result = await desearch.webSearch(params as any);
        break;
      }

      case 'desearch/web-crawl': {
        if (!params.url) {
          res.status(400).json({ error: { message: 'desearch/web-crawl requires "url".' } });
          return;
        }
        result = await desearch.webCrawl(params as any);
        break;
      }

      default:
        res.status(400).json({ error: { message: `Unknown model: ${modelId}` } });
        return;
    }
  } catch (error: any) {
    const msg = error?.message ?? String(error);
    console.error(`[desearch] API error for ${modelId}:`, msg);
    res.status(502).json({
      error: { message: `Desearch API error: ${msg.slice(0, 300)}` },
    });
    return;
  }

  // 8. Store voucher
  drainService.storeVoucher(voucher, validation.channel!, cost);
  const totalCharged = validation.channel!.totalCharged + cost;
  const remaining = validation.channel!.deposit - totalCharged;

  // 9. Respond in OpenAI chat completion format
  const content = JSON.stringify(result, null, 2);

  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  });

  res.json({
    id: `desearch-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil(content.length / 4),
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
    endpointsSupported: getSupportedModels().length,
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
    endpointsSupported: getSupportedModels(),
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Quick API connectivity check
  try {
    await desearch.webSearch({ query: 'test', start: 0 });
    console.log('[startup] Desearch API connection verified.');
  } catch (error: any) {
    console.warn(`[startup] WARNING: Desearch API check failed: ${error.message}`);
    console.warn('[startup] Continuing anyway — check DESEARCH_API_KEY if requests fail.');
  }

  drainService.startAutoClaim(
    config.autoClaimIntervalMinutes,
    config.autoClaimBufferSeconds,
  );

  app.listen(config.port, config.host, () => {
    const markup = Math.round((config.markupMultiplier - 1) * 100);
    console.log(`\nHS58-Desearch Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
    console.log(`Markup: ${markup}%`);
    console.log(`Endpoints: ${getSupportedModels().length} (${getSupportedModels().join(', ')})\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
