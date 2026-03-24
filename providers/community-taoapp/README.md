# Community TaoApp Provider

DRAIN payment gateway for the [TAO.app API](https://api.tao.app/docs) — raw and curated Bittensor data spanning block-level chain data, subnet price history, subnet analytics, metagraph state, validator/staking info, community sentiment, and portfolio accounting.

## What it does

Wraps the TAO.app REST API behind DRAIN micropayments. Agents send structured JSON queries and receive raw API responses.

**Model:** `taoapp/query`
**Pricing:** $0.005 per request (flat rate)
**Endpoints:** 50+ covering macro analytics, subnet OHLC, metagraph, portfolio, accounting, validators, blocks, social analytics, and more.

## Setup

```bash
cp env.example .env
# Edit .env with your keys
npm install
npm run build
npm start
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PROVIDER_PRIVATE_KEY` | Yes | Polygon wallet private key |
| `TAOAPP_API_KEY` | Yes | TAO.app API key |
| `POLYGON_RPC_URL` | Recommended | Alchemy/Infura Polygon RPC |
| `CHAIN_ID` | No | 137 (Polygon) or 80002 (Amoy) |
| `PRICE_PER_REQUEST_USDC` | No | Default: 0.005 |
| `RATE_LIMIT_PER_MINUTE` | No | Default: 10 (matches Free tier) |

### TAO.app API Tiers

| Tier | Calls/month | Rate limit |
|---|---|---|
| Free | 15,000 | 10 req/min |
| Standard | 75,000 | 75 req/min |
| Premium | 600,000 | 300 req/min |

Set `RATE_LIMIT_PER_MINUTE` to match your tier.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/pricing` | GET | DRAIN pricing info |
| `/v1/models` | GET | Available models |
| `/v1/docs` | GET | Agent instructions |
| `/v1/chat/completions` | POST | Query TAO.app API |
| `/v1/close-channel` | POST | Close payment channel |
| `/v1/admin/claim` | POST | Claim payments |
| `/health` | GET | Health check |

## Deploy

Deploy to Railway with the included `railway.json` config.
