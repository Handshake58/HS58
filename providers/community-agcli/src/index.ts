import express from 'express';
import cors from 'cors';
import { loadConfig, getModelPricing, isModelSupported, getSupportedModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import { executeTool, isWriteTool, readTools, writeTools } from './tools.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter (per channel, separate limits for read/write) ---
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string, isWrite: boolean): boolean {
  const key = isWrite ? `w:${channelId}` : `r:${channelId}`;
  const limit = isWrite ? config.writeRateLimitPerMinute : config.readRateLimitPerMinute;
  const now = Date.now();
  const hits = rateLimitMap.get(key) ?? [];
  const recent = hits.filter(t => now - t < 60_000);
  if (recent.length >= limit) return false;
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, hits] of rateLimitMap) {
    const active = hits.filter(t => t > cutoff);
    if (active.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, active);
  }
}, 5 * 60_000);

// --- Admin Auth ---
function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <ADMIN_PASSWORD>' });
    return false;
  }
  return true;
}

// ============================================================
// Routes
// ============================================================

app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, any> = {};
  for (const id of getSupportedModels()) {
    const p = getModelPricing(id)!;
    models[id] = {
      inputPer1kTokens: formatUnits(p.inputPer1k, 6),
      outputPer1kTokens: '0',
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
    data: getSupportedModels().map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'agcli',
    })),
  });
});

app.get('/v1/docs', (_req, res) => {
  const readToolDocs = readTools.map(t => {
    const p = getModelPricing(t.modelId);
    const price = p ? `$${formatUnits(p.inputPer1k, 6)}` : '?';
    return `| ${t.modelId} | ${t.description} | ${price} |`;
  }).join('\n');

  const writeToolDocs = writeTools.map(t => {
    const p = getModelPricing(t.modelId);
    const price = p ? `$${formatUnits(p.inputPer1k, 6)}` : '?';
    return `| ${t.modelId} | ${t.description} | ${price} |`;
  }).join('\n');

  res.type('text/plain').send(`# Community-agcli — Agent Instructions

Bittensor chain tools powered by agcli (Rust CLI). Read blockchain data and execute write operations using your own wallet. This is NOT a chat/LLM provider.

## How to use via DRAIN
1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the tool IDs below
   - messages: ONE user message containing JSON input

## Read Tools (no wallet needed)

| Model ID | Description | Price |
|---|---|---|
${readToolDocs}

### Read Input Format
Send JSON with the required fields:
- address-based tools: {"address": "5Gx..."}
- subnet-based tools: {"netuid": 1}
- diff tools: {"netuid": 1, "fromBlock": 4500000, "toBlock": 4500500}
- explain: {"topic": "yuma"}
- block-info: {"block": 12345}
- subnet-list, delegate-list, doctor: {} (empty object)

## Write Tools (wallet required)

| Model ID | Description | Price |
|---|---|---|
${writeToolDocs}

### Write Input Format
Write tools require your Bittensor wallet keyfiles in the request:
{
  "wallet": {
    "coldkey": "<contents of your coldkey file>",
    "hotkey": "<contents of your hotkey file>"
  },
  "password": "<wallet password if encrypted>",
  "netuid": 1,
  "amount": 10
}

For weights: {"wallet": {...}, "netuid": 1, "weights": "0:100,1:200"}

SECURITY: Wallet data is written to a temporary directory, used once, and immediately deleted. It is never logged or stored.

## Examples

Balance check:
  model: "agcli/balance"
  messages: [{"role":"user","content":"{\\"address\\":\\"5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY\\"}"}]

Subnet metagraph:
  model: "agcli/subnet-metagraph"
  messages: [{"role":"user","content":"{\\"netuid\\":1}"}]

Explain concept:
  model: "agcli/explain"
  messages: [{"role":"user","content":"{\\"topic\\":\\"yuma\\"}"}]

Stake (with wallet):
  model: "agcli/stake-add"
  messages: [{"role":"user","content":"{\\"wallet\\":{\\"coldkey\\":\\"...\\",\\"hotkey\\":\\"...\\"},\\"password\\":\\"mypass\\",\\"netuid\\":1,\\"amount\\":10}"}]

## Response Format
The assistant message contains a JSON string with the agcli output.

## Pricing
Flat rate per request in USDC. Read tools: $0.005-$0.02. Write tools: $0.03-$0.05. Check /v1/pricing for exact rates.

## Limits
- Read rate limit: ${config.readRateLimitPerMinute} requests/min per channel
- Write rate limit: ${config.writeRateLimitPerMinute} requests/min per channel
- Read timeout: ${config.agcliTimeoutRead / 1000}s
- Write timeout: ${config.agcliTimeoutWrite / 1000}s
`);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    tools: getSupportedModels().length,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  if (!voucherHeader) {
    res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
    return;
  }

  const model = req.body.model as string;
  if (!model || !isModelSupported(model)) {
    res.status(400).json({ error: { message: `Model not supported: ${model}. Available: ${getSupportedModels().join(', ')}` } });
    return;
  }

  const isWrite = isWriteTool(model);
  if (!checkRateLimit(voucher.channelId, isWrite)) {
    const limit = isWrite ? config.writeRateLimitPerMinute : config.readRateLimitPerMinute;
    res.status(429).json({ error: { message: `Rate limit exceeded (${limit}/min for ${isWrite ? 'write' : 'read'} ops)` } });
    return;
  }

  const pricing = getModelPricing(model)!;
  const cost = pricing.inputPer1k;

  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    const headers: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = cost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
    return;
  }

  const channelState = validation.channel!;

  const messages = req.body.messages as Array<{ role: string; content: string }> | undefined;
  const input = messages?.filter(m => m.role === 'user').pop()?.content ?? '';

  let result: string;
  try {
    result = await executeTool(
      model,
      input,
      config.agcliPath,
      config.subtensorEndpoint,
      config.agcliTimeoutRead,
      config.agcliTimeoutWrite,
    );
  } catch (e: any) {
    res.status(500).json({ error: { message: `Tool execution failed: ${e.message?.slice(0, 200)}` } });
    return;
  }

  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;

  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `agcli-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) { res.status(400).json({ error: 'channelId required' }); return; }
    const result = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: result.finalAmount.toString(), signature: result.signature });
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

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

app.get('/v1/admin/vouchers', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

async function start() {
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Tools: ${getSupportedModels().length} (read: ${readTools.length}, write: ${writeTools.length})`);
    console.log(`Rate limits: read ${config.readRateLimitPerMinute}/min, write ${config.writeRateLimitPerMinute}/min per channel`);
    console.log(`agcli: ${config.agcliPath} -> ${config.subtensorEndpoint}`);
    console.log(`Auto-claim: every ${config.autoClaimIntervalMinutes}min\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
