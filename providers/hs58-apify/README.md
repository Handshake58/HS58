# HS58-Apify Provider

DRAIN payment gateway for [Apify](https://apify.com) Actors — web scraping & data extraction payable with USDC micropayments.

## What it does

- Auto-loads the top 30 most popular Actors from the Apify Store on startup
- Auto-calculates DRAIN prices from Apify's live pricing data (with configurable markup)
- Refreshes the actor list every 6 hours
- Wraps Apify's task-based API behind the OpenAI chat completions format so any DRAIN agent can use it

## For AI Agents

This is **not** a chat provider. It runs Apify Actors (web scraping, data extraction, automation).

### How to use via DRAIN

1. List providers with `drain_providers` — find `HS58-Apify`
2. Open a payment channel with `drain_open_channel`
3. Call `drain_chat` with:
   - **model**: Actor ID from `/v1/models` (e.g. `apify/website-content-crawler`)
   - **messages**: One user message containing **valid JSON** = the Actor's input parameters

### Example

```
model: "apify/website-content-crawler"
messages: [
  {
    "role": "user",
    "content": "{\"startUrls\": [{\"url\": \"https://example.com\"}], \"maxCrawlPages\": 5}"
  }
]
```

The response contains scraped data as JSON in the assistant message.

### Pricing

Flat rate per Actor run (not per token). Prices are auto-calculated from Apify's pricing and include a markup. Check `/v1/pricing` for current prices.

### Finding input schemas

Each Actor has its own input format. Find the schema at:
```
https://apify.com/{actorId}
```
Replace `{actorId}` with the model ID (e.g. `apify/web-scraper`).

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/models` | GET | List all available Actors with descriptions |
| `/v1/pricing` | GET | Current prices per Actor run |
| `/v1/docs` | GET | Agent-readable usage instructions |
| `/v1/chat/completions` | POST | Run an Actor (requires DRAIN voucher) |
| `/health` | GET | Health check |
| `/v1/admin/stats` | GET | Provider stats |
| `/v1/admin/claim` | POST | Force voucher claim |
| `/v1/admin/refresh-actors` | POST | Reload actors from Apify Store |

## Self-Hosting

### Prerequisites

- Node.js 18+
- [Apify account](https://apify.com) with API token
- Polygon wallet with some MATIC for gas

### Setup

```bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/hs58-apify
npm install
cp env.example .env
```

Edit `.env`:

```
PROVIDER_PRIVATE_KEY=0xYourPolygonPrivateKey
APIFY_API_TOKEN=apify_api_YourToken
```

### Run

```bash
npm run build
npm start
```

The server starts, loads actors from the Apify Store, calculates pricing, and is ready to accept DRAIN payments.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `PROVIDER_PRIVATE_KEY` | required | Polygon wallet private key |
| `APIFY_API_TOKEN` | required | Apify API token |
| `POLYGON_RPC_URL` | public | Polygon RPC endpoint |
| `PORT` | 3000 | Server port |
| `APIFY_ACTOR_LIMIT` | 30 | Number of top actors to load |
| `APIFY_MARKUP_PERCENT` | 100 | Markup over Apify cost (100 = 2x) |
| `APIFY_MAX_ITEMS` | 50 | Max result items per run |
| `APIFY_MAX_WAIT` | 120 | Max seconds to wait for Actor completion |
| `CLAIM_THRESHOLD` | 1000000 | Auto-claim threshold in USDC wei (1.0 USDC) |

### Deploy on Railway

1. Fork [Handshake58/HS58](https://github.com/Handshake58/HS58)
2. Create a new Railway service from the repo
3. Set root directory to `/providers/hs58-apify`
4. Add environment variables (`PROVIDER_PRIVATE_KEY`, `APIFY_API_TOKEN`)
5. Deploy

## Architecture

```
Agent -> drain_chat(model="apify/web-scraper", input=JSON)
           |
           v
     HS58-Apify Provider
           |
           +-- Validates DRAIN voucher
           +-- Resolves Actor ID
           +-- POST /v2/acts/{actorId}/runs (Apify API)
           +-- Polls for completion (waitForFinish)
           +-- GET /v2/datasets/{id}/items
           +-- Returns scraped data as assistant message
           +-- Stores voucher for later claim
```

## Links

- [DRAIN Protocol](https://github.com/kimbo128/DRAIN)
- [Handshake58 Marketplace](https://handshake58.com)
- [Apify Store](https://apify.com/store)
