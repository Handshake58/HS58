/**
 * Community Taostats Provider
 *
 * DRAIN payment gateway for Taostats API (Bittensor ecosystem data).
 * Wraps https://api.taostats.io behind DRAIN micropayments.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, getRequestCost, isEndpointAllowed, getAllowedEndpoints } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { TaostatsService } from './taostats.js';
import { formatUnits } from 'viem';
import type { QueryRequest } from './types.js';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const taostatsService = new TaostatsService(config.taostatsApiUrl, config.taostatsApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const cost = getRequestCost(config);
const priceStr = formatUnits(cost, 6);

app.get('/v1/pricing', (_req, res) => {
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'bittensor-data',
    note: `Flat rate: $${priceStr} per API request. Covers all Taostats endpoints.`,
    models: {
      'taostats/query': {
        pricePerRequest: priceStr,
        inputPer1kTokens: priceStr,
        outputPer1kTokens: '0',
        description: 'Query the Taostats API for Bittensor ecosystem data (price, metagraph, subnets, validators, miners, staking, etc.)',
      },
    },
  });
});

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'taostats/query',
      object: 'model',
      created: Date.now(),
      owned_by: 'taostats',
      description: 'Query any Taostats API endpoint for Bittensor ecosystem data. 60+ endpoints covering price, metagraph, subnets, validators, miners, staking, liquidity, EVM, and more.',
    }],
  });
});

app.get('/v1/docs', (_req, res) => {
  res.type('text/plain').send(`# Community Taostats Provider — Agent Instructions

This is a NON-STANDARD provider. It returns Bittensor ecosystem data from the Taostats API, not LLM chat.

## Model: taostats/query

## How to Use

1. Open a payment channel: drain_open_channel to this provider
2. Call drain_chat with:
   - model: "taostats/query"
   - messages: ONE user message containing a JSON object (NOT natural language)

## Request Format

The user message must be a JSON object with:
- endpoint (string, required): The Taostats API path without /api/ prefix and /v1 suffix
- params (object, optional): Query parameters as key-value pairs

Example: {"endpoint": "metagraph/latest", "params": {"netuid": 58, "limit": 5}}

This calls: GET https://api.taostats.io/api/metagraph/latest/v1?netuid=58&limit=5

## Available Endpoints

### Price
- price/latest — Current TAO price (params: asset)
- price/history — Historical TAO prices (params: asset, timestamp_start, timestamp_end)
- price/ohlc — OHLC candle data (required: asset, period: "1h"|"1d"|"1m")

### Wallets / Accounts
- account/latest — Coldkey balances (params: address, network, balance_free_min/max, order)
- account/history — Historical balances (params: address)
- transfer — Token transfers (params: address, coldkey, block_number)

### Metagraph
- metagraph/latest — All neurons in a subnet (required: netuid)
  params: uid, hotkey, coldkey, active, validator_permit, is_immunity_period, search, order, limit
- metagraph/history — Historical metagraph snapshots (required: netuid)

### Validators
- validator/latest — Validator info
- validator/metrics/latest — Validator reward data (params: hotkey, coldkey, netuid)
- validator/weights/latest/v2 — Current validator weights (params: hotkey, netuid)
- validator/performance/latest — Validator performance (params: hotkey, netuid)
- validator/alpha_shares/latest — Alpha share distribution
- validator/yield/latest — Validator yield data
- validator/subnet/latest — Validators in a subnet
- hotkey/emission — Hotkey emissions

### Mining
- miner/weight/latest — Latest miner weights (params: hotkey, netuid)
- miner/weight/history — Historical miner weights
- miner/coldkey — Miner by coldkey

### Subnets
- subnet/latest — Subnet list and details (params: netuid)
- subnet/history — Historical subnet data
- subnet/emission — Subnet emissions
- subnet/owner — Subnet ownership (params: netuid)
- subnet/registration_cost/latest — Current registration cost
- subnet/pool/latest — Current subnet pools
- subnet/identity/latest — Subnet identity info
- subnet/github/latest — Subnet GitHub activity
- subnet/tao_flow — TAO flow data

### Staking / Delegation
- stake/latest — Current stake balances (params: coldkey, hotkey, netuid)
- stake/history — Historical stake data
- dtao/stake_balance_aggregated/latest — Total staked balance in TAO
- delegation/event — Staking/delegation events
- stake/portfolio — Stake portfolio

### Network / Chain
- block/latest — Latest blocks
- extrinsic — Extrinsics (params: block_number, module, call)
- event — Chain events
- stats/latest — Network statistics
- tao_emission — TAO emission data

### Liquidity
- liquidity/distribution — Liquidity distribution (params: netuid)
- liquidity/position — Liquidity positions
- liquidity/position_event — Liquidity events

### EVM
- evm/transaction — EVM transactions (params: hash, address)
- evm/block — EVM blocks (params: block_number)
- evm/contract — EVM contracts (params: address)
- evm/log — EVM logs
- evm/address — EVM address info

### CoinGecko
- coingecko/asset — Asset data
- coingecko/pair — Trading pairs

## Common Parameters (most endpoints support these)
- page: Page number (default: 1)
- limit: Results per page (default: 50, max varies: 200-1024)
- order: Sort order (endpoint-specific, e.g. "stake_desc", "uid_asc")

## Response Format

The assistant message content is the raw Taostats JSON response, always structured as:

{
  "pagination": {
    "current_page": 1,
    "per_page": 50,
    "total_items": 256,
    "total_pages": 6,
    "next_page": 2,
    "prev_page": null
  },
  "data": [
    { ... item 1 ... },
    { ... item 2 ... }
  ]
}

## Request Examples

### Get current TAO price
drain_chat parameters:
  model: "taostats/query"
  messages: [{"role": "user", "content": "{\\"endpoint\\": \\"price/latest\\", \\"params\\": {\\"asset\\": \\"tao\\", \\"limit\\": 1}}"}]

### Get subnet 58 metagraph (top 10 by stake)
drain_chat parameters:
  model: "taostats/query"
  messages: [{"role": "user", "content": "{\\"endpoint\\": \\"metagraph/latest\\", \\"params\\": {\\"netuid\\": 58, \\"limit\\": 10, \\"order\\": \\"stake_desc\\"}}"}]

### Get a wallet balance
drain_chat parameters:
  model: "taostats/query"
  messages: [{"role": "user", "content": "{\\"endpoint\\": \\"account/latest\\", \\"params\\": {\\"address\\": \\"5Hd2ze5ug8n1bo3UCAcQsf66VNjKqGos8u6apNfzcU86pg4N\\", \\"limit\\": 1}}"}]

### Get TAO price history (OHLC daily)
drain_chat parameters:
  model: "taostats/query"
  messages: [{"role": "user", "content": "{\\"endpoint\\": \\"price/ohlc\\", \\"params\\": {\\"asset\\": \\"tao\\", \\"period\\": \\"1d\\", \\"limit\\": 7}}"}]

### Get all subnets
drain_chat parameters:
  model: "taostats/query"
  messages: [{"role": "user", "content": "{\\"endpoint\\": \\"subnet/latest\\", \\"params\\": {\\"limit\\": 50}}"}]

## Pricing

- $${priceStr} per request (flat rate, all endpoints)
- Full API reference: https://docs.taostats.io/reference
`);
});

/**
 * POST /v1/chat/completions
 *
 * DRAIN-wrapped Taostats query:
 * - model = "taostats/query"
 * - last user message = JSON with { endpoint, params }
 * - response = raw Taostats API JSON as assistant message
 */
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

  const modelId = req.body.model as string;
  if (modelId !== 'taostats/query') {
    res.status(400).json({ error: { message: `Model "${modelId}" not available. Use "taostats/query".` } });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send query as JSON: {"endpoint": "metagraph/latest", "params": {"netuid": 58}}' },
    });
    return;
  }

  let queryReq: QueryRequest;
  try {
    queryReq = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: { message: 'User message must be valid JSON. Example: {"endpoint": "metagraph/latest", "params": {"netuid": 58}}' },
    });
    return;
  }

  if (!queryReq.endpoint || typeof queryReq.endpoint !== 'string') {
    res.status(400).json({
      error: { message: 'Missing "endpoint" field. Example: {"endpoint": "price/latest", "params": {"asset": "tao"}}' },
    });
    return;
  }

  const endpoint = queryReq.endpoint.replace(/^\/+|\/+$/g, '');

  if (!isEndpointAllowed(endpoint)) {
    res.status(400).json({
      error: {
        message: `Endpoint "${endpoint}" is not available. See /v1/docs for the full list of supported endpoints.`,
        hint: 'Use endpoints like: price/latest, metagraph/latest, subnet/latest, validator/metrics/latest',
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

  try {
    const taostatsResponse = await taostatsService.query(endpoint, queryReq.params ?? {});

    const content = JSON.stringify(taostatsResponse);

    drainService.storeVoucher(voucher, validation.channel!, cost);

    const totalCharged = validation.channel!.totalCharged + cost;
    const remaining = validation.channel!.deposit - totalCharged;

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `taostats-${Date.now()}`,
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
    console.error(`[taostats] Query error for ${endpoint}:`, error.message);
    res.status(502).json({
      error: { message: `Taostats query failed: ${error.message?.slice(0, 300)}` },
    });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

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

app.get('/health', async (_req, res) => {
  const healthy = await taostatsService.healthCheck();
  res.json({
    status: healthy ? 'ok' : 'degraded',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    taostatsApi: config.taostatsApiUrl,
    taostatsOnline: healthy,
    models: ['taostats/query'],
    endpoints: getAllowedEndpoints().length,
    chainId: config.chainId,
  });
});

async function start() {
  const healthy = await taostatsService.healthCheck();
  if (!healthy) {
    console.warn(`[startup] WARNING: Taostats API at ${config.taostatsApiUrl} is not reachable.`);
  }

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\nCommunity Taostats Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Taostats API: ${config.taostatsApiUrl} (${healthy ? 'online' : 'OFFLINE'})`);
    console.log(`Price: $${priceStr}/request | Endpoints: ${getAllowedEndpoints().length}\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
