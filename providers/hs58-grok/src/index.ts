/**
 * HS58-Grok Provider
 * Minimal, no-bloat DRAIN payment proxy for xAI Grok.
 */

import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { loadConfig, calculateCost, getModelPricing, isModelSupported, getSupportedModels, loadModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';

// Load configuration
const config = loadConfig();

// Initialize services
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

// xAI uses OpenAI-compatible API
const xai = new OpenAI({
  apiKey: config.xaiApiKey,
  baseURL: 'https://api.x.ai/v1',
});

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

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
    res.status(402).set({
      'X-DRAIN-Error': 'voucher_required',
    }).json({
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

      const stream = await xai.chat.completions.create({
        model: model,
        messages: req.body.messages,
        max_tokens: req.body.max_tokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        
        // Forward chunk as-is (already OpenAI format)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        // Track usage if available
        if ((chunk as any).usage) {
          inputTokens = (chunk as any).usage.prompt_tokens || 0;
          outputTokens = (chunk as any).usage.completion_tokens || 0;
        }
      }

      // Estimate tokens if not provided
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
      const remaining = channelState.deposit - channelState.totalCharged - actualCost;
      res.write(`data: [DONE]\n\n`);
      res.write(`: X-DRAIN-Cost: ${actualCost.toString()}\n`);
      res.write(`: X-DRAIN-Total: ${(channelState.totalCharged + actualCost).toString()}\n`);
      res.write(`: X-DRAIN-Remaining: ${remaining.toString()}\n`);
      
      res.end();

    } else {
      // === NON-STREAMING RESPONSE ===
      const completion = await xai.chat.completions.create({
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
      const remaining = channelState.deposit - channelState.totalCharged - actualCost;

      // Send response (already OpenAI format)
      res.set({
        'X-DRAIN-Cost': actualCost.toString(),
        'X-DRAIN-Total': (channelState.totalCharged + actualCost).toString(),
        'X-DRAIN-Remaining': remaining.toString(),
        'X-DRAIN-Channel': voucher.channelId,
      }).json(completion);
    }
  } catch (error) {
    console.error('xAI API error:', error);
    
    const message = error instanceof Error ? error.message : 'xAI API error';
    res.status(500).json({
      error: {
        message,
        type: 'api_error',
        code: 'xai_error',
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

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

/**
 * POST /v1/admin/refresh-models
 * Refresh models from API + Marketplace pricing
 */
app.post('/v1/admin/refresh-models', async (req, res) => {
  try {
    await loadModels(config.xaiApiKey, config.markup, config.marketplaceUrl);
    res.json({ success: true, models: getSupportedModels().length });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
async function start() {
  await loadModels(config.xaiApiKey, config.markup, config.marketplaceUrl);
  
  // Start auto-claim: check every 10 min, claim channels expiring within 1 hour
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);
  
  app.listen(config.port, config.host, () => {
    console.log(`${config.providerName} | ${getSupportedModels().length} models | ${(config.markup - 1) * 100}% markup | http://${config.host}:${config.port}`);
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min for expiring channels`);
  });
}

start().catch(e => { console.error('❌', e.message); process.exit(1); });
