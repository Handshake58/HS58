/**
 * Community TaoApp Provider
 *
 * DRAIN payment gateway for TAO.app API (Bittensor analytics & portfolio data).
 * Wraps https://api.tao.app behind DRAIN micropayments.
 */
import express from 'express';
import cors from 'cors';
import { loadConfig, getRequestCost, isEndpointAllowed, getAllowedEndpoints } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { TaoAppService } from './taoapp.js';
import { formatUnits } from 'viem';
import type { ChatMessage, TaoAppQueryRequest } from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const taoappService = new TaoAppService(config.taoappApiUrl, config.taoappApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const cost = getRequestCost(config);
const priceStr = formatUnits(cost, 6);

// ── Per-channel rate limiting ──
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string): boolean {
  const now = Date.now();
  const hits = rateLimitMap.get(channelId) ?? [];
  const recent = hits.filter(t => now - t < 60_000);
  if (recent.length >= config.rateLimitPerMinute) return false;
  recent.push(now);
  rateLimitMap.set(channelId, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, hits] of rateLimitMap) {
    const filtered = hits.filter(t => t > cutoff);
    if (filtered.length === 0) rateLimitMap.delete(id);
    else rateLimitMap.set(id, filtered);
  }
}, 5 * 60_000);

// ── GET /v1/pricing ──
app.get('/v1/pricing', (_req, res) => {
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'bittensor-data',
    note: `Flat rate: $${priceStr} per API request. Covers all TAO.app endpoints.`,
    models: {
      'taoapp/query': {
        pricePerRequest: priceStr,
        inputPer1kTokens: priceStr,
        outputPer1kTokens: '0',
        description: 'Query the TAO.app API for Bittensor analytics, portfolio tracking, subnet data, macro metrics, and more.',
      },
    },
  });
});

// ── GET /v1/models ──
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'taoapp/query',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'taoapp',
      description: 'Query any TAO.app API endpoint. 50+ endpoints covering macro analytics, subnet data, portfolio, accounting, validators, blocks, and more.',
    }],
  });
});

// ── GET /v1/docs ──
app.get('/v1/docs', (_req, res) => {
  res.type('text/plain').send(`# Community TaoApp Provider — Agent Instructions

This is NOT a chat/LLM provider. It returns raw and curated Bittensor data from the TAO.app API — spanning block-level chain data, subnet price history, subnet analytics, metagraph state, validator/staking info, community sentiment, and portfolio accounting.

## Model: taoapp/query

## How to Use via DRAIN

1. Open a payment channel: drain_open_channel to this provider
2. Call drain_chat with:
   - model: "taoapp/query"
   - messages: ONE user message containing a JSON object (NOT natural language)

## Input Format

The user message must be a JSON object with:
- endpoint (string, required): The API path without /api/beta/ prefix
- params (object, optional): Query parameters as key-value pairs

Example: {"endpoint": "analytics/subnets/metagraph/58", "params": {"limit": 10}}
This calls: GET https://api.tao.app/api/beta/analytics/subnets/metagraph/58?limit=10

## Available Endpoints

### TAO Price
- current — Live TAO/USD price, market cap, 24h volume
- historical-price — Historical TAO/USD price time series

### Subnet Basics
- subnet_tags — Tags/labels for all subnets (e.g. "AI", "Storage")
- subnet_screener — Screener table: price, volume, PnL, rank for all subnets
- subnets/sparklines — 24h price sparklines for all subnets
- subnets/about — Human-readable subnet descriptions (params: netuid)
- subnets/about/summaries — Short summaries of all subnet about pages
- subnets/identity-changes — History of subnet name/identity changes

### Subnet OHLC & Analytics
- subnets/ohlc — (Paid) Candlestick OHLC bars (params: netuid, interval_minutes, start, end)
- analytics/subnets/aggregated — (Paid) Aggregated volume and activity (params: interval, netuids, start, end)
- analytics/subnets/holders — Holder count and distribution per subnet
- analytics/subnets/info — Curated analytics metadata for all subnets
- analytics/subnets/info/{netuid} — Single subnet analytics info
- analytics/subnets/transactions — (Paid) Transaction count/volume per subnet
- analytics/subnets/metagraph/{netuid} — Live metagraph: UIDs, stakes, trust, incentive, emission weights
- analytics/subnets/social/summary — Cross-subnet social analytics
- analytics/subnets/social/{netuid} — Historical social analytics for a subnet
- analytics/subnets/social/{netuid}/latest — Latest social snapshot (discussions, tweets, sentiment)

### Macro Analytics
- analytics/macro/aggregated — (Paid) Network-wide aggregated metrics
- analytics/dynamic-info/aggregated — Dynamic network info
- analytics/macro/fear_greed — Historical Fear & Greed index
- analytics/macro/fear_greed/current — Current Fear & Greed value
- analytics/macro/root_claim_stats — Root emission claim statistics
- analytics/macro/root_claim_stats/current — Current root claim stats

### Price & APY
- price-sustainability — TAO emission needed to sustain current prices
- apy/root — Estimated APY for root subnet staking
- apy/alpha — (Paid) Estimated APY per subnet alpha token (params: netuids, hotkey)

### Portfolio (wallet-level, mostly Paid)
- portfolio/events — (Paid) Full event log (params: coldkey, start, end)
- portfolio/transactions — (Paid) Wallet transaction history
- portfolio/transfers — Coldkey TAO transfer history (params: coldkey)
- portfolio/stake-transfers/external — (Paid) Stake transfers between coldkeys
- portfolio/stake-transfers/internal — (Paid) Stake transfers between hotkeys
- portfolio/allocation — (Paid) Current stake allocation across subnets
- portfolio/historical-stake — (Paid) Historical stake balance
- portfolio/last-root-claim — (Paid) Last root emission claim

### Accounting (tax/cost-basis, mostly Paid)
- accounting/spot-balance — Current TAO and alpha spot balances (params: coldkey)
- accounting/price-at-block — Alpha token price at a specific block
- accounting/events — (Paid) Detailed accounting event log
- accounting/balance-history — (Paid) Historical balance snapshots
- accounting/emissions-events — (Paid) Emission receipt events

### Block Explorer
- blocks/latest — Latest finalized block number and hash
- block/{identifier}/info — Block metadata by number or hash
- block/by-timestamp — Nearest block to a Unix timestamp
- block/{block_number}/extrinsics — All extrinsics in a block
- block/{block_number}/extrinsics/{idx} — Single extrinsic
- block/{block_range}/events — (Paid) Events in a block range
- block/{block_number}/{extrinsic_idx}/events — Events from an extrinsic
- block/events — Recent on-chain events
- tx/{tx_hash} — Transaction lookup by hash
- address/extrinsics — Extrinsic history for a wallet address
- chain/runtime-version — Current Bittensor runtime spec version

### Validators
- validator_identities — Validator names, descriptions, identities
- validators/stakes — Stake amounts across all validators
- validators/stakes/{netuid} — Validator stakes for a specific subnet

## Request Examples

### Get current TAO price and metrics
{"endpoint": "current"}

### Get subnet metagraph (live state)
{"endpoint": "analytics/subnets/metagraph/1"}

### Get Fear & Greed index
{"endpoint": "analytics/macro/fear_greed/current"}

### Get subnet OHLC (15min candles)
{"endpoint": "subnets/ohlc", "params": {"netuid": 1, "interval_minutes": 15, "start": 1700000000000, "end": 1700086400000}}

### Get portfolio allocation for a wallet
{"endpoint": "portfolio/allocation", "params": {"coldkey": "5Hd2ze..."}}

### Get what a subnet is about
{"endpoint": "subnets/about", "params": {"netuid": 62}}

### Get latest social analytics for a subnet
{"endpoint": "analytics/subnets/social/64/latest"}

## Response Format

List endpoints return paginated JSON: {"data": [...], "total": N, "page": 1, "page_size": 50, "next_page": 2}
Single-resource endpoints return flat JSON objects.
The assistant message content is the raw API response.

## Pricing

$${priceStr} per request (flat rate, all endpoints).
Rate limit: ${config.rateLimitPerMinute} req/min per channel.
Full API reference: https://api.tao.app/docs
`);
});

// ── POST /v1/chat/completions ──
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

  const modelId = req.body.model;
  if (modelId !== 'taoapp/query') {
    res.status(400).json({ error: { message: `Model "${modelId}" not available. Use "taoapp/query".` } });
    return;
  }

  const messages: ChatMessage[] | undefined = req.body.messages;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();
  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send query as JSON: {"endpoint": "current"}' },
    });
    return;
  }

  let queryReq: TaoAppQueryRequest;
  try {
    queryReq = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: { message: 'User message must be valid JSON. Example: {"endpoint": "current"}' },
    });
    return;
  }

  if (!queryReq.endpoint || typeof queryReq.endpoint !== 'string') {
    res.status(400).json({
      error: { message: 'Missing "endpoint" field. Example: {"endpoint": "analytics/macro/fear_greed/current"}' },
    });
    return;
  }

  const endpoint = queryReq.endpoint.replace(/^\/+|\/+$/g, '');
  if (!isEndpointAllowed(endpoint)) {
    res.status(400).json({
      error: {
        message: `Endpoint "${endpoint}" is not available. See /v1/docs for the full list of supported endpoints.`,
        hint: 'Use endpoints like: current, analytics/subnets/info, analytics/macro/fear_greed/current',
      },
    });
    return;
  }

  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${validation.error}` },
      ...(validation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  if (!checkRateLimit(voucher.channelId)) {
    res.status(429).json({
      error: { message: `Rate limit exceeded (${config.rateLimitPerMinute} req/min). Try again shortly.` },
    });
    return;
  }

  try {
    const taoappResponse = await taoappService.query(endpoint, queryReq.params ?? {});
    const content = JSON.stringify(taoappResponse);

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
      id: `taoapp-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (error: any) {
    console.error(`[taoapp] Query error for ${endpoint}:`, error.message);
    res.status(502).json({
      error: { message: `TAO.app query failed: ${error.message?.slice(0, 300)}` },
    });
  }
});

// ── POST /v1/close-channel ──
app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) {
    res.status(400).json({ error: 'channelId required' });
    return;
  }
  try {
    const highest = storage.getHighestVoucherPerChannel().get(channelId);
    if (!highest) {
      res.json({ channelId, finalAmount: '0', signature: '0x' });
      return;
    }
    res.json({
      channelId,
      finalAmount: highest.amount.toString(),
      signature: highest.signature,
    });
  } catch (error) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v1/admin/claim ──
app.post('/v1/admin/claim', async (req, res) => {
  if (config.adminPassword) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.adminPassword}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ── GET /v1/admin/stats ──
app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

// ── GET /v1/admin/vouchers ──
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

// ── GET /health ──
app.get('/health', async (_req, res) => {
  const healthy = await taoappService.healthCheck();
  res.json({
    status: healthy ? 'ok' : 'degraded',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    taoappApi: config.taoappApiUrl,
    taoappOnline: healthy,
    models: ['taoapp/query'],
    endpoints: getAllowedEndpoints().length,
    chainId: config.chainId,
  });
});

// ── Startup ──
async function start() {
  const healthy = await taoappService.healthCheck();
  if (!healthy) {
    console.warn(`[startup] WARNING: TAO.app API at ${config.taoappApiUrl} is not reachable.`);
  }
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);
  app.listen(config.port, config.host, () => {
    console.log(`\nCommunity TaoApp Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`TAO.app API: ${config.taoappApiUrl} (${healthy ? 'online' : 'OFFLINE'})`);
    console.log(`Price: $${priceStr}/request | Endpoints: ${getAllowedEndpoints().length}\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
