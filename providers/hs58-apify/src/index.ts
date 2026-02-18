/**
 * HS58-Apify Provider
 *
 * DRAIN payment gateway for Apify Actors.
 * Auto-loads popular Actors from Apify Store, auto-prices from API data.
 * Wraps Apify's task-based API behind OpenAI chat completions format.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, loadModels, getModelPricing, isModelSupported, getSupportedModels, getActor, getAllActors } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { ApifyService } from './apify.js';
import { formatUnits } from 'viem';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const apifyService = new ApifyService(config.apifyApiToken);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const modelId of getSupportedModels()) {
    const actor = getActor(modelId);
    const modelPricing = getModelPricing(modelId);
    if (actor && modelPricing) {
      const price = formatUnits(modelPricing.inputPer1k, 6);
      pricing[modelId] = {
        pricePerRun: price,
        inputPer1kTokens: price,
        outputPer1kTokens: '0',
        description: actor.description?.slice(0, 120) ?? '',
      };
    }
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'apify-actors',
    note: 'Prices are per Actor run (estimated ~10 results). Actual cost depends on results produced.',
    models: pricing,
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  const actors = getAllActors();
  const models = Array.from(actors.entries()).map(([actorId, actor]) => ({
    id: actorId,
    object: 'model',
    created: Date.now(),
    owned_by: actor.username,
    description: actor.title,
    pricing_model: actor.currentPricingInfo.pricingModel,
  }));

  res.json({ object: 'list', data: models });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const actorCount = getSupportedModels().length;
  const topActors = getSupportedModels().slice(0, 5).join(', ');

  res.type('text/plain').send(`# HS58-Apify Provider — Agent Instructions

This is NOT a chat provider. It runs Apify Actors (web scraping & data extraction).

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: Actor ID from /v1/models (e.g. "apify/web-scraper")
   - messages: ONE user message containing valid JSON = the Actor's input parameters

## Example

model: "apify/website-content-crawler"
messages: [{"role": "user", "content": "{\\"startUrls\\": [{\\"url\\": \\"https://example.com\\"}], \\"maxCrawlPages\\": 5}"}]

The response contains scraped data as JSON in the assistant message.

## Pricing

Flat rate per Actor run (not per token). Check /v1/pricing for current prices.

## Available Actors: ${actorCount}

Top: ${topActors}

Full list: /v1/models
Input schemas: https://apify.com/{actorId} (replace {actorId} with the model ID)
`);
});

/**
 * POST /v1/chat/completions
 *
 * Chat-wrapper for Apify Actors:
 * - model = actor ID (username/name)
 * - last user message = JSON actor input
 * - response = actor output as assistant message
 */
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
    res.status(402).json({
      error: { message: 'Invalid voucher format.' },
    });
    return;
  }

  // 3. Resolve actor
  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    const available = getSupportedModels().slice(0, 10).join(', ');
    res.status(400).json({
      error: { message: `Actor "${modelId}" not available. Try: ${available}` },
    });
    return;
  }

  const actor = getActor(modelId)!;
  const pricing = getModelPricing(modelId)!;
  const cost = pricing.inputPer1k; // flat rate per run

  // 4. Validate voucher covers cost
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

  // 5. Extract actor input from last user message
  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send actor input as JSON in the user message.' },
    });
    return;
  }

  let actorInput: object;
  try {
    actorInput = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON (the Actor input). ' +
          `Example for ${modelId}: Check the Actor's input schema at https://apify.com/${modelId}`,
      },
    });
    return;
  }

  // 6. Run the actor
  try {
    const result = await apifyService.runActor(modelId, actorInput, {
      maxTotalChargeUsd: actor.apifyBudget,
      maxWaitSecs: config.maxWait,
    });

    if (result.status === 'FAILED' || result.status === 'ABORTED') {
      res.status(502).json({
        error: { message: `Actor run ${result.status}. Try with different input or a smaller request.` },
      });
      return;
    }

    if (result.status === 'RUNNING') {
      res.status(504).json({
        error: { message: `Actor still running after ${config.maxWait}s. Try with smaller input (fewer URLs, lower maxCrawlPages, etc.)` },
      });
      return;
    }

    // 7. Get results
    let content: string;
    let itemCount = 0;
    let totalItems = 0;

    if (result.defaultDatasetId) {
      const dataset = await apifyService.getDatasetItems(result.defaultDatasetId, config.maxItems);
      itemCount = dataset.items.length;
      totalItems = dataset.total;

      const truncated = totalItems > itemCount
        ? `\n\n--- Showing ${itemCount} of ${totalItems} results. Run again for more. ---`
        : '';

      content = JSON.stringify(dataset.items, null, 2) + truncated;
    } else {
      content = result.output
        ? JSON.stringify(result.output, null, 2)
        : '{"message": "Actor completed but produced no output."}';
    }

    // 8. Store voucher with cost
    drainService.storeVoucher(voucher, validation.channel!, cost);

    const totalCharged = validation.channel!.totalCharged + cost;
    const remaining = validation.channel!.deposit - totalCharged;

    // 9. Send response in OpenAI format
    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `apify-${Date.now()}`,
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
        completion_tokens: itemCount,
        total_tokens: itemCount,
      },
    });

  } catch (error: any) {
    console.error(`[apify] Run error for ${modelId}:`, error.message);
    res.status(502).json({
      error: { message: `Actor execution failed: ${error.message?.slice(0, 200)}` },
    });
  }
});

/**
 * POST /v1/admin/claim
 */
app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/admin/stats
 */
app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  const actors = getAllActors();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    actorsLoaded: actors.size,
  });
});

/**
 * GET /v1/admin/vouchers
 */
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

/**
 * POST /v1/admin/refresh-actors
 */
app.post('/v1/admin/refresh-actors', async (_req, res) => {
  try {
    await loadModels(apifyService, config.actorLimit, config.markupMultiplier);
    const actors = getAllActors();
    res.json({ refreshed: true, actorsLoaded: actors.size });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  const actors = getAllActors();
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    actorsLoaded: actors.size,
    chainId: config.chainId,
  });
});

// --- Startup ---

async function start() {
  // Load actors from Apify Store
  await loadModels(apifyService, config.actorLimit, config.markupMultiplier);

  // Start auto-claiming expiring channels
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  // Refresh actor list every 6 hours
  setInterval(async () => {
    try {
      console.log('[refresh] Reloading actors from Apify Store...');
      await loadModels(apifyService, config.actorLimit, config.markupMultiplier);
    } catch (error) {
      console.error('[refresh] Failed to reload actors:', error);
    }
  }, 6 * 60 * 60 * 1000);

  app.listen(config.port, config.host, () => {
    console.log(`\nHS58-Apify Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Actors: ${getAllActors().size} loaded from Apify Store`);
    console.log(`Markup: ${(config.markupMultiplier - 1) * 100}%\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
