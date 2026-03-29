# Community-Targon Provider

DRAIN payment gateway for [Targon](https://targon.com) (Bittensor Subnet 4). Provides decentralized LLM inference with 500+ open-source models via USDC micropayments.

## Features

- **500+ Models** — Access all models hosted on Targon's decentralized inference network
- **OpenAI-compatible** — Standard chat completions API with streaming support
- **Dynamic pricing** — Auto-refreshes model list and pricing from Targon API
- **Confidential compute** — Powered by Targon Virtual Machine (TVM) with Intel TDX / NVIDIA confidential computing

## Setup

1. Copy `env.example` to `.env`
2. Set `PROVIDER_PRIVATE_KEY` (Polygon wallet for receiving USDC)
3. Set `TARGON_API_KEY` (from [targon.com/settings](https://targon.com/settings))
4. Set `POLYGON_RPC_URL` (Alchemy/Infura recommended for reliable claiming)
5. `npm install && npm run build && npm start`

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `TARGON_API_KEY` | Yes | Targon API key |
| `PROVIDER_PRIVATE_KEY` | Yes | Polygon wallet for receiving USDC |
| `POLYGON_RPC_URL` | Recommended | Polygon RPC for claiming |
| `TARGON_API_URL` | No | Base URL (default `https://api.targon.com/v1`) |
| `MARKUP_PERCENT` | No | Markup on base prices (default 50) |
| `DEFAULT_INPUT_PRICE_PER_M` | No | Fallback input price per M tokens (default $0.50) |
| `DEFAULT_OUTPUT_PRICE_PER_M` | No | Fallback output price per M tokens (default $1.50) |
| `PRICING_REFRESH_INTERVAL` | No | Seconds between model list refresh (default 3600) |

## API

- `GET /v1/pricing` — Model pricing (supports `?filter=llama`)
- `GET /v1/models` — List all available models
- `GET /v1/docs` — Agent instructions (plain text)
- `POST /v1/chat/completions` — Chat with DRAIN voucher (streaming supported)
- `GET /health` — Health check
- `POST /v1/close-channel` — Cooperative close
- `POST /v1/admin/claim` — Claim payments (Bearer auth)
- `POST /v1/admin/refresh-pricing` — Force refresh models from Targon
- `GET /v1/admin/stats` — Provider statistics

## Architecture

```
Agent → drain-mcp → Community-Targon Provider → Targon API (api.targon.com/v1)
                           ↕                           ↕
                    Polygon (USDC)              Bittensor Subnet 4
```

The provider proxies OpenAI-compatible requests to Targon's decentralized inference network, handling DRAIN payment validation, voucher storage, and auto-claiming.
