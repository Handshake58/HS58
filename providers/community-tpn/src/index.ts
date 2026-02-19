/**
 * Community TPN Provider
 *
 * DRAIN payment gateway for TPN VPN leases (WireGuard).
 * Wraps the TPN API (Bittensor Subnet 65) behind DRAIN micropayments.
 *
 * TPN API: https://api.taoprivatenetwork.com
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, calculateCost, getHourlyPriceWei, getModelInfo, isModelSupported, getSupportedModels, getAllModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { TpnService } from './tpn.js';
import { formatUnits } from 'viem';
import type { LeaseParams, TpnLeaseType } from './types.js';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const tpnService = new TpnService(config.tpnApiUrl, config.tpnApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const hourlyPrice = formatUnits(getHourlyPriceWei(config), 6);
  const minPrice = config.minPriceUsdc.toFixed(6);

  const models: Record<string, any> = {};
  for (const modelId of getSupportedModels()) {
    const info = getModelInfo(modelId)!;
    models[modelId] = {
      pricePerHour: hourlyPrice,
      minPricePerRequest: minPrice,
      inputPer1kTokens: hourlyPrice,
      outputPer1kTokens: '0',
      description: info.description,
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'vpn-leases',
    note: `Prices are per hour of VPN lease. Min charge: $${minPrice} per request. Cost = max(minPrice, minutes / 60 * pricePerHour).`,
    models,
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  const allModels = getAllModels();
  const data = Object.entries(allModels).map(([id, info]) => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: 'tpn-subnet-65',
    description: info.description,
    type: info.type,
  }));

  res.json({ object: 'list', data });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const hourlyPrice = formatUnits(getHourlyPriceWei(config), 6);
  const minPrice = config.minPriceUsdc.toFixed(6);

  res.type('text/plain').send(`# Community TPN Provider — Agent Instructions

This is a NON-STANDARD provider. It sells VPN leases, not LLM chat. Read these docs carefully.

## Available Models

- tpn/wireguard — WireGuard VPN tunnel (returns .conf config)

## How to Use

1. Open a payment channel: drain_open_channel to provider
2. Call drain_chat with:
   - model: "tpn/wireguard"
   - messages: ONE user message containing a JSON object (NOT natural language)

## Lease Parameters (JSON in user message content)

| Parameter   | Type    | Default | Description |
|-------------|---------|---------|-------------|
| minutes     | number  | ${config.defaultLeaseMinutes}      | Lease duration in minutes (1–${config.maxLeaseMinutes}) |
| country     | string  | any     | ISO 3166-1 alpha-2 code: "US", "DE", "NL", "GB", etc. |
| residential | boolean | false   | true = residential IP, false = datacenter |

## Request Examples

### WireGuard VPN in the US for 1 hour

drain_chat parameters:
  channelId: (your channel)
  model: "tpn/wireguard"
  messages: [{"role": "user", "content": "{\\"minutes\\": 60, \\"country\\": \\"US\\"}"}]

### Minimal request (any country, 1 hour, datacenter)

drain_chat parameters:
  channelId: (your channel)
  model: "tpn/wireguard"
  messages: [{"role": "user", "content": "{}"}]

## Response Format

The assistant message content is a JSON object:

{
  "type": "wireguard",
  "vpn_config": "[Interface]\\nAddress = 10.13.13.29/32\\nPrivateKey = ...\\nListenPort = 51820\\nDNS = 10.13.13.1\\n\\n[Peer]\\nPublicKey = ...\\nPresharedKey = ...\\nAllowedIPs = 0.0.0.0/0\\nEndpoint = 1.2.3.4:51820",
  "minutes": 60,
  "expires_at": "2026-02-19T22:00:00.000Z",
  "connection_type": "any",
  "country": "US"
}

The vpn_config field contains the ready-to-use WireGuard .conf file content (newlines as \\n).
Save it as a .conf file or parse the fields to configure a WireGuard client.

## Pricing

- $${hourlyPrice} per hour of lease
- Minimum charge: $${minPrice} per request
- Formula: cost = max($${minPrice}, minutes / 60 * $${hourlyPrice})
- Example: 1h = $${hourlyPrice}, 24h = $${(parseFloat(hourlyPrice) * 24).toFixed(3)}
`);
});

/**
 * POST /v1/chat/completions
 *
 * DRAIN-wrapped VPN lease request:
 * - model = "tpn/wireguard"
 * - last user message = JSON lease parameters
 * - response = VPN config as assistant message
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
  if (!modelId || !isModelSupported(modelId)) {
    const available = getSupportedModels().join(', ');
    res.status(400).json({
      error: { message: `Model "${modelId}" not available. Available: ${available}` },
    });
    return;
  }

  const modelInfo = getModelInfo(modelId)!;
  const leaseType: TpnLeaseType = modelInfo.type;

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send lease parameters as JSON in the user message.' },
    });
    return;
  }

  let leaseParams: LeaseParams;
  try {
    leaseParams = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON with lease parameters. ' +
          'Example: {"minutes": 60, "country": "US", "residential": false}',
      },
    });
    return;
  }

  const minutes = Math.min(
    Math.max(leaseParams.minutes ?? config.defaultLeaseMinutes, 1),
    config.maxLeaseMinutes
  );

  const cost = calculateCost(minutes, config);

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

  try {
    const tpnResponse = await tpnService.requestLease(leaseType, {
      ...leaseParams,
      minutes,
    });

    const content = JSON.stringify({
      type: tpnResponse.type,
      vpn_config: tpnResponse.vpnConfig,
      minutes: tpnResponse.minutes,
      expires_at: tpnResponse.expiresAt,
      connection_type: tpnResponse.connection_type,
      country: leaseParams.country ?? 'any',
    }, null, 2);

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
      id: `tpn-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });

  } catch (error: any) {
    console.error(`[tpn] Lease error for ${modelId}:`, error.message);
    res.status(502).json({
      error: { message: `VPN lease failed: ${error.message?.slice(0, 200)}` },
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
 * Health check
 */
app.get('/health', async (_req, res) => {
  const tpnHealthy = await tpnService.healthCheck();
  res.json({
    status: tpnHealthy ? 'ok' : 'degraded',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    tpnApi: config.tpnApiUrl,
    tpnOnline: tpnHealthy,
    models: getSupportedModels(),
    chainId: config.chainId,
  });
});

// --- Startup ---

async function start() {
  const tpnHealthy = await tpnService.healthCheck();
  if (!tpnHealthy) {
    console.warn(`[startup] WARNING: TPN API at ${config.tpnApiUrl} is not reachable. Leases will fail until it comes online.`);
  }

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    const hourlyPrice = (config.pricePerHourUsdc).toFixed(4);
    const minPrice = (config.minPriceUsdc).toFixed(4);

    console.log(`\nCommunity TPN Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`TPN API: ${config.tpnApiUrl} (${tpnHealthy ? 'online' : 'OFFLINE'})`);
    console.log(`Pricing: $${hourlyPrice}/hour, min $${minPrice}/request`);
    console.log(`Max lease: ${config.maxLeaseMinutes}min (${(config.maxLeaseMinutes / 60).toFixed(1)}h)\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
