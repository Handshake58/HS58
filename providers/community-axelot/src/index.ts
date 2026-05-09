import express from 'express';
import cors from 'cors';
import { formatUnits } from 'viem';
import { BittensorClient } from './bittensor.js';
import { getModelPricing, getSupportedModels, isModelSupported, isPlanningModel, loadConfig, MODEL_DESCRIPTIONS, MODEL_METADATA } from './config.js';
import { DrainService } from './drain.js';
import { executeOperation } from './operations.js';
import { getAllSchemas, getOperationSchema, STRATEGY_ADAPTER_SCHEMA, TRADE_INTENT_SCHEMA } from './schemas.js';
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
      ...(MODEL_METADATA[id] ?? {}),
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
      ...(MODEL_METADATA[id] ?? {}),
      inputSchema: getOperationSchema(id)?.inputSchema ?? null,
      outputSchema: getOperationSchema(id)?.outputSchema ?? null,
    })),
  });
});

app.get('/v1/schemas', (_req, res) => {
  res.json({
    provider: 'community-axelot',
    intentSchema: TRADE_INTENT_SCHEMA,
    strategyAdapterSchema: STRATEGY_ADAPTER_SCHEMA,
    operations: getAllSchemas(),
  });
});

app.get('/v1/docs', (_req, res) => {
  const rows = getSupportedModels()
    .map((id) => {
      const pricing = getModelPricing(id)!;
      const meta = MODEL_METADATA[id];
      return `| ${id} | ${meta?.mode ?? 'learn'} | ${meta?.riskLevel ?? 'none'} | ${MODEL_DESCRIPTIONS[id]} | $${formatUnits(pricing.inputPer1k, 6)} |`;
    })
    .join('\n');
  const marketSnapshotPayload = JSON.stringify({ limit: 20, minReserveTao: 50 });
  const frictionPayload = JSON.stringify({ netuid: 64, amountTao: 0.25, action: 'stake' });
  const tradePlanPayload = JSON.stringify({
    action: 'stake',
    netuid: 64,
    amountTao: 0.005,
    coldkey: '5...',
    maxSlippagePct: 1.5,
    ttlSeconds: 300,
    strategy: {
      source: 'trustedstake',
      strategyId: 'bittensor-safe-index',
      riskClass: 'risk_averse',
      mode: 'trade',
    },
  });

  res.type('text/plain').send(`# Community-Axelot — Agent Instructions

Bittensor dTAO trading intelligence via DRAIN payments. This is NOT a chat/LLM provider and does NOT custody or sign TAO wallets.

## Agent rule
Start every new user in Learn mode. Move to Monitor only when the user provides a public coldkey. Move to Trade only after the user explicitly asks to trade and configures the local signer. Never execute without \`tao_dry_run_intent\` and explicit user confirmation.

## Zero-context quick start
1. Install DRAIN MCP: \`npm install -g drain-mcp\`.
2. Configure \`DRAIN_PRIVATE_KEY\` in the agent MCP config. The wallet needs USDC + POL on Polygon.
3. Open a channel:
\`\`\`
drain_open_channel({
  "provider": "${drainService.getProviderAddress()}",
  "amount": "0.50",
  "duration": "1h"
})
\`\`\`
4. Call this provider with \`drain_chat\`. Put exactly one user message whose \`content\` is a JSON string.
5. Close with \`drain_cooperative_close(channelId)\` when finished.

## Modes
- Learn: no wallet, no signing, no risk. Use for education and discovery.
- Monitor: read-only coldkey analysis. No signer required.
- Trade: local signer required. Provider returns semantic intents only; signer enforces policy and submits locally.

## Operations
| Model ID | Mode | Risk | Description | Price |
|---|---|---|---|---|
${rows}

## Learn mode examples
Example market snapshot:
\`\`\`json
{
  "channelId": "0x...",
  "model": "axelot/market-snapshot",
  "messages": [
    { "role": "user", "content": ${JSON.stringify(marketSnapshotPayload)} }
  ]
}
\`\`\`

Example friction quote:
\`\`\`json
{
  "model": "axelot/friction-quote",
  "messages": [
    { "role": "user", "content": ${JSON.stringify(frictionPayload)} }
  ]
}
\`\`\`

## Monitor mode
Use public coldkeys only. Example payloads:
- Portfolio analysis: \`{"coldkey":"5..."}\`
- Rebalance read-only: \`{"coldkey":"5...","limit":8,"minReserveTao":50}\`
- Monitor trade: \`{"txHash":"0x...","depth":80}\`

## TrustedStake strategy adapter
TrustedStake designs strategies; Axelot turns them into agent-readable analysis and non-custodial trade intents. If a TrustedStake API/export is available, pass it as \`strategy\`. Until then, agents can use a manual adapter object:
\`\`\`json
{
  "source": "trustedstake",
  "strategyId": "bittensor-safe-index",
  "riskClass": "risk_averse",
  "mode": "monitor",
  "targetAllocations": [
    { "netuid": 64, "weightPct": 25 }
  ],
  "rules": {
    "rebalanceCadence": "hourly",
    "thresholdBased": true,
    "maxSlippagePct": 1.5,
    "requireManualConfirm": true
  },
  "autonomy": {
    "mode": "manual_confirm",
    "maxTaoPerDay": 0.05,
    "maxTradesPerDay": 5,
    "requireDryRun": true
  }
}
\`\`\`

## Trade mode: non-custodial execution
Trading plans return semantic \`axelot.trade-intent.v1\` intents for a separate local MCP signer. The provider never receives TAO mnemonics, keyfiles, private keys, passwords, or signed extrinsic hex.

Install the local signer from the public HS58 repo:
\`\`\`bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/community-axelot/signer-mcp
npm install
npm run generate-wallet
npm run build
node dist/server.js
\`\`\`

Cursor/agent MCP config example:
\`\`\`json
{
  "mcpServers": {
    "axelot-tao-signer": {
      "command": "node",
      "args": ["/absolute/path/to/HS58/providers/community-axelot/signer-mcp/dist/server.js"],
      "env": {
        "TAO_COLDKEY_MNEMONIC": "your generated or existing low-value TAO wallet mnemonic",
        "SUBTENSOR_ENDPOINT": "wss://entrypoint-finney.opentensor.ai:443",
        "BITTENSOR_CHAIN": "bittensor-finney",
        "MAX_TAO_PER_TRADE": "0.01",
        "MAX_TAO_PER_DAY": "0.05",
        "MAX_TRADES_PER_DAY": "5",
        "MAX_SLIPPAGE_PCT": "1.5",
        "MIN_SECONDS_BETWEEN_TRADES": "300",
        "REQUIRE_CONFIRM": "true",
        "ALLOW_RECYCLE_ALPHA": "false",
        "TRADE_STATE_PATH": "./data/trade-state.json"
      }
    }
  }
}
\`\`\`

Normal-user signer tools:
- \`tao_generate_wallet\`: create a new sr25519 TAO coldkey if the user has no wallet.
- \`tao_wallet_status\`: show local coldkey, endpoint, balance, nonce and policy hash.
- \`tao_trade_state\`: show daily budget usage, active intents and recent decisions for autonomous agents.
- \`tao_dry_run_intent\`: reconstruct the exact Subtensor call without signing.
- \`tao_execute_intent\`: verify, sign and submit locally after user approval.

Advanced signer tools: \`tao_portfolio_snapshot\`, \`tao_policy_get\`, \`tao_verify_intent\`, \`tao_sign_trade_intent\`, \`tao_submit_signed_extrinsic\`.

Full execution flow:
1. Call \`axelot/trade-plan\` through DRAIN.
2. Send the returned \`intent\` to local \`tao_dry_run_intent\`.
3. Call \`tao_trade_state\` so the agent knows what it is already in and why.
4. Show the reconstructed call, amount units, limit price and policy verdict to the user.
5. Only after approval, call local \`tao_execute_intent({ intent, confirm: true })\`.
6. If the user explicitly configured local \`REQUIRE_CONFIRM=false\`, an autonomous agent may call \`tao_execute_intent\` without \`confirm:true\`, but only inside local signer policy.
7. Send the returned \`txHash\` to \`axelot/monitor-trade\`.

## Autonomous agents
Clawdbot/Cursor/Codex own scheduling, memory, observability, retries, Taostats enrichment and Dwellir RPC usage. This provider is the intelligence and intent layer. The local signer is the execution gatekeeper.

Autopilot is local opt-in only:
- Default: \`REQUIRE_CONFIRM=true\`, user confirms every execution.
- Guarded autopilot: user sets \`REQUIRE_CONFIRM=false\` locally. Signer still enforces per-trade TAO, daily TAO, max trades/day, cooldown, slippage, allowed actions and allowed netuids.
- The signer keeps bounded \`trade-state.json\` for current active intents and recent decisions. It is not an append-only log.

## Trade-plan request example
\`\`\`json
{
  "model": "axelot/trade-plan",
  "messages": [
    {
      "role": "user",
      "content": ${JSON.stringify(tradePlanPayload)}
    }
  ]
}
\`\`\`

The response includes \`requiresLocalSigner:true\`, local signer metadata and an \`intent\` object. Do not sign provider raw calls; the signer rebuilds allowlisted Subtensor calls from the semantic intent.

## What to ask before trading
Ask the user to confirm:
1. Coldkey address.
2. Max TAO per trade.
3. Max slippage.
4. Strategy source, e.g. TrustedStake strategy ID or manual allocation.
5. Whether this is monitor-only or actual execution.

## Response format
The assistant message content is a JSON string. Parse it as JSON. Trade planning
responses include \`requiresLocalSigner:true\`, signer setup metadata, and an
\`axelot.trade-intent.v1\` object for local dry-run/signing.

## Safety rules
- Never send wallet seeds, mnemonics, keyfiles, or passwords to this provider.
- Local signer must reconstruct allowlisted Subtensor calls from semantic intent.
- Limit-price values are advisory; local signer recomputes RAO/Alpha limits.
- \`recycle_alpha\` requires explicit local policy plus manual confirmation.
- Signed extrinsic hex stays local; do not send it to the remote provider.

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
