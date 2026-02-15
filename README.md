<p align="center">
  <img src="HS58.png" width="120" />
</p>

<h1 align="center">Handshake58</h1>

<p align="center">
  <strong>AI Provider Directory powered by DRAIN Protocol & Bittensor Subnet 58</strong>
</p>

<p align="center">
  <a href="https://handshake58.com">Live Marketplace</a> ·
  <a href="docs/thesis.html">Thesis</a> ·
  <a href="https://github.com/kimbo128/DRAIN">DRAIN Protocol</a>
</p>

---

## What is Handshake58?

Handshake58 is a decentralized AI provider marketplace where agents discover providers, pay per request via the DRAIN Protocol, and providers are scored trustlessly through Bittensor Subnet 58.

- **Provider Discovery** — Find AI providers by model, tier, or score
- **Trustless Scoring** — Bittensor validators score providers based on real on-chain usage
- **Micropayments** — Pay-per-request with USDC on Polygon via payment channels
- **Two Provider Tiers** — Bittensor Miners (auto-verified) and Community Providers (admin-approved)
- **MCP Integration** — AI agents discover providers automatically

---

## Provider Templates

Ready-to-deploy provider templates for popular AI backends:

| Template | Backend | Models |
|----------|---------|--------|
| [`hs58-openai`](providers/hs58-openai) | OpenAI | GPT-4o, o1, o3-mini, GPT-3.5 |
| [`hs58-claude`](providers/hs58-claude) | Anthropic | Claude 3.5 Sonnet, Haiku, Opus |
| [`hs58-grok`](providers/hs58-grok) | xAI | Grok-2, Grok-2 Mini |
| [`hs58-openrouter`](providers/hs58-openrouter) | OpenRouter | 200+ models |
| [`hs58-chutes`](providers/hs58-chutes) | Chutes | Bittensor inference models |
| [`hs58-custom`](providers/hs58-custom) | **Any** | Ollama, vLLM, Together, Fireworks, LiteLLM, etc. |

Each template includes:
- Full DRAIN voucher validation (EIP-712 signatures)
- Automatic payment claiming with expiry protection
- OpenAI-compatible API (`/v1/chat/completions`)
- Configurable pricing with upstream markup
- Pre-claim balance checks and error recovery
- Health monitoring endpoints
- One-click Railway deployment

### Quick Start (Provider)

```bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/hs58-openai  # or any template

npm install
cp env.example .env
# Edit .env with your API key and Polygon wallet

npm run dev
```

### Environment Variables (all templates)

```bash
# Required
<API_KEY>=...                         # Backend-specific (OPENAI_API_KEY, etc.)
PROVIDER_PRIVATE_KEY=0x...            # Polygon wallet for receiving payments

# Recommended
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional (defaults shown)
PORT=3000
CHAIN_ID=137                          # 137=Polygon, 80002=Amoy testnet
CLAIM_THRESHOLD=1000000               # Min amount to claim (1 USDC)
MARKUP_PERCENT=50                     # Markup on upstream prices
PROVIDER_NAME=HS58-OpenAI             # Name in API responses
AUTO_CLAIM_INTERVAL_MINUTES=10        # How often to check for expiring channels
AUTO_CLAIM_BUFFER_SECONDS=3600        # Claim channels expiring within this window
```

---

## For Miners (Bittensor Subnet 58)

Run a provider + register as a Bittensor miner for TAO incentives.

### 10 Minute Setup

1. **Deploy a provider** — Pick a template above, deploy on Railway
2. **Deploy the miner** — Fork [HS58-validator](https://github.com/Handshake58/HS58-validator), set `NEURON_TYPE=miner`
3. **Register** — `btcli subnet register --netuid 58`
4. **Done** — Miner auto-registers on handshake58.com, validator scores you

### Scoring

- **60% DRAIN Claims** — Real USDC claimed from payment channels (7-day window)
- **40% Availability** — Provider responds to validator health checks with valid wallet proof

---

## For Validators

Run a validator to score providers on Subnet 58.

1. Fork [HS58-validator](https://github.com/Handshake58/HS58-validator)
2. Set `NEURON_TYPE=validator`
3. Deploy on Railway as worker service
4. See the [validator README](https://github.com/Handshake58/HS58-validator) for full setup

---

## For AI Agents

### MCP Server

```bash
npm install -g drain-mcp
```

```json
{
  "mcpServers": {
    "drain": {
      "command": "drain-mcp",
      "env": {
        "DRAIN_PRIVATE_KEY": "your-polygon-wallet-private-key"
      }
    }
  }
}
```

### API Discovery

```bash
# All providers
GET https://handshake58.com/api/mcp/providers

# Smart filters
GET https://handshake58.com/api/mcp/providers?model=gpt-4o&tier=bittensor&limit=3&format=compact
```

**Filters:** `model`, `tier` (bittensor/community), `minScore`, `limit`, `format` (compact/full)

### Agent Documentation

- [Agent Quick Start](https://handshake58.com/agent.md)
- [MCP Skill File](https://handshake58.com/skill.md)

---

## How It Works

```
Agent ──── discovers ────→ Marketplace (handshake58.com)
  │                              │
  │ opens DRAIN channel          │ syncs scores from
  │ pays per request             │ Bittensor metagraph
  ↓                              ↓
Provider ←── scores ──── Validator (Subnet 58)
  │                        │
  │ claims USDC            │ scans DRAIN events
  ↓                        ↓
Polygon ────────────────── Polygon
(DRAIN Contract)           (ChannelClaimed events)
```

### For Agents
1. **Discover** — Query the marketplace API for providers
2. **Open Channel** — Deposit USDC into a DRAIN payment channel (~$0.02 gas)
3. **Use AI** — Send requests with signed vouchers (free, off-chain)
4. **Close Channel** — Withdraw unused USDC when done

### For Providers
1. **Deploy** — Use a provider template or build your own
2. **Register** — Submit via marketplace or auto-register as Bittensor miner
3. **Serve** — Accept voucher-based payments, serve inference
4. **Claim** — Provider claims earned USDC from the contract (auto-claim protects against expiry)

---

## Contract Addresses

| Contract | Address | Network |
|----------|---------|---------|
| DRAIN Channel | `0x1C1918C99b6DcE977392E4131C91654d8aB71e64` | Polygon Mainnet |
| USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | Polygon Mainnet |

[View on Polygonscan](https://polygonscan.com/address/0x1C1918C99b6DcE977392E4131C91654d8aB71e64)

---

## Repositories

| Repo | Description |
|------|-------------|
| **[HS58](https://github.com/Handshake58/HS58)** | This repo — provider templates, docs, hub |
| [HS58-validator](https://github.com/Handshake58/HS58-validator) | Bittensor Subnet 58 validator + miner |
| [DRAIN Protocol](https://github.com/kimbo128/DRAIN) | Core protocol, smart contracts, SDK |

---

## Pricing

- **Protocol fee:** 0% on payments
- **Gas cost:** ~$0.02 per channel open/claim on Polygon
- **Provider markup:** Set by each provider (typically 20-50% on upstream costs)

---

## License

MIT License

---

Handshake58 &copy; 2026 — Trustless AI payments powered by DRAIN Protocol & Bittensor
