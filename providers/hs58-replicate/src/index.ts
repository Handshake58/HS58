/**
 * HS58-Replicate Provider
 *
 * DRAIN payment gateway for Replicate.com.
 * Auto-curated model registry from Replicate collections.
 * Supports image, video, audio, LLM, 3D and more.
 */

import express from 'express';
import cors from 'cors';
import { formatUnits } from 'viem';
import { loadConfig } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { ReplicateClient } from './replicate.js';
import { ModelRegistry } from './registry.js';
import { PRICING_TIERS } from './constants.js';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const replicateClient = new ReplicateClient(
  config.replicateApiToken,
  config.predictionPollIntervalMs,
  config.maxPredictionTimeoutMs,
);
const registry = new ModelRegistry(
  replicateClient,
  config.syncCollections,
  config.registryPath,
  config.markupPercent,
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// --- Helper: parse model ID ---
function parseModelId(modelId: string): { owner: string; name: string } | null {
  const id = modelId.replace(/^replicate\//, '');
  const parts = id.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

// --- Helper: parse user input into Replicate input object ---
function parseUserInput(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON
  }
  return { prompt: content };
}

// --- Helper: format Replicate output for chat response ---
function formatOutput(output: unknown): string {
  if (output === null || output === undefined) return 'No output';
  if (typeof output === 'string') return output;

  if (Array.isArray(output)) {
    const items = output.map(item => typeof item === 'string' ? item : JSON.stringify(item));
    if (items.every(item => item.startsWith('http'))) {
      return items.map((url, i) => `[Output ${i + 1}](${url})\n${url}`).join('\n\n');
    }
    return items.join('\n');
  }

  return JSON.stringify(output, null, 2);
}

// ========== ENDPOINTS ==========

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const { models: allModels } = registry.listModels({ limit: 10000 });

  const models: Record<string, {
    pricing: { inputPer1k: string; outputPer1k: string };
    tier: string;
    description: string;
  }> = {};

  for (const m of allModels) {
    const cost = registry.getModelCost(m.owner, m.name);
    models[`replicate/${m.id}`] = {
      pricing: {
        inputPer1k: cost.toString(),
        outputPer1k: cost.toString(),
      },
      tier: m.pricingTier,
      description: m.description.slice(0, 120),
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'multi-modal-gateway',
    note: 'Replicate gateway with auto-curated models. Prices vary by category tier.',
    markup: `${config.markupPercent}%`,
    models,
    modelCount: Object.keys(models).length,
  });
});

/**
 * GET /v1/models -- List registered models (paginated, filterable)
 */
app.get('/v1/models', (req, res) => {
  const collection = req.query.collection as string | undefined;
  const search = req.query.search as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  if (search) {
    const results = registry.searchModels(search, limit);
    res.json({
      object: 'list',
      data: results.map(m => ({
        id: `replicate/${m.id}`,
        object: 'model',
        owned_by: m.owner,
        description: m.description,
        pricing_tier: m.pricingTier,
        price_usdc: formatUnits(registry.getModelCost(m.owner, m.name), 6),
        collections: m.collections,
        run_count: m.runCount,
        cover_image_url: m.coverImageUrl,
      })),
      total: results.length,
    });
    return;
  }

  const { models, total } = registry.listModels({ collection, limit, offset });

  res.json({
    object: 'list',
    data: models.map(m => ({
      id: `replicate/${m.id}`,
      object: 'model',
      owned_by: m.owner,
      description: m.description,
      pricing_tier: m.pricingTier,
      price_usdc: formatUnits(registry.getModelCost(m.owner, m.name), 6),
      collections: m.collections,
      run_count: m.runCount,
      cover_image_url: m.coverImageUrl,
    })),
    total,
    offset,
    limit,
  });
});

/**
 * GET /v1/models/:owner/:name -- Model detail with input/output schema
 */
app.get('/v1/models/:owner/:name', async (req, res) => {
  const { owner, name } = req.params;
  const registeredModel = registry.getModel(owner, name);

  try {
    const schema = await replicateClient.getModelSchema(owner, name);

    res.json({
      id: `replicate/${owner}/${name}`,
      owner,
      name,
      description: registeredModel?.description ?? '',
      pricing_tier: registeredModel?.pricingTier ?? 'utility',
      price_usdc: formatUnits(registry.getModelCost(owner, name), 6),
      collections: registeredModel?.collections ?? [],
      run_count: registeredModel?.runCount ?? 0,
      inputSchema: schema.input,
      outputSchema: schema.output,
      registered: !!registeredModel,
    });
  } catch (error: any) {
    res.status(404).json({
      error: { message: `Model ${owner}/${name} not found: ${error.message}` },
    });
  }
});

/**
 * GET /v1/collections -- Available collections
 */
app.get('/v1/collections', (_req, res) => {
  const collections = registry.getCollections();
  res.json({
    object: 'list',
    data: collections.map(c => ({
      slug: c.slug,
      pricing_tier: c.tier,
      price_usdc: formatUnits(
        BigInt(Math.ceil(PRICING_TIERS[c.tier].priceUsdc * (1 + config.markupPercent / 100) * 1_000_000)),
        6,
      ),
      model_count: c.modelCount,
    })),
  });
});

/**
 * GET /v1/docs -- Agent instructions
 */
app.get('/v1/docs', (_req, res) => {
  res.type('text/plain').send(`# Replicate Gateway — Agent Instructions

This provider is a gateway to 300+ AI models on Replicate: image generation, video, audio, LLMs, 3D, and more.

## Quick Start

model: "replicate/black-forest-labs/flux-dev"
messages: [{"role": "user", "content": "A cat riding a bicycle in space, digital art"}]

That's it. For most models, just send a text prompt.

## Recommended Models

### Image Generation
- replicate/black-forest-labs/flux-dev — $${formatUnits(registry.getModelCost('black-forest-labs', 'flux-dev'), 6)} USDC
- replicate/black-forest-labs/flux-schnell — fast, cheaper
- replicate/ideogram-ai/ideogram-v2a — great text rendering

### Video Generation
- replicate/wavespeedai/wan-2.1-t2v-480p — text to video
- replicate/wavespeedai/wan-2.1-i2v-480p — image to video (send {"image": "https://...", "prompt": "..."})

### Language Models
- replicate/meta/llama-4-maverick-instruct — Llama 4
- replicate/deepseek-ai/deepseek-r1 — reasoning model

### Audio
- replicate/openai/whisper — speech to text (send {"audio": "https://..."})

### Image Editing
- replicate/zsyoaoa/invsr — super resolution (send {"image": "https://..."})

## How to Use

1. Browse models: GET /v1/models?collection=text-to-image
2. Get input schema: GET /v1/models/{owner}/{name}
3. Run: POST /v1/chat/completions with model + messages

## Input Format

**Simple (prompt-based):** Just send text as the user message content.
**Complex (multi-input):** Send a JSON object as the user message content:
  {"image": "https://example.com/photo.jpg", "prompt": "make it anime style", "num_outputs": 2}

The input schema (GET /v1/models/{owner}/{name}) tells you exactly which fields are available.

## Pricing

Prices vary by category:
${Object.entries(PRICING_TIERS).map(([tier, cfg]) => {
    const price = cfg.priceUsdc * (1 + config.markupPercent / 100);
    return `- ${tier}: $${price.toFixed(4)} USDC per run — ${cfg.description}`;
  }).join('\n')}

## Response

Output varies by model type:
- Image models: URLs to generated images
- Video models: URLs to generated videos
- LLMs: Generated text
- Audio models: Transcribed text or audio URLs
`);
});

/**
 * POST /v1/chat/completions -- Run a prediction with DRAIN payment
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
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
  if (!modelId) {
    res.status(400).json({ error: { message: 'model field is required. Use format: replicate/{owner}/{name}' } });
    return;
  }

  const parsed = parseModelId(modelId);
  if (!parsed) {
    res.status(400).json({
      error: { message: `Invalid model format "${modelId}". Use: replicate/{owner}/{name} (e.g. replicate/black-forest-labs/flux-dev)` },
    });
    return;
  }

  const cost = registry.getModelCost(parsed.owner, parsed.name);

  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${validation.error}` },
      ...(validation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content?.trim()) {
    res.status(400).json({ error: { message: 'No input provided. Send the prompt or input JSON as the user message.' } });
    return;
  }

  const input = parseUserInput(lastUserMsg.content.trim());

  try {
    const prediction = await replicateClient.runPrediction(parsed.owner, parsed.name, input);

    if (prediction.status === 'failed') {
      res.status(502).json({
        error: { message: `Replicate prediction failed: ${prediction.error ?? 'unknown error'}` },
      });
      return;
    }

    if (prediction.status === 'canceled') {
      res.status(502).json({ error: { message: 'Prediction was canceled.' } });
      return;
    }

    drainService.storeVoucher(voucher, validation.channel!, cost);

    const totalCharged = validation.channel!.totalCharged + cost;
    const remaining = validation.channel!.deposit - totalCharged;

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    const outputContent = formatOutput(prediction.output);
    const tier = registry.getModelTier(parsed.owner, parsed.name);

    res.json({
      id: `replicate-${prediction.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: outputContent },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: prediction.metrics?.input_token_count ?? 1,
        completion_tokens: prediction.metrics?.output_token_count ?? 1,
        total_tokens: (prediction.metrics?.input_token_count ?? 1) + (prediction.metrics?.output_token_count ?? 1),
      },
      replicate_metadata: {
        prediction_id: prediction.id,
        predict_time: prediction.metrics?.predict_time,
        pricing_tier: tier,
        model: `${parsed.owner}/${parsed.name}`,
      },
    });

  } catch (error: any) {
    console.error(`[replicate] Prediction error:`, error.message);

    if (error.name === 'TimeoutError' || error.message?.includes('did not complete')) {
      res.status(504).json({
        error: { message: 'Prediction timed out. The model may be cold-starting or under heavy load.' },
      });
      return;
    }

    res.status(502).json({
      error: { message: `Prediction failed: ${error.message?.slice(0, 200)}` },
    });
  }
});

// ========== ADMIN ENDPOINTS ==========

app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    modelCount: registry.getModelCount(),
    collections: registry.getCollections().length,
  });
});

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

app.post('/v1/admin/sync', async (_req, res) => {
  try {
    const count = await registry.syncAll();
    res.json({ synced: true, modelCount: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    modelCount: registry.getModelCount(),
  });
});

// ========== STARTUP ==========

async function start() {
  console.log('[startup] Syncing model registry from Replicate...');
  await registry.syncAll();

  registry.startPeriodicSync(config.syncIntervalHours);
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\nHS58-Replicate Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Models: ${registry.getModelCount()} (auto-sync every ${config.syncIntervalHours}h)`);
    console.log(`Markup: ${config.markupPercent}%\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
