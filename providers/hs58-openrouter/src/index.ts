/**
 * HS58-OpenRouter Provider (with Groq Fast-Path)
 *
 * Routes requests to Groq first for supported models (ultra-low latency),
 * falls back to OpenRouter for everything else.
 */

import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import {
  loadConfig,
  updatePricingCache,
  getModelPricing,
  isModelSupported,
  getSupportedModels,
  getModelList,
  getPricingAge,
  calculateCost,
} from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { getPaymentHeaders } from './constants.js';
import { formatUnits } from 'viem';

// ---------------------------------------------------------------------------
// Groq fast-path config
// ---------------------------------------------------------------------------

// Models Groq supports natively — requests for these go to Groq first.
// Keys are the model IDs clients send; values are the Groq model names.
const GROQ_MODEL_MAP: Record<string, string> = {
  // Llama 3.3
  'meta-llama/llama-3.3-70b-instruct': 'llama-3.3-70b-versatile',
  'meta-llama/llama-3.3-70b-instruct:free': 'llama-3.3-70b-versatile',
  // Llama 3.1
  'meta-llama/llama-3.1-8b-instruct': 'llama-3.1-8b-instant',
  'meta-llama/llama-3.1-70b-instruct': 'llama-3.1-70b-versatile',
  // Llama 3
  'meta-llama/llama-3-8b-instruct': 'llama3-8b-8192',
  'meta-llama/llama-3-70b-instruct': 'llama3-70b-8192',
  // Mixtral
  'mistralai/mixtral-8x7b-instruct': 'mixtral-8x7b-32768',
  // Gemma
  'google/gemma-2-9b-it': 'gemma2-9b-it',
  'google/gemma-7b-it': 'gemma-7b-it',
  // DeepSeek R1 distill
  'deepseek/deepseek-r1-distill-llama-70b': 'deepseek-r1-distill-llama-70b',
  'deepseek/deepseek-r1-distill-qwen-32b': 'deepseek-r1-distill-qwen-32b',
  // Qwen
  'qwen/qwen-2.5-72b-instruct': 'qwen-qwq-32b',
  // Groq-exclusive fast models (advertised directly)
  'groq/llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
  'groq/llama-3.1-8b-instant': 'llama-3.1-8b-instant',
  'groq/mixtral-8x7b-32768': 'mixtral-8x7b-32768',
  'groq/gemma2-9b-it': 'gemma2-9b-it',
  'groq/deepseek-r1-distill-llama-70b': 'deepseek-r1-distill-llama-70b',
  'groq/qwen-qwq-32b': 'qwen-qwq-32b',
  'groq/llama-3.2-90b-vision-preview': 'llama-3.2-90b-vision-preview',
  'groq/llama-3.2-11b-vision-preview': 'llama-3.2-11b-vision-preview',
};

// Groq pricing per 1M tokens (USD) — used to calculate DRAIN cost
// These are Groq's public rates as of 2026-03
const GROQ_PRICING_USD: Record<string, { input: number; output: number }> = {
  'llama-3.3-70b-versatile':          { input: 0.59,  output: 0.79 },
  'llama-3.1-8b-instant':             { input: 0.05,  output: 0.08 },
  'llama-3.1-70b-versatile':          { input: 0.59,  output: 0.79 },
  'llama3-8b-8192':                   { input: 0.05,  output: 0.08 },
  'llama3-70b-8192':                  { input: 0.59,  output: 0.79 },
  'mixtral-8x7b-32768':               { input: 0.24,  output: 0.24 },
  'gemma2-9b-it':                     { input: 0.20,  output: 0.20 },
  'gemma-7b-it':                      { input: 0.07,  output: 0.07 },
  'deepseek-r1-distill-llama-70b':    { input: 0.75,  output: 0.99 },
  'deepseek-r1-distill-qwen-32b':     { input: 0.69,  output: 0.69 },
  'qwen-qwq-32b':                     { input: 0.29,  output: 0.39 },
  'llama-3.2-90b-vision-preview':     { input: 0.90,  output: 0.90 },
  'llama-3.2-11b-vision-preview':     { input: 0.18,  output: 0.18 },
};

function groqCostPerThousand(groqModel: string, markup: number): { inputPer1k: bigint; outputPer1k: bigint } {
  const p = GROQ_PRICING_USD[groqModel] ?? { input: 0.59, output: 0.79 };
  // per-token USD = p.input / 1_000_000
  // per-1k tokens USD = p.input / 1000
  // per-1k tokens USDC wei = (p.input / 1000) * 1_000_000 * markup
  const inputPer1k  = BigInt(Math.ceil((p.input  / 1000) * 1_000_000 * markup));
  const outputPer1k = BigInt(Math.ceil((p.output / 1000) * 1_000_000 * markup));
  return { inputPer1k, outputPer1k };
}

// ---------------------------------------------------------------------------
// Load config & init services
// ---------------------------------------------------------------------------

const config = loadConfig();
const groqApiKey = process.env.GROQ_API_KEY;

const storage     = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

// OpenRouter client (primary / fallback)
const openrouter = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://handshake58.com',
    'X-Title': config.providerName,
  },
});

// Groq client (fast-path — only if key is set)
const groq = groqApiKey
  ? new OpenAI({ apiKey: groqApiKey, baseURL: 'https://api.groq.com/openai/v1' })
  : null;

if (groq) {
  console.log('⚡ Groq fast-path enabled for', Object.keys(GROQ_MODEL_MAP).length, 'model aliases');
} else {
  console.warn('⚠️  GROQ_API_KEY not set — Groq fast-path disabled, using OpenRouter only');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /v1/docs
// ---------------------------------------------------------------------------
app.get('/v1/docs', (_req, res) => {
  const models    = getSupportedModels();
  const modelList = getModelList();
  const groqModels = Object.keys(GROQ_MODEL_MAP).filter(m => m.startsWith('groq/'));

  const topModels = models.slice(0, 10).map(m => {
    const p    = getModelPricing(m);
    const info = modelList.find(ml => ml.id === m);
    const name = info?.name ? ` (${info.name})` : '';
    return p
      ? `- ${m}${name}: $${formatUnits(p.inputPer1k, 6)} input / $${formatUnits(p.outputPer1k, 6)} output per 1k tokens`
      : `- ${m}${name}`;
  }).join('\n');

  const groqSection = groq
    ? `\n## ⚡ Groq Ultra-Fast Models (sub-100ms)\n\n${groqModels.map(m => `- ${m}`).join('\n')}\n\nThese models are routed to Groq's inference API for maximum speed.\n`
    : '';

  res.type('text/plain').send(`# ${config.providerName} — Agent Instructions

Meta-provider with ${models.length}+ models from OpenRouter${groq ? ` + ${groqModels.length} Groq ultra-fast models` : ''}.
Includes GPT-4o, Claude, Llama, Gemini, Mistral, DeepSeek, and more.
All accessible via a single DRAIN payment channel.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: any model ID from the list below
   - messages: standard chat messages array

## Example

model: "openai/gpt-4o"
messages: [{"role": "user", "content": "Explain quantum computing in simple terms"}]

Streaming is supported (stream: true).

## Top Models

${topModels}
${groqSection}
Full list: GET /v1/models
Full pricing: GET /v1/pricing
Filter pricing: GET /v1/pricing?filter=claude

## Pricing

Per-token pricing in USDC (${(config.markup - 1) * 100}% markup on upstream prices).
Input and output tokens are priced separately.
Cost = (input_tokens × input_rate + output_tokens × output_rate) / 1000.
Pricing auto-refreshes from the OpenRouter API.

## Notes

- Standard OpenAI chat completions format (messages, max_tokens, temperature, etc.)
- Streaming supported via stream: true
- Responses include X-DRAIN-Cost, X-DRAIN-Remaining headers
- OpenRouter model IDs use format: provider/model-name (e.g. "anthropic/claude-sonnet-4-20250514")
- Groq model IDs use format: groq/model-name (e.g. "groq/llama-3.3-70b-versatile")
- One payment channel gives access to all ${models.length}+ models
`);
});

// ---------------------------------------------------------------------------
// GET /v1/pricing
// ---------------------------------------------------------------------------
app.get('/v1/pricing', (req, res) => {
  const models  = getSupportedModels();
  const filter  = req.query.filter as string | undefined;
  const pricing: Record<string, { inputPer1kTokens: string; outputPer1kTokens: string; backend?: string }> = {};

  for (const model of models) {
    if (filter && !model.toLowerCase().includes(filter.toLowerCase())) continue;
    const p = getModelPricing(model);
    if (p) {
      pricing[model] = {
        inputPer1kTokens:  formatUnits(p.inputPer1k,  6),
        outputPer1kTokens: formatUnits(p.outputPer1k, 6),
      };
    }
  }

  // Add Groq-exclusive models
  if (groq) {
    for (const [alias, groqModel] of Object.entries(GROQ_MODEL_MAP)) {
      if (!alias.startsWith('groq/')) continue;
      if (filter && !alias.toLowerCase().includes(filter.toLowerCase())) continue;
      const p = groqCostPerThousand(groqModel, config.markup);
      pricing[alias] = {
        inputPer1kTokens:  formatUnits(p.inputPer1k,  6),
        outputPer1kTokens: formatUnits(p.outputPer1k, 6),
        backend: 'groq',
      };
    }
  }

  res.json({
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId:      config.chainId,
    currency:     'USDC',
    decimals:     6,
    markup:       `${(config.markup - 1) * 100}%`,
    totalModels:  models.length + (groq ? Object.keys(GROQ_MODEL_MAP).filter(m => m.startsWith('groq/')).length : 0),
    pricingAge:   `${getPricingAge()}s ago`,
    models:       pricing,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
app.get('/v1/models', (_req, res) => {
  const modelList = getModelList();

  const models = modelList.map(m => ({
    id:             m.id,
    object:         'model',
    created:        Date.now(),
    owned_by:       config.providerName.toLowerCase(),
    name:           m.name,
    context_length: m.context_length,
  }));

  // Append Groq-exclusive entries
  if (groq) {
    for (const alias of Object.keys(GROQ_MODEL_MAP).filter(m => m.startsWith('groq/'))) {
      models.push({
        id:             alias,
        object:         'model',
        created:        Date.now(),
        owned_by:       'groq',
        name:           alias.replace('groq/', '') + ' (Groq — ultra-fast)',
        context_length: 32768,
      });
    }
  }

  res.json({ object: 'list', data: models, total: models.length });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/refresh-pricing
// ---------------------------------------------------------------------------
app.post('/v1/admin/refresh-pricing', async (_req, res) => {
  try {
    await updatePricingCache(config.openrouterApiKey, config.markup, config.providerName);
    res.json({ success: true, models: getSupportedModels().length, refreshedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Refresh failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions  — DRAIN-gated, with Groq fast-path
// ---------------------------------------------------------------------------
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;

  if (!voucherHeader) {
    res.status(402).set(getPaymentHeaders(drainService.getProviderAddress(), config.chainId)).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
    return;
  }

  // Parse voucher
  let voucher: any;
  try {
    voucher = JSON.parse(Buffer.from(voucherHeader, 'base64').toString('utf-8'));
  } catch {
    res.status(400).json({ error: { message: 'Invalid X-DRAIN-Voucher: not valid base64 JSON', type: 'invalid_request_error', code: 'invalid_voucher' } });
    return;
  }

  const model: string = req.body.model;
  if (!model) {
    res.status(400).json({ error: { message: 'model field required', type: 'invalid_request_error', code: 'missing_model' } });
    return;
  }

  // Determine backend
  const groqModel = groq ? GROQ_MODEL_MAP[model] : undefined;
  const usingGroq  = !!groqModel;

  // Determine pricing
  let pricing: { inputPer1k: bigint; outputPer1k: bigint } | null = null;
  if (usingGroq) {
    pricing = groqCostPerThousand(groqModel!, config.markup);
  } else {
    pricing = getModelPricing(model);
    if (!pricing) {
      res.status(400).json({ error: { message: `Model '${model}' not supported. GET /v1/models for full list.`, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
  }

  // Validate channel
  let channelState: any;
  try {
    channelState = await drainService.getChannelState(voucher.channelId);
  } catch (e) {
    res.status(402).json({ error: { message: 'Channel not found or expired', type: 'payment_required', code: 'channel_not_found' } });
    return;
  }

  // Pre-flight voucher check (estimate 500 tokens output)
  const estimatedCost = calculateCost(pricing, req.body.messages?.reduce((n: number, m: any) => n + (m.content?.length ?? 0) / 4, 0) || 200, 500);
  const preValidation = await drainService.validateVoucher(voucher, estimatedCost);
  if (!preValidation.valid) {
    res.status(402).set({ 'X-DRAIN-Error': 'insufficient_funds', 'X-DRAIN-Required': estimatedCost.toString() }).json({
      error: { message: 'Insufficient channel balance', type: 'payment_required', code: 'insufficient_funds' },
    });
    return;
  }

  try {
    const stream: boolean = !!req.body.stream;

    if (stream) {
      // ── Streaming path ────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const client = usingGroq ? groq! : openrouter;
      const streamModel = usingGroq ? groqModel! : model;

      const streamResp = await client.chat.completions.create({
        model:      streamModel,
        messages:   req.body.messages,
        max_tokens: req.body.max_tokens,
        stream:     true,
      } as any);

      let inputTokens  = 0;
      let outputTokens = 0;

      for await (const chunk of streamResp as any) {
        if (chunk.usage) {
          inputTokens  = chunk.usage.prompt_tokens     ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Fallback token estimate if not provided
      if (outputTokens === 0) outputTokens = 200;

      const actualCost = calculateCost(pricing, inputTokens, outputTokens);
      const postValidation = await drainService.validateVoucher(voucher, actualCost);
      if (postValidation.valid) {
        drainService.storeVoucher(voucher, channelState, actualCost);
      }

      res.write('data: [DONE]\n\n');
      res.end();

    } else {
      // ── Non-streaming path ────────────────────────────────────────────────
      const client = usingGroq ? groq! : openrouter;
      const callModel = usingGroq ? groqModel! : model;

      const completion = await client.chat.completions.create({
        model:      callModel,
        messages:   req.body.messages,
        max_tokens: req.body.max_tokens,
      } as any);

      const inputTokens  = (completion as any).usage?.prompt_tokens     ?? 0;
      const outputTokens = (completion as any).usage?.completion_tokens ?? 0;
      const actualCost   = calculateCost(pricing, inputTokens, outputTokens);

      const actualValidation = await drainService.validateVoucher(voucher, actualCost);
      if (!actualValidation.valid) {
        res.status(402).set({ 'X-DRAIN-Error': 'insufficient_funds_post', 'X-DRAIN-Required': actualCost.toString() }).json({
          error: { message: 'Voucher insufficient for actual cost', type: 'payment_required', code: 'insufficient_funds_post' },
        });
        return;
      }

      drainService.storeVoucher(voucher, channelState, actualCost);

      const remaining = channelState.deposit - channelState.totalCharged - actualCost;

      res.set({
        'X-DRAIN-Cost':      actualCost.toString(),
        'X-DRAIN-Total':     (channelState.totalCharged + actualCost).toString(),
        'X-DRAIN-Remaining': remaining.toString(),
        'X-DRAIN-Channel':   voucher.channelId,
        'X-DRAIN-Backend':   usingGroq ? 'groq' : 'openrouter',
      }).json(completion);
    }

  } catch (error) {
    console.error(`[${usingGroq ? 'Groq' : 'OpenRouter'}] API error:`, error);

    // If Groq fails, retry on OpenRouter
    if (usingGroq) {
      console.warn('⚡ Groq failed — falling back to OpenRouter for', model);
      try {
        const orPricing = getModelPricing(model);
        const fallbackModel = model; // try original model on OpenRouter
        const completion = await openrouter.chat.completions.create({
          model:      fallbackModel,
          messages:   req.body.messages,
          max_tokens: req.body.max_tokens,
        } as any);

        const p2 = orPricing ?? pricing;
        const inputTokens  = (completion as any).usage?.prompt_tokens     ?? 0;
        const outputTokens = (completion as any).usage?.completion_tokens ?? 0;
        const actualCost   = calculateCost(p2, inputTokens, outputTokens);

        drainService.storeVoucher(voucher, channelState, actualCost);
        const remaining = channelState.deposit - channelState.totalCharged - actualCost;

        res.set({
          'X-DRAIN-Cost':      actualCost.toString(),
          'X-DRAIN-Remaining': remaining.toString(),
          'X-DRAIN-Backend':   'openrouter-fallback',
        }).json(completion);
        return;
      } catch (fallbackError) {
        console.error('OpenRouter fallback also failed:', fallbackError);
      }
    }

    const message = error instanceof Error ? error.message : 'API error';
    res.status(500).json({ error: { message, type: 'api_error', code: 'provider_error' } });
  }
});

// ---------------------------------------------------------------------------
// Admin & health endpoints (unchanged from original)
// ---------------------------------------------------------------------------

app.post('/v1/admin/claim', async (_req, res) => {
  try {
    const txHashes = await drainService.claimPayments(false);
    res.json({ success: true, claimed: txHashes.length, transactions: txHashes });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Claim failed' });
  }
});

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId:      config.chainId,
    ...stats,
    totalEarned:   formatUnits(stats.totalEarned, 6) + ' USDC',
    claimThreshold: formatUnits(config.claimThreshold, 6) + ' USDC',
    totalModels:   getSupportedModels().length,
    pricingAge:    `${getPricingAge()}s ago`,
    groqEnabled:   !!groq,
    groqModels:    groq ? Object.keys(GROQ_MODEL_MAP).length : 0,
  });
});

app.get('/v1/admin/vouchers', (_req, res) => {
  const highest = storage.getHighestVoucherPerChannel();
  res.json({
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    channels: Array.from(highest.entries()).map(([channelId, voucher]) => ({
      channelId,
      amount:     formatUnits(voucher.amount, 6) + ' USDC',
      amountRaw:  voucher.amount.toString(),
      nonce:      voucher.nonce.toString(),
      consumer:   voucher.consumer,
      claimed:    voucher.claimed,
      receivedAt: new Date(voucher.receivedAt).toISOString(),
    })),
  });
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    const result = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: result.finalAmount.toString(), signature: result.signature });
  } catch (error: any) {
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    models:       getSupportedModels().length,
    groqEnabled:  !!groq,
    groqModels:   groq ? Object.keys(GROQ_MODEL_MAP).length : 0,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  console.log(`🚀 Starting ${config.providerName} Provider...`);
  await updatePricingCache(config.openrouterApiKey, config.markup, config.providerName);

  setInterval(async () => {
    try { await updatePricingCache(config.openrouterApiKey, config.markup, config.providerName); }
    catch (e) { console.error('Failed to refresh pricing:', e); }
  }, config.pricingRefreshInterval);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║            ${config.providerName} Provider (+ Groq Fast-Path)         ║
╠═══════════════════════════════════════════════════════════════╣
║  Server:    http://${config.host}:${config.port}                              ║
║  Provider:  ${drainService.getProviderAddress()}  ║
║  Chain:     ${config.chainId === 137 ? 'Polygon Mainnet' : 'Polygon Amoy (Testnet)'}                          ║
║  Models:    ${getSupportedModels().length} OpenRouter + ${Object.keys(GROQ_MODEL_MAP).length} Groq aliases          ║
║  Markup:    ${(config.markup - 1) * 100}% on upstream prices                       ║
║  Groq:      ${groq ? '⚡ ENABLED' : '❌ disabled (set GROQ_API_KEY)'}                              ║
║  Auto-claim: Every ${config.autoClaimIntervalMinutes} min, buffer ${config.autoClaimBufferSeconds}s            ║
╚═══════════════════════════════════════════════════════════════╝
`);
  });
}

main().catch(console.error);
