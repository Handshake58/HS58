/**
 * HS58-Vericore Provider
 *
 * DRAIN payment gateway for Vericore Claim Analyzer.
 * Verifies claims against live web evidence and returns
 * support/contradiction/neutral scores.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, getModelId, getModelPricing, getRequestCost } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { VericoreService } from './vericore.js';
import { formatUnits } from 'viem';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const vericoreService = new VericoreService(
  config.vericoreApiUrl,
  config.vericoreApiKey,
  config.vericoreTimeoutMs,
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
    type: 'verification-engine',
    note: 'Flat rate per verification request. Each claim is checked against live web evidence.',
    models: {
      [getModelId()]: {
        pricePerRun: price,
        inputPer1kTokens: price,
        outputPer1kTokens: '0',
        description: 'Vericore Claim Analyzer — verifies statements against live web evidence',
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
      owned_by: 'vericore',
      description: 'Vericore Claim Analyzer — parallel verification against live web evidence',
    }],
  });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const price = formatUnits(getRequestCost(), 6);

  res.type('text/plain').send(`# Vericore Claim Analyzer — Agent Instructions

This provider verifies claims against live web evidence. It is NOT a chat/LLM provider.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "${getModelId()}"
   - messages: ONE user message containing the claim to verify (plain text)

## Example

model: "${getModelId()}"
messages: [{"role": "user", "content": "The Earth is round"}]

## Response

The assistant message contains a JSON object with:
- batch_id, request_id: tracking identifiers
- evidence_summary: aggregated scores
  - entailment: % of evidence supporting the claim
  - contradiction: % of evidence contradicting the claim
  - neutral: % of neutral coverage
  - sentiment, conviction, source_credibility, narrative_momentum
  - statements[]: individual evidence items with per-source scores and URLs

## Pricing

$${price} USDC per verification (flat rate).

## Important

- Response time is ~20-30 seconds (web evidence is gathered in real-time)
- Send ONE claim per request as plain text
- The claim should be a verifiable factual statement
`);
});

/**
 * POST /v1/chat/completions
 *
 * Verification wrapper:
 * - model = "vericore/claim-analyzer"
 * - last user message = plain-text claim to verify
 * - response = verification result as assistant message
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
      error: { message: 'No claim provided. Send the statement to verify as plain text in the user message.' },
    });
    return;
  }

  const statement = lastUserMsg.content.trim();

  try {
    const result = await vericoreService.analyzeStatement(statement);

    drainService.storeVoucher(voucher, validation.channel!, cost);

    const totalCharged = validation.channel!.totalCharged;
    const remaining = validation.channel!.deposit - totalCharged;

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `vericore-${result.request_id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: getModelId(),
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(result, null, 2),
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: result.evidence_summary.total_count,
        total_tokens: result.evidence_summary.total_count + 1,
      },
    });

  } catch (error: any) {
    console.error(`[vericore] Analysis error:`, error.message);

    if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
      res.status(504).json({
        error: { message: 'Vericore analysis timed out. Try again or use a shorter statement.' },
      });
      return;
    }

    res.status(502).json({
      error: { message: `Verification failed: ${error.message?.slice(0, 200)}` },
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
    console.log(`\nHS58-Vericore Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Model: ${getModelId()}`);
    console.log(`Price: $${config.pricePerRequestUsdc} USDC per verification\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
