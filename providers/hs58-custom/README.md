# HS58-Custom Provider

Generic DRAIN payment proxy for **any OpenAI-compatible API endpoint**. Works with:

- **Ollama** (`http://localhost:11434/v1`)
- **vLLM** (`http://localhost:8000/v1`)
- **Together AI** (`https://api.together.xyz/v1`)
- **Fireworks AI** (`https://api.fireworks.ai/inference/v1`)
- **LiteLLM** (`http://localhost:4000/v1`)
- **Any endpoint** that speaks the OpenAI chat completions format

## Quick Start

1. Set `CUSTOM_API_BASE_URL` to your endpoint
2. Set `CUSTOM_MODELS` to your model IDs (comma-separated)
3. Set `PROVIDER_PRIVATE_KEY` for DRAIN payments
4. Deploy

## Environment Variables

```bash
# Required
CUSTOM_API_BASE_URL=http://localhost:11434/v1
CUSTOM_API_KEY=                              # leave empty for local endpoints
CUSTOM_MODELS=llama3:8b,mistral:7b
PROVIDER_PRIVATE_KEY=0x...

# Recommended
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional
CUSTOM_PRICING={"llama3:8b":{"input":0.05,"output":0.10}}
CHAIN_ID=137
CLAIM_THRESHOLD=1000000
MARKUP_PERCENT=50
PROVIDER_NAME=HS58-Custom
PORT=3000
```

## Pricing

- Default: $0.10 input / $0.20 output per 1M tokens (+ markup)
- Custom: Set `CUSTOM_PRICING` as JSON (prices per 1M tokens in USD)
- Markup applies on top of configured prices (default 50%)

## API Endpoints

- `GET /v1/pricing` - View pricing
- `GET /v1/models` - List models
- `POST /v1/chat/completions` - Chat (requires X-DRAIN-Voucher)
- `GET /health` - Health check

## Deployment

1. Deploy to Railway with root directory `/providers/hs58-custom`
2. Set environment variables
3. Register in Handshake58 Marketplace
