import express from 'express';
import cors from 'cors';
import { formatUnits } from 'viem';
import { BittensorClient } from './bittensor.js';
import { getModelPricing, getSupportedModels, isModelSupported, isPlanningModel, loadConfig, MODEL_DESCRIPTIONS } from './config.js';
import { DrainService } from './drain.js';
import { executeOperation } from './operations.js';
import { getAllSchemas, getOperationSchema, TRADE_INTENT_SCHEMA } from './schemas.js';
import { VoucherStorage } from './storage.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const bittensor = new BittensorClient(config);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string, model: string): boolean {
  const isPlanning = isPlanningModel(model);
  const key = `${isPlanning ? 'p' : 'r'}:${channelId}`;
  const limit = isPlanning ? config.planRateLimitPerMinute : config.readRateLimitPerMinute;
  const now = Date.now();
  const hits = rateLimitMap.get(key) ?? [];
  const recent = hits.filter((t) => now - t < 60_000);
  if (recent.length >= limit) return false;
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, hits] of rateLimitMap) {
    const active = hits.filter((t) => t > cutoff);
    if (active.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, active);
  }
}, 5 * 60_000);

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  if (req.headers.authorization !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <ADMIN_PASSWORD>' });
    return false;
  }
  return true;
}

app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, unknown> = {};
  for (const id of getSupportedModels()) {
    const pricing = getModelPricing(id)!;
    models[id] = {
      inputPer1kTokens: formatUnits(pricing.inputPer1k, 6),
      outputPer1kTokens: '0',
      pricePerRequest: formatUnits(pricing.inputPer1k, 6),
      pricingModel: 'flat',
      description: MODEL_DESCRIPTIONS[id],
      inputSchema: getOperationSchema(id)?.inputSchema ?? null,
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    models,
  });
});

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: getSupportedModels().map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'community-axelot',
      description: MODEL_DESCRIPTIONS[id],
      inputSchema: getOperationSchema(id)?.inputSchema ?? null,
      outputSchema: getOperationSchema(id)?.outputSchema ?? null,
    })),
  });
});

app.get('/v1/schemas', (_req, res) => {
  res.json({
    provider: 'community-axelot',
    intentSchema: TRADE_INTENT_SCHEMA,
    operations: getAllSchemas(),
  });
});

app.get('/v1/docs', (_req, res) => {
  const rows = getSupportedModels()
    .map((id) => {
      const pricing = getModelPricing(id)!;
      return `| ${id} | ${MODEL_DESCRIPTIONS[id]} | $${formatUnits(pricing.inputPer1k, 6)} |`;
    })
    .join('\n');

  res.type('text/plain').send(`# Community-Axelot — Agent Instructions

Bittensor dTAO trading intelligence via DRAIN payments. This is NOT a chat/LLM provider and does NOT custody or sign TAO wallets.

## How to use via DRAIN
1. Open a payment channel to this provider with drain_open_channel.
2. Call drain_chat with one of the model IDs below.
3. Put exactly one user message whose content is valid JSON.
4. Discover exact JSON schemas at /v1/schemas or in /v1/models.

## Operations
| Model ID | Description | Price |
|---|---|---|
${rows}

## Non-custodial execution
Trading plans return semantic intents for a separate local MCP signer:
\`axelot-tao-signer-mcp\`. The provider never receives TAO mnemonics, keyfiles,
private keys, or signed wallet material. Default execution mode is local submit:
the signer signs/submits to Subtensor, then this provider can monitor the tx hash.

## Common input examples
Market snapshot:
{"limit": 20, "minReserveTao": 50}

Subnet analysis:
{"netuids": [1, 8, 64]}

Friction quote:
{"netuid": 1, "amountTao": 0.25, "action": "stake"}

Portfolio analysis:
{"coldkey": "5..."}

Trade plan:
{"action": "stake", "netuid": 1, "amountTao": 0.25, "coldkey": "5...", "maxSlippagePct": 1.5, "riskPolicyHash": "sha256:..."}

Monitor trade:
{"txHash": "0x...", "depth": 80}

## Response format
The assistant message content is a JSON string. Parse it as JSON. Trade planning
responses include \`requiresLocalSigner:true\`, signer setup metadata, and an
\`axelot.trade-intent.v1\` object for local dry-run/signing.

## Safety rules
- Never send wallet seeds, mnemonics, keyfiles, or passwords to this provider.
- Local signer must reconstruct allowlisted Subtensor calls from semantic intent.
- Limit-price values are advisory; local signer recomputes RAO/Alpha limits.
- \`recycle_alpha\` requires explicit local policy plus manual confirmation.

Pricing is flat per request in USDC; see /v1/pricing for exact current rates.
Rate limits: reads ${config.readRateLimitPerMinute}/min, planning ${config.planRateLimitPerMinute}/min per channel.
`);
});

app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    bittensorChain: config.bittensorChain,
    subtensorEndpoint: config.subtensorEndpoint,
    subtensorConnected: bittensor.connected,
    models: getSupportedModels().length,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  if (!voucherHeader) {
    res.status(402).set({ ...drainService.getPaymentHeaders(), 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).set({ ...drainService.getPaymentHeaders(), 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
    return;
  }

  const model = req.body.model as string;
  if (!model || !isModelSupported(model)) {
    res.status(400).json({ error: { message: `Model not supported: ${model}. Available: ${getSupportedModels().join(', ')}` } });
    return;
  }

  if (!checkRateLimit(voucher.channelId, model)) {
    const limit = isPlanningModel(model) ? config.planRateLimitPerMinute : config.readRateLimitPerMinute;
    res.status(429).json({ error: { message: `Rate limit exceeded (${limit}/min for ${isPlanningModel(model) ? 'planning' : 'read'} ops)` } });
    return;
  }

  const cost = getModelPricing(model)!.inputPer1k;
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    const headers: Record<string, string> = { ...drainService.getPaymentHeaders(), 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = cost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }> | undefined;
  const input = messages?.filter((m) => m.role === 'user').pop()?.content ?? '';

  let result: Record<string, unknown>;
  try {
    result = await executeOperation(model, input, { config, bittensor, providerAddress: drainService.getProviderAddress() });
  } catch (error) {
    res.status(422).json({ error: { message: error instanceof Error ? error.message : String(error), type: 'operation_error' } });
    return;
  }

  const channelState = validation.channel!;
  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;

  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `axelot-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) { res.status(400).json({ error: 'channelId required' }); return; }
    const result = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: result.finalAmount.toString(), signature: result.signature });
  } catch (error) {
    console.error('[close-channel] Error:', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({ ...stats, totalEarned: stats.totalEarned.toString(), provider: drainService.getProviderAddress() });
});

app.get('/v1/admin/vouchers', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const vouchers = storage.getUnclaimedVouchers();
  res.json({
    count: vouchers.length,
    vouchers: vouchers.map((v) => ({
      channelId: v.channelId,
      amount: v.amount.toString(),
      nonce: v.nonce.toString(),
      consumer: v.consumer,
      receivedAt: new Date(v.receivedAt).toISOString(),
    })),
  });
});

async function start() {
  await bittensor.connect();
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);
  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`DRAIN chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy'}`);
    console.log(`Bittensor: ${config.bittensorChain} -> ${config.subtensorEndpoint}`);
    console.log(`Models: ${getSupportedModels().length}`);
  });
}

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
