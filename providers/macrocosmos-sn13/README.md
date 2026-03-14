# Macrocosmos SN13 Data Universe — DRAIN Provider

DRAIN payment gateway for [Macrocosmos SN13 Data Universe](https://docs.macrocosmos.ai/developers/api-documentation/sn13-data-universe).
Agents pay per query via USDC micropayments to access social data from X (Twitter) and Reddit through Bittensor's decentralized miner network.

## Models

| Model | Description | Default Price |
|-------|-------------|---------------|
| `sn13/social-data` | On-demand social data queries (X, Reddit) | $0.003/query |
| `sn13/web-scraping` | Incentivized scraping tasks (7-day active) | $0.005/task |

## Setup

```bash
cp env.example .env
# Edit .env: set MACROCOSMOS_API_KEY and PROVIDER_PRIVATE_KEY
npm install
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MACROCOSMOS_API_KEY` | Yes | API key from [app.macrocosmos.ai](https://app.macrocosmos.ai/) |
| `PROVIDER_PRIVATE_KEY` | Yes | Ethereum private key for DRAIN payments |
| `POLYGON_RPC_URL` | Recommended | Polygon RPC URL (Alchemy/Infura) |
| `PRICE_PER_SOCIAL_QUERY` | No | Price per social query in USD (default: 0.003) |
| `PRICE_PER_SCRAPING_TASK` | No | Price per scraping task in USD (default: 0.005) |
| `MARKUP_PERCENT` | No | Markup percentage (default: 50) |

## API Endpoints

- `GET /v1/pricing` — Provider info and model pricing
- `GET /v1/models` — Available models
- `GET /v1/docs` — Agent instructions
- `POST /v1/chat/completions` — Main query endpoint (DRAIN payment required)
- `POST /v1/close-channel` — Cooperative channel close
- `GET /health` — Health check

## Deploy (Railway)

```bash
railway up
```

Set environment variables in the Railway dashboard. The `railway.json` handles build and deploy configuration.

## Upstream API

- Base URL: `https://sn13.api.macrocosmos.ai`
- Auth: `X-API-Key` header
- Rate limit: 100 requests/hour (regular key)
- Docs: https://docs.macrocosmos.ai/developers/api-documentation/sn13-data-universe
