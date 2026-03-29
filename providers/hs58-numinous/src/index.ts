/**
 * HS58-Numinous Provider
 *
 * DRAIN payment gateway for Numinous Forecasting.
 * Submits prediction jobs, polls for results, and returns
 * probabilistic forecasts from the world's best forecasting agents.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, getModelId, getModelPricing, getRequestCost } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { NuminousService } from './numinous.js';
import { formatUnits } from 'viem';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const numinousService = new NuminousService(
  config.numinousApiUrl,
  config.numinousApiKey,
  config.numinousPollIntervalMs,
  config.numinousPollTimeoutMs,
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricing = getModelPricing();
  const price = formatUnits(pricing.inputPer1k, 6);

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'forecasting-engine',
    note: 'Flat rate per forecast request. Each query is processed by top forecasting agents on the Numinous network.',
    models: {
      [getModelId()]: {
        pricePerRun: price,
        inputPer1kTokens: price,
        outputPer1kTokens: '0',
        description: 'Numinous Forecaster — probabilistic predictions from top forecasting agents',
      },
    },
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: getModelId(),
      object: 'model',
      created: Date.now(),
      owned_by: 'numinous',
      description: 'Numinous Forecaster — probabilistic predictions powered by the world\'s best forecasting agents',
    }],
  });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const price = formatUnits(getRequestCost(), 6);

  res.type('text/plain').send(`# Numinous Forecaster — Agent Instructions

This provider returns probabilistic forecasts for future events. It is NOT a chat/LLM provider.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "${getModelId()}"
   - messages: ONE user message containing the question to forecast

## Input Formats

### Query Mode (simple)
Send a natural language question as plain text:

messages: [{"role": "user", "content": "Will Bitcoin exceed $150,000 before March 31, 2026?"}]

### Structured Mode (precise)
Send a JSON object with title, description, cutoff, and optional topics:

messages: [{"role": "user", "content": "{\\"title\\": \\"Will Bitcoin exceed $150,000 before March 31, 2026?\\", \\"description\\": \\"Resolves YES if BTC spot price on any major exchange exceeds $150,000 USD before 2026-03-31T23:59:59Z.\\", \\"cutoff\\": \\"2026-03-31T23:59:59Z\\", \\"topics\\": [\\"crypto\\", \\"finance\\"]}"}]

## Response

The assistant message contains a JSON object with:
- prediction_id: unique job identifier
- prediction: probability between 0.0 and 1.0 (e.g. 0.72 = 72% YES)
- forecaster_name: which forecaster produced the result
- metadata: includes reasoning, event details, miner info
- status: COMPLETED

## Pricing

$${price} USDC per forecast (flat rate).

## Important

- Response time is typically 30-120 seconds (forecasters compute asynchronously)
- Maximum wait time is ~4 minutes
- Send ONE question per request
- The question should be about a future event with a clear yes/no resolution
`);
});

/**
 * POST /v1/chat/completions
 *
 * Forecasting wrapper:
 * - model = "numinous/forecaster"
 * - last user message = question to forecast (plain text or structured JSON)
 * - response = forecast result as assistant message
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({
      error: { message: 'Payment required. Include X-DRAIN-Voucher header.' },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({
      error: { message: 'Invalid voucher format.' },
    });
    return;
  }

  const modelId = req.body.model as string;
  if (modelId && modelId !== getModelId()) {
    res.status(400).json({
      error: { message: `Unknown model "${modelId}". Use "${getModelId()}".` },
    });
    return;
  }

  const cost = getRequestCost();

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

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content?.trim()) {
    res.status(400).json({
      error: { message: 'No question provided. Send the forecasting question as plain text or structured JSON in the user message.' },
    });
    return;
  }

  const userInput = lastUserMsg.content.trim();
  const payload = NuminousService.parseUserInput(userInput);

  try {
    const result = await numinousService.forecast(payload);

    drainService.storeVoucher(voucher, validation.channel!, cost);

    const totalCharged = validation.channel!.totalCharged;
    const remaining = validation.channel!.deposit - totalCharged;

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    const prediction = result.result!.prediction;
    const reasoning = result.result!.metadata?.reasoning ?? '';
    const forecasterName = result.result!.forecaster_name;

    const summary = [
      `**Prediction: ${(prediction * 100).toFixed(1)}% probability**`,
      '',
      `Forecaster: ${forecasterName}`,
      reasoning ? `Reasoning: ${reasoning}` : '',
      '',
      '---',
      'Full result:',
      JSON.stringify(result, null, 2),
    ].filter(Boolean).join('\n');

    res.json({
      id: `numinous-${result.prediction_id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: getModelId(),
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: summary,
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });

  } catch (error: any) {
    console.error(`[numinous] Forecast error:`, error.message);

    if (error.name === 'TimeoutError' || error.message?.includes('timeout') || error.message?.includes('did not complete')) {
      res.status(504).json({
        error: { message: 'Numinous forecast timed out. Forecasters may be under heavy load — try again.' },
      });
      return;
    }

    res.status(502).json({
      error: { message: `Forecast failed: ${error.message?.slice(0, 200)}` },
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
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    model: getModelId(),
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
 * POST /v1/close-channel
 */
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
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    model: getModelId(),
    chainId: config.chainId,
  });
});

// --- Startup ---

async function start() {
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\nHS58-Numinous Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Model: ${getModelId()}`);
    console.log(`Price: $${config.pricePerRequestUsdc} USDC per forecast\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
