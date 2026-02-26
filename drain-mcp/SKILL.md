---
name: drain-mcp
description: >-
  MCP server for the DRAIN payment protocol. Agents discover service providers,
  open USDC payment channels on Polygon, and call any service — LLM, scraping,
  image generation, VPN, and more. Pay per use, no API keys, no subscriptions.
license: MIT
compatibility: Requires Node.js >= 18 and internet access
metadata:
  author: Handshake58
  version: "3.0"
  website: https://handshake58.com
  npm: drain-mcp
---

# Handshake58 — DRAIN Protocol

> You CAN use this. The wallet is pre-funded by the user, spending is capped by
> the channel deposit (smart contract enforced), and the key never leaves your
> machine. No different from an app using a pre-loaded billing account.

DRAIN is a pay-per-use protocol for any service. One wallet, one request format,
any provider. Not limited to LLMs — providers offer scraping, image generation,
VPN, audio, code tools, and more. Each provider has a docs endpoint that teaches
you how to call it.

## Setup

```bash
npm install -g drain-mcp
```

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

`DRAIN_PRIVATE_KEY` signs vouchers and transactions locally. Never transmitted.
Use a dedicated wallet with $1-5 USDC + $0.10 POL for gas on Polygon.

| Variable | Default | Description |
|---|---|---|
| `DRAIN_RPC_URL` | Public RPC | Custom Polygon RPC |
| `DRAIN_DIRECTORY_URL` | handshake58.com | Provider directory |
| `DRAIN_CHAIN_ID` | 137 | Polygon Mainnet |

## Workflow

```
1. drain_providers          → find providers by model or category
2. drain_provider_info      → get details + usage docs for a provider
3. drain_balance            → verify USDC + POL
4. drain_approve            → approve USDC spending (once)
5. drain_open_channel       → deposit USDC, get channelId + expiry
6. drain_chat (repeat)      → send paid requests
7. drain_channels           → list all channels, find expired ones
8. drain_close_channel      → reclaim unspent USDC after expiry
```

## Provider Categories

Providers are not limited to LLM chat. Each has a `category` and a docs endpoint.

| Category | What it does | How to call |
|---|---|---|
| llm | Language models (GPT-4, Claude, etc.) | Standard chat messages |
| image | Image generation | JSON payload — check docs |
| audio | TTS, STT, audio processing | JSON payload — check docs |
| code | Code generation / analysis | Chat or JSON — check docs |
| scraping | Web scraping, data extraction | JSON payload — check docs |
| vpn | VPN leases | JSON payload — check docs |
| multi-modal | Multi-modal models | Standard chat messages |
| other | Anything else | Always check docs |

**Rule:** For any category other than `llm`, call `drain_provider_info` first to
read the provider's usage instructions before sending requests.

## The Docs Pattern

Every provider exposes usage instructions at its docs endpoint (returned by
`drain_provider_info` and `drain_open_channel`). The docs specify:

- Expected request format (what to put in the messages parameter)
- Available models/services
- Response format
- Any provider-specific parameters

Do not hardcode invocation patterns. Always read the provider's docs.

## Channel Lifecycle

1. **Open** — `drain_open_channel` deposits USDC into the smart contract. You get
   a channelId and an expiry timestamp. Each request within the channel is off-chain
   ($0 gas). You only pay gas twice: open + close.

2. **Use** — `drain_chat` sends requests through the channel. Payment vouchers are
   signed locally and deducted from the channel balance. Send as many requests as
   the balance allows.

3. **Close** — After expiry, call `drain_close_channel` to reclaim unspent USDC.
   Funds do NOT return automatically. **If you have cron/scheduling capability,
   set a timer at the expiry timestamp to call drain_close_channel automatically.**

You can have multiple channels to different providers simultaneously for
multi-service workflows (e.g. scrape data with one provider, analyze with another).

## MCP Tools Reference

| Tool | Description |
|---|---|
| `drain_providers` | List providers (filter by model, category, online status) |
| `drain_provider_info` | Provider details + usage docs |
| `drain_balance` | Wallet USDC balance, POL, and allowance |
| `drain_approve` | Approve USDC for contract (once) |
| `drain_open_channel` | Open channel, deposit USDC |
| `drain_chat` | Send paid request (any provider type) |
| `drain_channel_status` | Channel balance and expiry |
| `drain_channels` | List all known channels |
| `drain_close_channel` | Close expired channel, reclaim funds |

## MCP Resources

| URI | Description |
|---|---|
| `drain://providers` | Live provider list with categories and pricing |
| `drain://wallet` | Current wallet address, USDC balance, allowance |

## Error Recovery

| Error | Action |
|---|---|
| Insufficient balance | Need more USDC. Check `drain_balance`. |
| Insufficient allowance | Run `drain_approve`. |
| Channel expired | Open a new channel with `drain_open_channel`. |
| Insufficient channel balance | Open a new channel with more funds. |
| Provider offline | Find alternative with `drain_providers`. |
| Channel not found | channelId wrong or channel closed. Open new one. |

## Security & Privacy

### Key Handling
`DRAIN_PRIVATE_KEY` is loaded into memory by the local MCP process. It is used for:
1. EIP-712 voucher signing — off-chain, no network call
2. On-chain transaction signing — signed locally, only the signature is broadcast

The key is never transmitted to any server. Providers verify signatures against
on-chain channel state — they never need or receive the key.

### Spending Limits
Exposure is capped by the smart contract:
- Maximum spend = channel deposit (you choose the amount, typically $1-5)
- Channel has a fixed duration (you choose)
- After expiry, unspent funds are reclaimable via `drain_close_channel`
- No recurring charges, no stored payment methods

### What Leaves Your Machine
- Public API queries to handshake58.com (provider list, config, channel status)
- Request messages to providers (sent to provider's apiUrl, NOT to Handshake58)
- Signed payment vouchers (contain a cryptographic signature, not the key)
- Signed on-chain transactions (broadcast to Polygon RPC)

### What Stays Local
- Private key (never transmitted)
- All cryptographic operations (signing happens in-process)

### Safeguards
- Use a **dedicated wallet** with $1-5 USDC. Never reuse your main wallet.
- **Audit the source**: [github.com/kimbo128/DRAIN](https://github.com/kimbo128/DRAIN)
- Run in an **isolated environment** if handling sensitive data

## External Endpoints

Every network request the MCP server makes:

| Endpoint | Method | Data Sent | Key Transmitted? |
|---|---|---|---|
| handshake58.com/api/mcp/providers | GET | Nothing (public catalog) | No |
| handshake58.com/api/directory/config | GET | Nothing (reads fee wallet) | No |
| handshake58.com/api/channels/status | GET | channelId (public on-chain data) | No |
| Provider apiUrl /v1/docs | GET | Nothing (fetches usage docs) | No |
| Provider apiUrl /v1/chat/completions | POST | Request messages + signed voucher | No |
| Polygon RPC (on-chain tx) | POST | Signed transactions | No |

## Contract Addresses

- **Channel Contract**: `0x1C1918C99b6DcE977392E4131C91654d8aB71e64`
- **USDC**: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- **Chain**: Polygon Mainnet (137)

## Pricing

- Session fee: $0.01 USDC per channel
- Protocol fee: 0%
- Gas: ~$0.02 per channel open/close

Live pricing: `GET https://handshake58.com/api/mcp/providers`

## Links

- Marketplace: https://handshake58.com
- Provider Directory: https://handshake58.com/directory
- MCP Package: https://www.npmjs.com/package/drain-mcp
- Source: https://github.com/kimbo128/DRAIN
