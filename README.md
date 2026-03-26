<p align="center">
  <img src="HS58.png" width="120" />
</p>

<h1 align="center">Handshake58</h1>

<p align="center">
  <strong>AI Provider Directory ù DRAIN & MPP Protocols ù Bittensor Subnet 58</strong>
</p>

<p align="center">
  <a href="https://handshake58.com">Live Marketplace</a> ù
  <a href="docs/thesis.html">Thesis</a> ù
  <a href="https://github.com/kimbo128/DRAIN">DRAIN Protocol</a>
</p>

---

## What is Handshake58?

Handshake58 is a decentralized AI provider marketplace where agents discover providers, pay per request via DRAIN or MPP protocols, and providers are scored trustlessly through Bittensor Subnet 58.

- **Provider Discovery** ù Find AI providers by model, category, or oracle score
- **Two Payment Protocols** ù DRAIN (payment channels, low cost at volume) and MPP (HTTP 402, per-request, no setup)
- **Trustless Scoring** ù Bittensor validators score providers on availability, latency, and reliability
- **Three Provider Types** ù TAO Miners (auto-verified), DRAIN Providers, and MPP Providers
- **MCP Integration** ù One MCP server (`drain-mcp`) handles both protocols automatically

---

## How It Works

```mermaid
flowchart LR
    Agent["AI Agent"]
    MP["Marketplace\nhandshake58.com"]
    Provider["Provider"]
    Polygon["Polygon\nDRAIN Contract"]
    Validator["Validator\nSubnet 58"]
    BT["Bittensor"]

    Agent -->|discovers providers| MP
    Agent -->|"DRAIN: payment channel\nMPP: HTTP 402 per-request"| Provider
    Provider -->|claims USDC| Polygon
    Validator -->|scans ChannelClaimed events| Polygon
    Validator -->|sets weights| BT
    BT -->|TAO rewards| Provider
    MP -->|syncs scores| BT
```

**DRAIN path:** Discover providers ? Deposit USDC ? Send requests with signed vouchers ? Close channel

**MPP path:** Discover providers ? Send request ? Pay per-request via HTTP 402 (no channel needed)

**For Providers:** Deploy template ? Register on marketplace ? Serve AI inference ? Earn USDC

---

## Provider Templates

Ready-to-deploy provider templates for LLM proxies, API wrappers, and custom tools. Supports backends like OpenAI, Anthropic, xAI, OpenRouter, Replicate, Ollama, and many more.

Browse all templates in the [`providers/`](providers/) directory. Each template includes DRAIN voucher validation, automatic payment claiming, configurable pricing, health monitoring, and one-click Railway deployment.

---

## Quick Start ù Deploy a Provider

```mermaid
flowchart LR
    S1["1. Fork Template\ngit clone HS58"]
    S2["2. Configure\n.env: API_KEY,\nPRIVATE_KEY, RPC_URL"]
    S3["3. Deploy\nRailway one-click"]
    S4["4. Earning USDC\nAgents pay per request"]

    S1 --> S2 --> S3 --> S4
```

> Works with: OpenAI, Anthropic, xAI, Ollama, vLLM, any OpenAI-compatible API

### Prerequisites

- **Node.js** >= 18 and npm
- **Polygon wallet** ù You need a private key to receive USDC payments (see [Wallet Setup](#wallet-setup) below)
- **API key** for your chosen backend (e.g. OpenAI, Anthropic) ù not needed for self-hosted like Ollama
- **Alchemy account** (free) ù for reliable Polygon RPC ([sign up here](https://www.alchemy.com/))

### Step 1: Clone & Install

```bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/hs58-openai  # or hs58-claude, hs58-grok, hs58-custom, etc.

npm install
cp env.example .env
```

### Step 2: Configure .env

```bash
# Required
OPENAI_API_KEY=sk-...                 # Your backend API key
PROVIDER_PRIVATE_KEY=0x...            # Polygon wallet private key (receives USDC)

# Recommended ù use Alchemy for reliable claiming (free tier is fine)
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

### Step 3: Run locally or deploy

**Local:**
```bash
npm run dev
# Provider runs at http://localhost:3000
# Test: curl http://localhost:3000/health
```

**Railway (recommended for production):**
1. Fork this repo on GitHub
2. Go to [railway.app](https://railway.app) ? New Project ? Deploy from GitHub Repo
3. Select your fork, set **Root Directory** to `/providers/hs58-openai` (or your template)
4. Add environment variables in the **Variables** tab
5. Deploy ù Railway auto-detects the `railway.json` and builds

### Step 4: Register on the Marketplace

Once your provider is running, visit [handshake58.com/become-provider](https://handshake58.com/become-provider) to submit your provider for listing. Bittensor miners are auto-verified; community providers need admin approval.

---

## Wallet Setup

### Polygon Wallet (for Providers)

You need a Polygon wallet to receive USDC payments. The private key goes into `PROVIDER_PRIVATE_KEY`.

**Option A: MetaMask (easiest)**
1. Install [MetaMask](https://metamask.io/)
2. Create a new account
3. Export the private key: Account Details ? Export Private Key
4. Copy the `0x...` private key into your `.env`

**Option B: Command line**
```bash
# Using cast (from Foundry)
cast wallet new
# Output: Address: 0x... Private Key: 0x...

# Or using Node.js
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address, '\nPrivate Key:', w.privateKey)"
```

> **Important:** Fund your wallet with a small amount of POL for gas (~$0.01 is enough). You can bridge from any chain or buy on an exchange.

### Bittensor Wallet (for Miners/Validators)

See the [HS58-subnet README](https://github.com/Handshake58/HS58-subnet) for Bittensor wallet setup with `btcli`.

---

## For Miners (Bittensor Subnet 58)

Run a provider + register as a Bittensor miner to earn TAO incentives.

### 10 Minute Setup

1. **Deploy a provider** ù Pick a template above, deploy on Railway (see [Quick Start](#quick-start--deploy-a-provider))
2. **Install btcli** ù `pip install bittensor` (Python >= 3.9)
3. **Create wallet** ù `btcli wallet new_coldkey` + `btcli wallet new_hotkey`
4. **Fund with TAO** ù Send ~0.1 TAO to your coldkey for registration
5. **Register** ù `btcli subnet register --netuid 58`
6. **Deploy miner neuron** ù Fork [HS58-subnet](https://github.com/Handshake58/HS58-subnet), set `NEURON_TYPE=miner`
7. **Done** ù Miner auto-registers on handshake58.com, validator scores you

See the full guide in the [HS58-subnet README](https://github.com/Handshake58/HS58-subnet).

### Scoring

- **60% DRAIN Claims** ù Real USDC claimed from payment channels (7-day rolling window)
- **40% Availability** ù Provider responds to validator health checks with valid wallet proof

> **Score showing 0?** Run a [self-test payment](docs/score-keepalive.md) to generate on-chain claims and bootstrap your score (~$0.13/test).

### TAO Rewards

| Recipient | Share |
|-----------|-------|
| Miners | 41% |
| Validators | 41% |
| Subnet Owner | 18% |

Hardcoded in Yuma Consensus ù not configurable.

---

## For Validators

Run a validator to score providers on Subnet 58.

1. **Install btcli** ù `pip install bittensor`
2. **Create wallet + stake TAO** ù Need enough stake for weight-setting permission
3. Fork [HS58-subnet](https://github.com/Handshake58/HS58-subnet), set `NEURON_TYPE=validator`
4. Deploy on Railway as worker service
5. See the [HS58-subnet README](https://github.com/Handshake58/HS58-subnet) for full setup

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

The MCP server provides 12 tools: `drain_providers`, `drain_provider_info`, `drain_balance`, `drain_approve`, `drain_open_channel`, `drain_chat`, `mpp_chat`, `drain_channel_status`, `drain_channels`, `drain_close_channel`, `drain_cooperative_close`, `drain_feedback`.

**Provider categories:** `llm`, `image`, `audio`, `code`, `scraping`, `vpn`, `multi-modal`, `other`. For non-LLM providers, read docs via `drain_provider_info` before sending requests.

### API Discovery

```bash
# All providers
GET https://handshake58.com/api/mcp/providers

# Filter by category or model
GET https://handshake58.com/api/mcp/providers?model=gpt-4o&category=scraping&limit=3&format=compact
```

**Filters:** `model`, `category`, `tier` (bittensor/community), `minScore`, `limit`, `format` (compact/full)

### Custom Implementations (without drain-mcp)

If your agent can't install npm packages, use the REST API directly:

```bash
# Get EIP-712 signing parameters, voucher types, and provider endpoints
GET https://handshake58.com/api/drain/signing
```

### Agent Documentation

- [Full Protocol Docs (SKILL.md)](https://handshake58.com/skill.md)
- [Quick Reference (llms.txt)](https://handshake58.com/llms.txt)
- [Signing API](https://handshake58.com/api/drain/signing)
- [MCP Skill File (drain-mcp)](drain-mcp/SKILL.md)

---

## Contract Addresses

| Contract | Address | Network |
|----------|---------|---------|
| DRAIN Channel V2 | `0x0C2B3aA1e80629D572b1f200e6DF3586B3946A8A` | Polygon Mainnet |
| USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | Polygon Mainnet |

[View on Polygonscan](https://polygonscan.com/address/0x0C2B3aA1e80629D572b1f200e6DF3586B3946A8A)

---

## Repositories

| Repo | Description |
|------|-------------|
| **[HS58](https://github.com/Handshake58/HS58)** | This repo ù provider templates, docs, hub |
| [HS58-subnet](https://github.com/Handshake58/HS58-subnet) | Bittensor Subnet 58 validator + miner |
| [DRAIN Protocol](https://github.com/kimbo128/DRAIN) | Core protocol, smart contracts, SDK |

---

## Pricing

### DRAIN Protocol
- **Protocol fee:** 2% on provider claims (on-chain, deducted automatically)
- **Gas cost:** ~$0.02 per channel open/claim on Polygon
- **Provider markup:** Set by each provider (typically 20-50% on upstream costs)

### MPP Protocol
- **Protocol fee:** None
- **Gas cost:** None (off-chain HTTP 402)
- **Provider markup:** Set by each provider per request

---

## License

[PolyForm Shield 1.0](https://polyformproject.org/licenses/shield/1.0.0/) ù You can use, modify, and deploy this software for any purpose **except** building a competing product. See [LICENSE](LICENSE) for details.

---

Handshake58 &copy; 2026 ù Trustless AI payments powered by DRAIN Protocol & Bittensor
