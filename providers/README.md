# HS58 Provider Guide

This guide covers everything for running and integrating providers on the Handshake58 marketplace — from deploying your first provider to integrating a completely new service type.

---

## Part 1: Operations

Applies to all provider templates (`hs58-openai`, `hs58-grok`, `hs58-claude`, `hs58-chutes`, `hs58-openrouter`, `hs58-custom`).

### Voucher Storage (Critical)

Providers store signed DRAIN vouchers in a local JSON file (default: `./data/vouchers.json`). These vouchers are the **only proof of payment** — without them, the provider cannot claim earned USDC from the smart contract.

**Railway uses ephemeral storage by default.** Every redeploy wipes `./data/`, and all unclaimed vouchers are permanently lost.

#### Fix: Mount a Railway Volume

1. Railway Dashboard → Service → **Settings → Volumes**
2. Add volume, set mount path: `/app/data`
   (Nixpacks places the app at `/app`, so `./data` resolves to `/app/data`)
3. `STORAGE_PATH` stays at its default (`./data/vouchers.json`) — no env change needed

After this, voucher data survives redeploys, restarts, and crashes.

### Claim Configuration

Providers have two independent claim mechanisms:

| Mechanism | Trigger | Default | Env Variable |
|-----------|---------|---------|--------------|
| **Threshold claim** | Manual via `POST /v1/admin/claim` | >= 1 USDC | `CLAIM_THRESHOLD` |
| **Auto-claim** | Timer, channels near expiry | Every 10 min, 1h buffer | `AUTO_CLAIM_INTERVAL_MINUTES`, `AUTO_CLAIM_BUFFER_SECONDS` |

#### Recommended settings

**Testing / low-volume:**
```
CLAIM_THRESHOLD=0
AUTO_CLAIM_INTERVAL_MINUTES=2
AUTO_CLAIM_BUFFER_SECONDS=86400
```
Claims every voucher immediately (no minimum), checks every 2 minutes, claims channels expiring within 24 hours.

**Production / high-volume:**
```
CLAIM_THRESHOLD=1000000
AUTO_CLAIM_INTERVAL_MINUTES=10
AUTO_CLAIM_BUFFER_SECONDS=3600
```
Claims channels above $1 on manual trigger, auto-claims channels expiring within 1 hour. Reduces gas costs.

#### How claiming works

1. Agent opens a DRAIN channel and deposits USDC into the smart contract
2. Each `drain_chat` request includes a signed voucher (cumulative amount)
3. The provider stores the highest voucher per channel
4. At claim time, the provider submits the highest voucher on-chain and receives the USDC
5. After expiry, the agent can close the channel and reclaim the remaining deposit

**Race condition:** If the agent closes the channel before the provider claims, the agent gets the full deposit back and the provider earns nothing. The auto-claim mechanism prevents this by claiming before expiry.

### Polygon RPC

Claiming requires sending transactions to Polygon. The default public RPC is rate-limited and unreliable for transactions.

Set `POLYGON_RPC_URL` to a dedicated RPC endpoint (free tier available at [Alchemy](https://www.alchemy.com/), [Infura](https://www.infura.io/), or [QuickNode](https://www.quicknode.com/)):

```
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Without this, auto-claim transactions may silently fail due to rate limits.

### Pre-Deploy Checklist

- [ ] **Volume mounted** at `/app/data` (Railway) or `STORAGE_PATH` points to persistent directory
- [ ] **POL for gas** — provider wallet has at least 0.1 POL for claim transactions
- [ ] **RPC configured** — `POLYGON_RPC_URL` set to a reliable endpoint
- [ ] **Claim threshold** — `CLAIM_THRESHOLD` set appropriately for your volume
- [ ] **Auto-claim active** — verify `[auto-claim] Started` appears in logs after deploy

---

## Part 2: New Provider Integration Checklist

Integrating a new service into the Handshake58 marketplace? Fill out the sections below. The core question is:

> **"What do you sell, how do I call it, what does it cost, and how do I measure usage?"**

If sections **B** (API), **C** (Services), **D** (Pricing), and **F** (Execution) are filled out, any provider can be integrated — whether it's an LLM, scraper, VPN, or something entirely new. Everything else (`drain.ts`, `storage.ts`, `constants.ts`, Express boilerplate) stays identical across all templates.

### A. General — Who are you?

| Field | Required | Example |
|-------|----------|---------|
| **Provider Name** | Yes | MyService |
| **Short Description** | Yes | "Web scraping via Actors" |
| **Category / Service Type** | Yes | LLM, Scraping, VPN, Image Gen, ... |
| **Contact Email** | Yes | dev@example.com |
| **Website** | Optional | https://example.com |
| **Docs URL** | Optional | https://docs.example.com |
| **Logo URL** | Optional | Link to an image |

### B. API — How do I reach your service?

| Field | Required | Example |
|-------|----------|---------|
| **API Base URL** | Yes | https://api.example.com/v1 |
| **Auth Method** | Yes | API key, Bearer token, none |
| **Auth Header Name** | Yes | `Authorization: Bearer ...` or `x-api-key: ...` |
| **OpenAI-compatible?** | Yes | Yes / No / Partially |
| **Request format** (if not OpenAI) | Conditional | Example JSON of a request |
| **Response format** (if not OpenAI) | Conditional | Example JSON of a response |
| **Streaming (SSE)?** | Yes | Yes / No |
| **Rate limits?** | Optional | e.g. 60 req/min |
| **Test API key** | Recommended | Temporary key for testing |

### C. Services / "Models" — What do you offer?

| Field | Required | Examples |
|-------|----------|---------|
| **List of services/models** | Yes | LLM: `gpt-4o`, `claude-3.5-sonnet` / Apify: `apify/web-scraper` / TPN: `tpn/wireguard` |
| **Auto-discovery available?** | Yes | "Yes, via `GET /v1/models`" or "No, static list" |
| **If auto-discovery: endpoint + response format** | Conditional | URL + example JSON |

### D. Pricing — What does it cost?

Specify **one** of the following pricing models:

**Option 1: Token-based (LLMs)**

| Field | Example |
|-------|---------|
| Input price per 1M tokens (USD) | $2.50 |
| Output price per 1M tokens (USD) | $10.00 |
| Per model or flat rate? | Per model (provide a table) |

**Option 2: Per execution / flat rate (e.g. Apify)**

| Field | Example |
|-------|---------|
| Price per execution (USD) | $0.005 |
| Does the price vary per actor/service? | Yes → provide a table |

**Option 3: Time-based (e.g. TPN/VPN)**

| Field | Example |
|-------|---------|
| Price per hour (USD) | $0.005 |
| Minimum price per request (USD) | $0.001 |
| Max lease duration | 86400s (24h) |

**Option 4: Other model**

| Field | Example |
|-------|---------|
| Description of the pricing model | Free text |
| Formula / calculation | e.g. `price = fileSize × $0.01/MB` |

**Additionally for all pricing types:**

| Field | Required |
|-------|----------|
| **Pricing available via API?** | Yes → provide endpoint + response format |
| **Desired markup (%)** | e.g. 50% (default) |

### E. DRAIN / Blockchain — Payment info

| Field | Required | Explanation |
|-------|----------|-------------|
| **Polygon wallet address** | Yes | Must match `PROVIDER_PRIVATE_KEY` |
| **Network** | Yes | Mainnet (137) or Testnet (80002) |
| **Claim threshold** | Optional | Minimum amount before claiming (default: $0.01) |

### F. Execution Details — How does a request work?

This helps the most when writing the provider's `index.ts`:

| Field | Required | Examples |
|-------|----------|---------|
| **User input** | Yes | LLM: chat messages / Apify: JSON with actor params / TPN: `{lease_seconds: 3600, geo: "US"}` |
| **What happens in the backend?** | Yes | LLM: API call + token streaming / Apify: start actor, wait, fetch dataset / TPN: request lease |
| **Output to user** | Yes | LLM: generated text / Apify: scraped JSON / TPN: WireGuard config |
| **How is "usage" measured?** | Yes | Tokens (`usage.prompt_tokens`/`completion_tokens`) / number of items / lease duration |
| **Timeout / max wait time?** | Optional | e.g. Apify: 120s, TPN: instant |
| **Additional endpoints needed?** | Optional | e.g. TPN: `GET /v1/countries`, Apify: `GET /v1/docs` |

### G. Bonus — Makes life easier

| Field | Why it helps |
|-------|-------------|
| **SDK / npm package** | Saves writing a custom API client |
| **Example requests (curl)** | Faster testing |
| **Error codes + descriptions** | Better error handling |
| **Sandbox / test account** | Test without real costs |
