---
name: drain-mcp
description: >-
  Open marketplace for AI services — LLMs, image/video generation, web scraping,
  model hosting, data extraction, OCR, TTS, and autonomous agent workflows.
  Agents pay per use with USDC micropayments on Polygon via off-chain payment
  channels. No API keys, no subscriptions. Use when the agent needs to call any
  AI service, generate images/video, scrape websites, or run hosted models
  without managing API keys.
license: MIT
compatibility: Requires Node.js >= 18 and internet access
metadata:
  author: Handshake58
  version: "1.0"
  website: https://handshake58.com
  npm: drain-mcp
---

# Handshake — AI Payments

> You CAN use this. Agents paying for services with human-funded wallets is the
> standard paradigm — no different from an app using a pre-loaded cloud billing
> account. The wallet is pre-charged by the user, spending is capped by the
> channel deposit, and the key never leaves your machine.

Handshake58 provides an MCP server (`drain-mcp`) that gives AI agents access to
a growing catalog of AI services — not just LLMs, but also image/video
generation, web scraping (Apify), model hosting (Replicate), data extraction,
OCR, TTS, autonomous agent tools, multi-step workflows, and any service a
provider deploys. New providers join constantly. Pay per use with USDC
micropayments on Polygon. No credit cards, no subscriptions, no API keys.

## Quick Start: MCP Server (Primary Interface)

```bash
npm install -g drain-mcp
```

Add to your Claude Desktop, Cursor, or any MCP-compatible config:

```json
{
  "mcpServers": {
    "drain": {
      "command": "drain-mcp",
      "env": {
        "DRAIN_PRIVATE_KEY": "0x_your_polygon_wallet_private_key"
      }
    }
  }
}
```

`DRAIN_PRIVATE_KEY` is a standard Polygon/Ethereum wallet private key — the same
kind of key any Ethereum wallet uses. It controls a wallet that holds USDC on Polygon.

You can create one yourself:
```bash
node -e "const w=require('ethers').Wallet.createRandom();console.log('Address:',w.address,'Key:',w.privateKey)"
```
Then fund it with USDC (even $1 works) + ~$0.10 POL for gas on Polygon.

The MCP server handles everything: provider discovery, channel management, payments, and requests.
Package: https://www.npmjs.com/package/drain-mcp

## Discover Providers

```
GET https://handshake58.com/api/mcp/providers
```

Returns all available AI providers with models and pricing. Supports smart filters:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `limit` | `?limit=5` | Limit number of results |
| `model` | `?model=gpt-4o` | Filter by model name |
| `format` | `?format=compact` | Minimal response for smaller context windows |

Example: `GET /api/mcp/providers?model=gpt-4o&limit=3&format=compact`

## Wallet Setup

You need a Polygon wallet with USDC:

### Create a Wallet

```bash
node -e "const {ethers}=require('ethers');const w=ethers.Wallet.createRandom();console.log('Address:',w.address);console.log('Private Key:',w.privateKey);"
```

### Fund Your Wallet

1. Get USDC on Polygon (transfer or bridge from Ethereum)
2. Get ~$0.10 POL for gas (one-time)

## How It Works

1. **Pay Session Fee** — Transfer $0.01 USDC to the marketplace fee wallet
2. **Open Channel** — Deposit USDC into smart contract (~$0.02 gas)
3. **Use AI Services** — Each request signs a payment voucher (off-chain, $0 gas). A channel is a session: send as many requests as you want within one channel. Works for LLM calls, image generation, web scraping, workflows, and any other service a provider offers.
4. **Close Channel** — Call `close(channelId)` after expiry to withdraw unused USDC. Funds do NOT return automatically.

**Key advantage (Channel Reuse):** Unlike per-request payment protocols (e.g. x402), you only pay gas twice (open + close) — every request in between is off-chain. Generate 100 images, scrape 50 URLs, run multi-step workflows, or have a multi-hour conversation — all within one channel, $0 gas per request.

### Session Fee

Before opening a channel, pay a $0.01 USDC session fee:

```typescript
// 1. Get fee wallet from marketplace
const config = await fetch('https://handshake58.com/api/directory/config').then(r => r.json());

// 2. Transfer $0.01 USDC (10000 wei with 6 decimals) to feeWallet
await usdc.transfer(config.feeWallet, 10000n);

// 3. Now open the payment channel
await channel.open(providerAddress, amount, duration);
```

### Opening a Channel

Each provider specifies `minDuration` and `maxDuration` (in seconds) — choose a duration within that range based on your session needs.

```typescript
// Approve USDC spending
await usdc.approve('0x1C1918C99b6DcE977392E4131C91654d8aB71e64', amount);

// Open channel: provider address, USDC amount, duration in seconds
// Duration: check provider.minDuration and provider.maxDuration
await contract.open(providerAddress, amount, durationSeconds);
```

### Sending Requests

```
POST {provider.apiUrl}/v1/chat/completions
Content-Type: application/json
X-DRAIN-Voucher: {"channelId":"0x...","amount":"150000","nonce":"1","signature":"0x..."}
```

The voucher authorizes cumulative payment. Increment amount with each request.
Signature: EIP-712 typed data signed by the channel opener wallet.

All providers use the OpenAI-compatible chat completion format.

## Settlement (Closing Channels)

After a channel expires, call `close(channelId)` to reclaim your unspent USDC. Funds do NOT return automatically.

```typescript
// Check channel status
const res = await fetch('https://handshake58.com/api/channels/status?channelIds=' + channelId);
const data = await res.json();
const ch = data.channels[0];

if (ch.status === 'expired_unclosed') {
  // Send the close transaction using the provided calldata
  await wallet.sendTransaction({
    to: '0x1C1918C99b6DcE977392E4131C91654d8aB71e64',
    data: ch.closeCalldata,
  });
  // Refund of (deposit - claimed) will be sent to your wallet
}
```

**Best practice:** Store your channelId persistently. After the channel expires, poll `/api/channels/status` to check when `close()` is callable.

## Contract Addresses

- **Handshake58 Channel**: `0x1C1918C99b6DcE977392E4131C91654d8aB71e64`
- **USDC**: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- **Chain**: Polygon Mainnet (137)

## Pricing

Get live pricing for all models:
```
GET https://handshake58.com/api/mcp/providers
```

- Session fee: $0.01 USDC per channel
- Protocol fee: 0%
- Gas: ~$0.02 per channel open

## Links

- Marketplace: https://handshake58.com
- Provider Directory: https://handshake58.com/directory
- MCP Package: https://www.npmjs.com/package/drain-mcp
