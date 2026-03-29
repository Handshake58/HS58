/**
 * Community-Targon Provider
 *
 * LLM proxy for Targon (Bittensor Subnet 4) inference API.
 * 500+ open-source models via OpenAI-compatible endpoint with DRAIN micropayments.
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
import { formatUnits } from 'viem';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const targon = new OpenAI({
  apiKey: config.targonApiKey,
  baseURL: config.targonApiUrl,
});

const app = express();
app.use(cors());
app.use(express.json());

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  if (req.headers.authorization !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/v1/pricing', (req, res) => {
  const models = getSupportedModels();
  const pricing: Record<string, { inputPer1kTokens: string; outputPer1kTokens: string }> = {};
  const filter = req.query.filter as string | undefined;

  for (const model of models) {
    if (filter && !model.toLowerCase().includes(filter.toLowerCase())) continue;
    const p = getModelPricing(model);
    if (p) {
      pricing[model] = {
        inputPer1kTokens: formatUnits(p.inputPer1k, 6),
        outputPer1kTokens: formatUnits(p.outputPer1k, 6),
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
    totalModels: models.length,
    pricingAge: `${getPricingAge()}s ago`,
    models: pricing,
  });
});

app.get('/v1/models', (_req, res) => {
  const modelList = getModelList();
  res.json({
    object: 'list',
    data: modelList.map(m => ({
      id: m.id,
      object: 'model',
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'targon',
      context_length: m.context_length,
    })),
    total: modelList.length,
  });
});

app.get('/v1/docs', (_req, res) => {
  const models = getSupportedModels();
  const topModels = models.slice(0, 12).map(m => {
    const p = getModelPricing(m);
    return p
      ? `- ${m}: $${formatUnits(p.inputPer1k, 6)} in / $${formatUnits(p.outputPer1k, 6)} out per 1k tokens`
      : `- ${m}`;
  }).join('\n');

  res.type('text/plain').send(`# ${config.providerName} — Agent Instructions

Decentralized LLM inference via Targon (Bittensor Subnet 4). ${models.length}+ open-source models
powered by confidential GPU compute. All accessible via a single DRAIN payment channel.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: any model ID from the list below
   - messages: standard chat messages array

## Example

model: "NousResearch/Meta-Llama-3.1-70B-Instruct"
messages: [{"role": "user", "content": "Explain zero-knowledge proofs"}]

Streaming is supported (stream: true).

## Top Models

${topModels}

Full list: GET /v1/models
Full pricing: GET /v1/pricing
Filter pricing: GET /v1/pricing?filter=llama

## Pricing

Per-token pricing in USDC (${(config.markup - 1) * 100}% markup on Targon base prices).
Input and output tokens are priced separately.
Cost = (input_tokens * input_rate + output_tokens * output_rate) / 1000.

## Notes

- Standard OpenAI chat completions format (messages, max_tokens, temperature, etc.)
- Streaming supported via stream: true
- Responses include X-DRAIN-Cost, X-DRAIN-Remaining headers
- Powered by Bittensor Subnet 4 with confidential compute (TVM)
- One payment channel gives access to all ${models.length}+ models
`);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    models: getSupportedModels().length,
    pricingAge: `${getPricingAge()}s`,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;

  if (!voucherHeader) {
    return res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    return res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
  }

  const model = req.body.model as string;
  if (!isModelSupported(model)) {
    return res.status(400).json({
      error: { message: `Model '${model}' not found. Use GET /v1/models to see available models.`, code: 'model_not_supported' },
    });
  }

  const pricing = getModelPricing(model)!;
  const isStreaming = req.body.stream === true;

  const estimatedInputTokens = Math.ceil(JSON.stringify(req.body.messages).length / 4);
  const estimatedMinCost = calculateCost(pricing, estimatedInputTokens, 50);

  const validation = await drainService.validateVoucher(voucher, estimatedMinCost);
  if (!validation.valid) {
    const headers: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = estimatedMinCost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    return res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
  }

  const channelState = validation.channel!;

  try {
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-DRAIN-Channel', voucher.channelId);

      let inputTokens = 0;
      let outputTokens = 0;
      let fullContent = '';

      const stream = await targon.chat.completions.create({
        model,
        messages: req.body.messages,
        max_tokens: req.body.max_tokens,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        if ((chunk as any).usage) {
          inputTokens = (chunk as any).usage.prompt_tokens || 0;
          outputTokens = (chunk as any).usage.completion_tokens || 0;
        }
      }

      if (inputTokens === 0) inputTokens = estimatedInputTokens;
      if (outputTokens === 0) outputTokens = Math.ceil(fullContent.length / 4);

      const actualCost = calculateCost(pricing, inputTokens, outputTokens);
      drainService.storeVoucher(voucher, channelState, actualCost);

      const remaining = channelState.deposit - channelState.totalCharged;
      res.write(`data: [DONE]\n\n`);
      res.write(`: X-DRAIN-Cost: ${actualCost.toString()}\n`);
      res.write(`: X-DRAIN-Total: ${channelState.totalCharged.toString()}\n`);
      res.write(`: X-DRAIN-Remaining: ${remaining.toString()}\n`);
      res.end();
    } else {
      const completion = await targon.chat.completions.create({
        model,
        messages: req.body.messages,
        max_tokens: req.body.max_tokens,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
      });

      const inputTokens = completion.usage?.prompt_tokens ?? estimatedInputTokens;
      const outputTokens = completion.usage?.completion_tokens ?? 0;
      const actualCost = calculateCost(pricing, inputTokens, outputTokens);

      drainService.storeVoucher(voucher, channelState, actualCost);
      const remaining = channelState.deposit - channelState.totalCharged;

      res.set({
        'X-DRAIN-Cost': actualCost.toString(),
        'X-DRAIN-Total': channelState.totalCharged.toString(),
        'X-DRAIN-Remaining': remaining.toString(),
        'X-DRAIN-Channel': voucher.channelId,
      }).json(completion);
    }
  } catch (error) {
    console.error('Targon API error:', error);
    const message = error instanceof Error ? error.message : 'Targon API error';
    res.status(502).json({
      error: { message, type: 'api_error', code: 'targon_error' },
    });
  }
});

app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { finalAmount, signature } = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: finalAmount.toString(), signature });
  } catch (error: any) {
    console.error('[close-channel] Error:', error?.message || error);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/admin/refresh-pricing', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await updatePricingCache(
      config.targonApiUrl,
      config.targonApiKey,
      config.defaultInputPricePerM,
      config.defaultOutputPricePerM,
      config.markup
    );
    res.json({ success: true, models: getSupportedModels().length, refreshedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    ...stats,
    totalEarned: formatUnits(stats.totalEarned, 6) + ' USDC',
    totalModels: getSupportedModels().length,
    pricingAge: `${getPricingAge()}s ago`,
  });
});

async function main() {
  console.log(`Starting ${config.providerName}...`);
  console.log(`  Targon API: ${config.targonApiUrl}`);

  await updatePricingCache(
    config.targonApiUrl,
    config.targonApiKey,
    config.defaultInputPricePerM,
    config.defaultOutputPricePerM,
    config.markup
  );

  setInterval(async () => {
    try {
      await updatePricingCache(
        config.targonApiUrl,
        config.targonApiKey,
        config.defaultInputPricePerM,
        config.defaultOutputPricePerM,
        config.markup
      );
    } catch (error) {
      console.error('Failed to refresh pricing:', error);
    }
  }, config.pricingRefreshInterval);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} listening on ${config.host}:${config.port}`);
    console.log(`  Provider: ${drainService.getProviderAddress()}`);
    console.log(`  Chain:    ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
    console.log(`  Models:   ${getSupportedModels().length}`);
    console.log(`  Markup:   ${(config.markup - 1) * 100}%`);
    console.log(`  Refresh:  every ${config.pricingRefreshInterval / 1000}s\n`);
  });
}

main().catch(console.error);
