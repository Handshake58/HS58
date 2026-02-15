# HS58-Custom Provider

Generic DRAIN payment proxy for **any OpenAI-compatible API endpoint**. Works with:

- **Ollama** (`http://localhost:11434/v1`)
- **vLLM** (`http://localhost:8000/v1`)
- **Together AI** (`https://api.together.xyz/v1`)
- **Fireworks AI** (`https://api.fireworks.ai/inference/v1`)
- **LiteLLM** (`http://localhost:4000/v1`)
- **Any endpoint** that speaks the OpenAI chat completions format

---

## Prerequisites

- **Node.js** >= 18 and npm
- **Polygon wallet** with a private key ([how to create one](https://github.com/Handshake58/HS58#wallet-setup))
- **MATIC** for gas (~$0.01) in your Polygon wallet
- An **OpenAI-compatible API** running somewhere (cloud or local)

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/hs58-custom

npm install
cp env.example .env
```

### 2. Configure .env

```bash
# Required
CUSTOM_API_BASE_URL=http://localhost:11434/v1    # Your API endpoint
CUSTOM_API_KEY=                                   # Leave empty for local (Ollama, vLLM)
CUSTOM_MODELS=llama3:8b,mistral:7b               # Comma-separated model IDs
PROVIDER_PRIVATE_KEY=0x...                        # Polygon private key (receives USDC)

# Recommended — use Alchemy for reliable claiming (free tier is fine)
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional (defaults shown)
CUSTOM_PRICING={"llama3:8b":{"input":0.05,"output":0.10}}   # Per 1M tokens in USD
CHAIN_ID=137                    # 137=Polygon, 80002=Amoy testnet
CLAIM_THRESHOLD=1000000         # Min amount to claim (1 USDC)
MARKUP_PERCENT=50               # Markup on upstream prices
PROVIDER_NAME=HS58-Custom       # Name shown in API responses
PORT=3000
```

### 3. Run

```bash
npm run dev
# Provider runs at http://localhost:3000
# Test: curl http://localhost:3000/health
```

---

## Example: Ollama Setup

Run a local Ollama instance and expose it via DRAIN payments:

```bash
# 1. Install Ollama (https://ollama.com)
ollama pull llama3:8b
ollama pull mistral:7b

# 2. Verify Ollama is running
curl http://localhost:11434/v1/models

# 3. Configure hs58-custom .env
CUSTOM_API_BASE_URL=http://localhost:11434/v1
CUSTOM_API_KEY=
CUSTOM_MODELS=llama3:8b,mistral:7b
CUSTOM_PRICING={"llama3:8b":{"input":0.05,"output":0.10},"mistral:7b":{"input":0.03,"output":0.06}}

# 4. Start the provider
npm run dev
```

> **Note:** For production, deploy Ollama on a GPU server and this provider on Railway (or any Node.js host). Set `CUSTOM_API_BASE_URL` to your Ollama server's public URL.

---

## Pricing

- **Default:** $0.10 input / $0.20 output per 1M tokens (+ markup)
- **Custom:** Set `CUSTOM_PRICING` as JSON — prices per 1M tokens in USD
- **Markup:** Applies on top of configured prices (default 50%)

Example pricing JSON:
```json
{
  "llama3:8b": { "input": 0.05, "output": 0.10 },
  "mistral:7b": { "input": 0.03, "output": 0.06 },
  "codellama:13b": { "input": 0.08, "output": 0.15 }
}
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check — returns provider status |
| `/v1/pricing` | GET | View model pricing |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (requires `X-DRAIN-Voucher` header) |

---

## Deployment (Railway)

1. Fork the [HS58 repo](https://github.com/Handshake58/HS58) on GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
3. Select your fork, set **Root Directory** to `/providers/hs58-custom`
4. Add environment variables in the **Variables** tab
5. Deploy — Railway auto-detects the `railway.json` and builds

### Register on the Marketplace

Once your provider is running and accessible:

1. Go to [handshake58.com/become-provider](https://handshake58.com/become-provider)
2. Submit your provider URL and Polygon wallet address
3. **Bittensor miners** are auto-verified (if registered on Subnet 58)
4. **Community providers** need admin approval (typically within 24h)

After registration, AI agents can discover and pay your provider through the marketplace.

---

## Related

- [HS58 Hub](https://github.com/Handshake58/HS58) — All provider templates + docs
- [HS58-subnet](https://github.com/Handshake58/HS58-subnet) — Become a Bittensor miner for TAO rewards
- [Wallet Setup Guide](https://github.com/Handshake58/HS58#wallet-setup) — Create a Polygon wallet
