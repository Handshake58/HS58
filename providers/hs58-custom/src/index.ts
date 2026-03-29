/**
 * HS58-Custom Provider
 * Generic DRAIN payment proxy for any OpenAI-compatible API endpoint.
 * Works with Ollama, vLLM, Together, Fireworks, LiteLLM, and more.
 */

import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { loadConfig, calculateCost, getModelPricing, isModelSupported, getSupportedModels, loadModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { getPaymentHeaders } from './constants.js';
import { formatUnits } from 'viem';

// Load configuration
const config = loadConfig();

// Initialize services
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

// OpenAI-compatible client with custom base URL
const client = new OpenAI({
  apiKey: config.apiKey || 'not-needed',  // Some local endpoints don't require a key
  baseURL: config.apiBaseUrl,
});

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const models = getSupportedModels();
  const topModels = models.slice(0, 8).map(m => {
    const p = getModelPricing(m);
    return p
      ? `- ${m}: $${formatUnits(p.inputPer1k, 6)} input / $${formatUnits(p.outputPer1k, 6)} output per 1k tokens`
      : `- ${m}`;
  }).join('\n');

  res.type('text/plain').send(`# ${config.providerName} — Agent Instructions

Custom LLM provider wrapping any OpenAI-compatible backend (Ollama, vLLM, Together, Fireworks, LiteLLM, etc.).
Upstream API: ${config.apiBaseUrl}
Supports ${models.length} models with per-token pricing via DRAIN payments.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: any model ID from the list below
   - messages: standard chat messages array

## Example

model: "${models[0] || 'llama3'}"
messages: [{"role": "user", "content": "Explain quantum computing in simple terms"}]

Streaming is supported (stream: true).

## Available Models

${topModels}

Full list: GET /v1/models
Full pricing: GET /v1/pricing

## Pricing

Per-token pricing in USDC (${(config.markup - 1) * 100}% markup).
Input and output tokens are priced separately.
Cost = (input_tokens × input_rate + output_tokens × output_rate) / 1000.

## Notes

- Standard OpenAI chat completions format (messages, max_tokens, temperature, etc.)
- Streaming supported via stream: true
- Responses include X-DRAIN-Cost, X-DRAIN-Remaining headers
- Model availability depends on the upstream backend configuration
`);
});

/**
 * GET /v1/pricing
 * Returns pricing information for all models
 */
app.get('/v1/pricing', (req, res) => {
  const pricing: Record<string, { inputPer1kTokens: string; outputPer1kTokens: string }> = {};
  
  for (const model of getSupportedModels()) {
    const modelPricing = getModelPricing(model);
    if (modelPricing) {
      pricing[model] = {
        inputPer1kTokens: formatUnits(modelPricing.inputPer1k, 6),
        outputPer1kTokens: formatUnits(modelPricing.outputPer1k, 6),
      };
    }
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    markup: `${(config.markup - 1) * 100}%`,
    models: pricing,
  });
});

/**
 * GET /v1/models
 * OpenAI-compatible models endpoint
 */
app.get('/v1/models', (req, res) => {
  const models = getSupportedModels().map(id => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: config.providerName.toLowerCase(),
  }));

  res.json({
    object: 'list',
    data: models,
  });
});

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat endpoint with DRAIN payments
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  
  // 1. Check voucher header present
  if (!voucherHeader) {
    res.status(402).set(getPaymentHeaders(drainService.getProviderAddress(), config.chainId)).json({
      error: {
        message: 'X-DRAIN-Voucher header required',
        type: 'payment_required',
        code: 'voucher_required',
      },
    });
    return;
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).set({
      'X-DRAIN-Error': 'invalid_voucher_format',
    }).json({
      error: {
        message: 'Invalid X-DRAIN-Voucher format',
        type: 'payment_required',
        code: 'invalid_voucher_format',
      },
    });
    return;
  }

  // 3. Check model supported
  const model = req.body.model as string;
  if (!isModelSupported(model)) {
    res.status(400).json({
      error: {
        message: `Model '${model}' not supported. Available: ${getSupportedModels().join(', ')}`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
      },
    });
    return;
  }

  const pricing = getModelPricing(model)!;
  const isStreaming = req.body.stream === true;

  // 4. Pre-auth check: estimate minimum cost
  const estimatedInputTokens = JSON.stringify(req.body.messages).length / 4;
  const minOutputTokens = 50;
  const estimatedMinCost = calculateCost(pricing, Math.ceil(estimatedInputTokens), minOutputTokens);

  // 5. Validate voucher with estimated cost
  const validation = await drainService.validateVoucher(voucher, estimatedMinCost);
  
  if (!validation.valid) {
    const errorHeaders: Record<string, string> = {
      'X-DRAIN-Error': validation.error!,
    };
    
    if (validation.error === 'insufficient_funds' && validation.channel) {
      errorHeaders['X-DRAIN-Required'] = estimatedMinCost.toString();
      errorHeaders['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    
    res.status(402).set(errorHeaders).json({
      error: {
        message: `Payment validation failed: ${validation.error}`,
        type: 'payment_required',
        code: validation.error,
      },
    });
    return;
  }

  const channelState = validation.channel!;

  try {
    if (isStreaming) {
      // === STREAMING RESPONSE ===
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-DRAIN-Channel', voucher.channelId);

      let inputTokens = 0;
      let outputTokens = 0;
      let fullContent = '';

      const stream = await client.chat.completions.create({
        model: model,
        messages: req.body.messages,
        max_tokens: req.body.max_tokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        
        // Forward chunk as-is (OpenAI-compatible format)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        // Track usage if available
        if ((chunk as any).usage) {
          inputTokens = (chunk as any).usage.prompt_tokens || 0;
          outputTokens = (chunk as any).usage.completion_tokens || 0;
        }
      }

      // Estimate tokens if not provided by upstream
      if (inputTokens === 0) {
        inputTokens = Math.ceil(JSON.stringify(req.body.messages).length / 4);
      }
      if (outputTokens === 0) {
        outputTokens = Math.ceil(fullContent.length / 4);
      }

      // Calculate final cost
      const actualCost = calculateCost(pricing, inputTokens, outputTokens);
      
      // Store voucher with actual cost
      drainService.storeVoucher(voucher, channelState, actualCost);

      // Send cost info
      const remaining = channelState.deposit - channelState.totalCharged;
      res.write(`data: [DONE]\n\n`);
      res.write(`: X-DRAIN-Cost: ${actualCost.toString()}\n`);
      res.write(`: X-DRAIN-Total: ${channelState.totalCharged.toString()}\n`);
      res.write(`: X-DRAIN-Remaining: ${remaining.toString()}\n`);
      
      res.end();

    } else {
      // === NON-STREAMING RESPONSE ===
      const completion = await client.chat.completions.create({
        model: model,
        messages: req.body.messages,
        max_tokens: req.body.max_tokens,
      });

      // Get actual token counts
      const inputTokens = completion.usage?.prompt_tokens ?? 0;
      const outputTokens = completion.usage?.completion_tokens ?? 0;

      // Calculate actual cost
      const actualCost = calculateCost(pricing, inputTokens, outputTokens);

      // Verify voucher covers actual cost
      const actualValidation = await drainService.validateVoucher(voucher, actualCost);
      
      if (!actualValidation.valid) {
        res.status(402).set({
          'X-DRAIN-Error': 'insufficient_funds_post',
          'X-DRAIN-Required': actualCost.toString(),
        }).json({
          error: {
            message: 'Voucher insufficient for actual cost',
            type: 'payment_required',
            code: 'insufficient_funds_post',
          },
        });
        return;
      }

      // Store voucher
      drainService.storeVoucher(voucher, channelState, actualCost);

      // Calculate remaining
      const remaining = channelState.deposit - channelState.totalCharged;

      // Send response (OpenAI-compatible format)
      res.set({
        'X-DRAIN-Cost': actualCost.toString(),
        'X-DRAIN-Total': channelState.totalCharged.toString(),
        'X-DRAIN-Remaining': remaining.toString(),
        'X-DRAIN-Channel': voucher.channelId,
      }).json(completion);
    }
  } catch (error) {
    console.error('Upstream API error:', error);
    
    const message = error instanceof Error ? error.message : 'Upstream API error';
    res.status(500).json({
      error: {
        message,
        type: 'api_error',
        code: 'upstream_error',
      },
    });
  }
});

/**
 * POST /v1/admin/claim
 * Trigger payment claims
 */
app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.query.force === 'true';
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({
      success: true,
      claimed: txHashes.length,
      transactions: txHashes,
      forced: forceAll,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Claim failed',
    });
  }
});

/**
 * GET /v1/admin/stats
 * Get provider statistics
 */
app.get('/v1/admin/stats', (req, res) => {
  const stats = storage.getStats();
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    ...stats,
    totalEarned: formatUnits(stats.totalEarned, 6) + ' USDC',
    claimThreshold: formatUnits(config.claimThreshold, 6) + ' USDC',
  });
});

/**
 * GET /v1/admin/vouchers
 * Get pending vouchers
 */
app.get('/v1/admin/vouchers', (req, res) => {
  const unclaimed = storage.getUnclaimedVouchers();
  const highest = storage.getHighestVoucherPerChannel();
  
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    unclaimedCount: unclaimed.length,
    channels: Array.from(highest.entries()).map(([channelId, voucher]) => ({
      channelId,
      amount: formatUnits(voucher.amount, 6) + ' USDC',
      amountRaw: voucher.amount.toString(),
      nonce: voucher.nonce.toString(),
      consumer: voucher.consumer,
      claimed: voucher.claimed,
      receivedAt: new Date(voucher.receivedAt).toISOString(),
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

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    apiBaseUrl: config.apiBaseUrl,
  });
});

// Start server
async function start() {
  loadModels(config.markup);
  
  // Start auto-claim
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);
  
  app.listen(config.port, config.host, () => {
    console.log(`${config.providerName} | ${getSupportedModels().length} models | ${(config.markup - 1) * 100}% markup | http://${config.host}:${config.port}`);
    console.log(`Upstream API: ${config.apiBaseUrl}`);
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min, buffer ${config.autoClaimBufferSeconds}s`);
  });
}

start().catch(e => { console.error('❌', e.message); process.exit(1); });
