---
name: provider-builder
description: Build and integrate DRAIN providers for the Handshake58 marketplace. Use when the user wants to add a new provider, integrate an API, wrap a service, or build a custom tool as a paid DRAIN provider. Covers LLM proxies, API wrappers, and self-built services.
---

# Provider Builder

Integrate any service into the Handshake58 marketplace as a DRAIN payment provider. This skill covers three provider types:

- **Typ A: LLM-Proxy** -- OpenAI-compatible API via SDK (Ref: `hs58-openai`, `hs58-claude`)
- **Typ B: API-Wrapper** -- External API via fetch/SDK (Ref: `hs58-apify`, `hs58-resend`, `hs58-tempsh`)
- **Typ C: Self-Built** -- Custom logic, no external API (e.g. Word-to-PDF, image processor)

All providers share the same DRAIN payment shell. Only the core logic differs.

Reference providers live in `providers/` in the HS58 repo. Read the closest reference before building.

## Phase 1: Discovery / Design

### Typ A+B (existing API)

1. Read the API docs (URL, GitHub, scrape if needed)
2. Probe endpoints: Is it OpenAI-compatible? REST? Needs SDK?
3. Walk the decision tree:

```
OpenAI-compatible? → Pattern 1: LLM-Proxy + SSE (Ref: hs58-openai, hs58-claude)
Immediate response? → Pattern 2: Flat-Rate (Ref: hs58-resend, hs58-vericore)
Async job + polling? → Pattern 3: Async/Polling (Ref: hs58-apify, hs58-replicate)
File upload/download? → Pattern 4: Binary I/O (Ref: hs58-faster-whisper, hs58-tempsh)
Price = f(duration)? → Pattern 5: Time-based (Ref: community-tpn)
Models loaded from API? → Pattern 6: Dynamic Registry (Ref: hs58-openrouter)
Sandbox lifecycle? → Pattern 7: Code Execution (Ref: hs58-e2b)
```

Patterns combine: e.g. OpenRouter = Pattern 1 + Pattern 6.

4. Ask the user for missing info: API key, auth method, pricing model, rate limits.

### Typ C (self-built)

1. Ask: What does the service do? What is the input? What is the output?
2. What libraries/tools are needed? System dependencies (ffmpeg, LibreOffice)?
3. Define the pricing model: flat per request, per unit, time-based?
4. Sketch the core logic module (e.g. `converter.ts`, `processor.ts`)

## Phase 2: Scaffolding

### Directory structure

```
community-{name}/
├── src/
│   ├── index.ts          # Express server + all endpoints
│   ├── config.ts          # Env loading, loadConfig(), loadModels()
│   ├── types.ts           # Shared + provider-specific types
│   ├── drain.ts           # COPY from reference (never modify)
│   ├── storage.ts         # COPY from reference (never modify)
│   ├── constants.ts       # COPY from reference (never modify)
│   └── [service].ts       # Provider-specific logic (Typ B/C)
├── package.json
├── tsconfig.json
├── railway.json
├── env.example
├── README.md
└── .gitignore
```

### Naming

- Directory: `community-{name}`
- package.json name: `@handshake58/community-{name}`
- Model IDs: `{prefix}/{model}` (e.g. `word2pdf/convert`, `myapi/search`)

### Shared DRAIN code -- COPY VERBATIM

Copy `drain.ts`, `storage.ts`, `constants.ts`, and the base types in `types.ts` from the nearest reference provider. **Never modify these files.** They handle voucher validation, EIP-712 signatures, on-chain claiming, and JSON file storage.

### package.json

```json
{
  "name": "@handshake58/community-{name}",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "viem": "^2.0.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.0",
    "@types/express": "^4.17.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

Add provider-specific deps: `openai` for LLM proxies, `@anthropic-ai/sdk` for Claude, `multer` for file uploads, etc.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

### railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### .gitignore

```
node_modules/
dist/
.env
*.log
package-lock.json
data/
```

### env.example

Always include these universal variables:

```bash
# === REQUIRED ===
PROVIDER_PRIVATE_KEY=0xYOUR_POLYGON_PRIVATE_KEY
{SERVICE}_API_KEY=your-api-key-here          # If wrapping an external API

# === DRAIN / BLOCKCHAIN ===
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=137                                  # 137=Polygon, 80002=Amoy testnet
CLAIM_THRESHOLD=1000000                       # Min USDC-wei before auto-claim ($1)
AUTO_CLAIM_INTERVAL_MINUTES=10
AUTO_CLAIM_BUFFER_SECONDS=3600
STORAGE_PATH=./data/vouchers.json

# === SERVER ===
PORT=3000
HOST=0.0.0.0
PROVIDER_NAME=Community-{Name}

# === PRICING ===
MARKUP_PERCENT=50                             # Markup on base prices

# === OPTIONAL ===
ADMIN_PASSWORD=                               # Protect /v1/admin/* endpoints
RATE_LIMIT_PER_MINUTE=30                      # Per-channel rate limit
```

Add provider-specific vars (pricing params, limits, timeouts, etc.).

## Phase 2a: SSE Streaming (Pattern 1 -- LLM Proxies)

All LLM proxies must support both streaming and non-streaming. The pattern is identical across all providers:

**Streaming response:**
1. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-DRAIN-Channel: {id}`
2. Forward chunks: `res.write(\`data: ${JSON.stringify(chunk)}\n\n\`)`
3. Track tokens from `chunk.usage` or estimate with `content.length / 4`
4. After stream ends: `res.write('data: [DONE]\n\n')`
5. Send cost as SSE comments (NOT HTTP headers):
```
: X-DRAIN-Cost: {amount}
: X-DRAIN-Total: {total}
: X-DRAIN-Remaining: {remaining}
```
6. `res.end()`

**Non-streaming response:**
1. Get actual token counts from `completion.usage`
2. Calculate actual cost
3. Re-validate voucher with actual cost (return 402 if insufficient)
4. Set response headers: `X-DRAIN-Cost`, `X-DRAIN-Total`, `X-DRAIN-Remaining`, `X-DRAIN-Channel`
5. Return the completion JSON

**Pre-auth estimation** (both modes): Estimate input tokens as `JSON.stringify(messages).length / 4`, assume 50 output tokens minimum. Validate voucher against this estimate before calling upstream.

**Anthropic exception:** Use `anthropic.messages.stream()` with event-based callbacks (`stream.on('text', ...)`) instead of `for await`.

## Phase 2b: Dynamic Registry (Pattern 6)

For providers where models come from an API (OpenRouter, Apify, Replicate):

1. `fetchModels()` from upstream API on startup
2. Store in a global `Map<string, ModelPricing>` cache
3. Refresh periodically: `setInterval(() => updatePricingCache(), refreshInterval)`
4. Expose `/v1/admin/refresh-models` for manual refresh
5. Convert upstream pricing to DRAIN format: `price * 1000 * 1_000_000 * markup`

## Pricing Strategy

The agent must set a sensible price. Use the following decision framework:

### Step 1: Determine upstream cost

| Provider type | How to find upstream cost |
|---|---|
| LLM-Proxy (OpenAI, Claude, etc.) | Read upstream API pricing page. Price is per-token. |
| API-Wrapper (Apify, Resend, etc.) | Check the API's pricing: per-call cost, per-item cost, or free tier. |
| Self-Built (no upstream) | Estimate compute cost: Railway ~$5/mo for hobby. Amortize over expected request volume. |

### Step 2: Apply markup

| Upstream cost | Recommended markup | Rationale |
|---|---|---|
| Known, per-token (LLM) | 50% (`MARKUP_PERCENT=50`) | Standard across all LLM providers |
| Known, per-call (cheap API) | 50-100% | Cover overhead + profit margin |
| Estimated/free (Apify FREE tier) | 100% (`MARKUP_PERCENT=100`) | Higher risk, uncertain cost |
| No upstream cost (self-built) | N/A -- set absolute price | $0.005-0.05 per request typical |
| Expensive upstream ($0.10+) | 30-50% | Keep competitive |

### Step 3: Convert to USDC-wei

All prices must be in USDC-wei (6 decimals). The conversion:

```typescript
const priceWei = BigInt(Math.ceil(priceUsd * 1_000_000));
// $0.003 → 3000n
// $0.05  → 50000n
// $1.00  → 1000000n
```

### Step 4: Choose pricing model

| Pattern | Cost formula | Example |
|---|---|---|
| **Per-token** (LLM) | `(inputTokens * inputPer1k + outputTokens * outputPer1k) / 1000` | OpenAI, Claude |
| **Flat per request** | `cost = fixedPrice` | Resend ($0.003), E2B ($0.02), Vericore |
| **Per unit** (file size, items) | `cost = pricePerUnit * units` | TempSh per-MB, Desearch per-1000-items |
| **Time-based** | `cost = max(minPrice, duration/60 * hourlyRate)` | TPN VPN leases |
| **Dynamic per model** | `cost = modelSpecificPrice` from upstream pricing | Apify actors, Replicate tiers |

For flat-rate providers: set `inputPer1kTokens` to the flat price, `outputPer1kTokens` to `"0"`.

### Reference pricing from existing providers

| Provider | Price per request | Upstream cost | Effective markup |
|---|---|---|---|
| hs58-resend | $0.0045 | ~$0.0004/email | ~11x |
| hs58-e2b (Python) | $0.03 | ~$0.001/30s | ~30x |
| hs58-apify (free actors) | $0.01 | $0 | infinite |
| hs58-cronjob (create) | $0.075 | ~$0.01/job | ~7.5x |
| community-tpn | $0.005/hr | variable | ~1x |
| hs58-tempsh | $0.0075/upload | free | infinite |

## Claiming Strategy

The auto-claim system claims vouchers from channels that are about to expire. Choose settings based on the service type:

### Claim threshold (CLAIM_THRESHOLD)

This is the minimum amount (USDC-wei) before manual claiming kicks in. Auto-claim ignores this -- it claims ALL expiring channels regardless of amount.

| Service type | Recommended threshold | Rationale |
|---|---|---|
| High-volume LLM (many small txns) | `10000000` ($10) | Avoid gas costs on tiny amounts |
| Medium-volume API wrapper | `1000000` ($1) | Default, good balance |
| Low-volume expensive service | `50000` ($0.05) | Claim sooner, amounts are larger per-txn |
| One-off services (email, code exec) | `1000000` ($1) | Default works fine |

### Auto-claim interval (AUTO_CLAIM_INTERVAL_MINUTES)

How often to check for expiring channels. Default `10` minutes works for all providers. No provider has changed this.

### Auto-claim buffer (AUTO_CLAIM_BUFFER_SECONDS)

Claim channels expiring within this window. Default `3600` (1 hour) works for all providers. This ensures channels are claimed before they expire and funds become inaccessible.

### Why NOT claim immediately after delivery?

No existing provider does this because:
1. Gas costs would eat into micro-payments (claiming costs ~$0.01 in POL)
2. Channels typically have multiple requests, so waiting accumulates a larger amount
3. Auto-claim catches expiring channels automatically
4. The voucher is safely stored -- funds are secured even without immediate claiming

For one-off expensive services ($10+ per request), a lower threshold ensures manual claiming triggers sooner.

## Cost Calculation Patterns

Choose the right `calculateCost` function based on your pricing model:

### Flat-rate (most common for non-LLM)

```typescript
function calculateCost(_model: string): bigint {
  return getModelPricing(model).inputPer1k; // flat price = inputPer1k
}
```

### Token-based (LLM proxies)

```typescript
function calculateCost(pricing: ModelPricing, inputTokens: number, outputTokens: number): bigint {
  return (pricing.inputPer1k * BigInt(inputTokens) + pricing.outputPer1k * BigInt(outputTokens)) / 1000n;
}
```

### Per-unit (file size, item count, duration)

```typescript
// Per-MB example (tempsh)
function calculateCost(fileSizeBytes: number): bigint {
  const mb = Math.max(1, Math.ceil(fileSizeBytes / (1024 * 1024)));
  return config.pricePerMb * BigInt(mb);
}

// Time-based example (tpn)
function calculateCost(minutes: number): bigint {
  const durationCost = (config.hourlyPriceWei * BigInt(minutes)) / 60n;
  return durationCost > config.minPriceWei ? durationCost : config.minPriceWei;
}
```

### Post-hoc pricing (LLM proxies only)

When the actual cost is only known AFTER the API call (because token count is unknown upfront):

1. **Pre-auth**: Estimate cost with `inputTokens ≈ JSON.stringify(messages).length / 4`, assume 50 output tokens. Validate voucher with this estimate.
2. **Execute**: Call upstream API.
3. **Post-auth**: Calculate actual cost from `completion.usage.prompt_tokens` / `completion_tokens`.
4. **Non-streaming only**: Re-validate voucher with actual cost. If insufficient, return 402 with `code: 'insufficient_funds_post'`. (For streaming, the response is already sent, so just store the actual cost.)

## Rate Limiting

Optional but recommended for services that are abusable or expensive.

### When to add rate limiting

| Service type | Rate limit? | Recommended |
|---|---|---|
| LLM proxy | No | Upstream has its own limits |
| Email sending | Yes | 30/min per channel (prevent spam) |
| File upload | Yes | 20/min per channel |
| Code execution | Optional | 10/min (resource intensive) |
| Scraping | Optional | Depends on upstream limits |
| Self-built tool | Yes if expensive | 10-30/min |

### Implementation (per-channel sliding window)

```typescript
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const hits = rateLimitMap.get(channelId) ?? [];
  const recent = hits.filter(t => now - t < 60_000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  rateLimitMap.set(channelId, recent);
  return true;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, hits] of rateLimitMap) {
    const filtered = hits.filter(t => t > cutoff);
    if (filtered.length === 0) rateLimitMap.delete(id);
    else rateLimitMap.set(id, filtered);
  }
}, 5 * 60_000);
```

## Channel Duration Recommendations

When registering, you can set `minDuration` and `maxDuration` (in seconds) for payment channels:

| Service type | minDuration | maxDuration | Rationale |
|---|---|---|---|
| LLM proxy | 300 (5min) | 2592000 (30d) | Long sessions, many requests |
| One-off API | 60 (1min) | 86400 (1d) | Short interactions |
| Self-built tool | 60 (1min) | 86400 (1d) | Short interactions |
| Subscription-like | 3600 (1hr) | 2592000 (30d) | Long-term usage |

Most providers omit these fields (no restriction). Only set them if there is a specific reason.

## 7 Required Endpoints

Every provider MUST implement these. The `POST /v1/chat/completions` handler is the core -- all others are mostly boilerplate.

### GET /v1/pricing

**This endpoint is the gateway to the marketplace.** The connection test checks it during registration. If it fails, the provider is rejected.

```typescript
app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, any> = {};
  for (const [id, pricing] of modelMap) {
    models[id] = {
      inputPer1kTokens: formatUnits(pricing.inputPer1k, 6),
      outputPer1kTokens: formatUnits(pricing.outputPer1k, 6),
    };
  }
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    models,
  });
});
```

**Hard requirements (marketplace connection test):**
1. HTTP 200 within 10 seconds
2. Response has `provider` (string) AND `models` (object)
3. `provider` matches the wallet address used for registration (case-insensitive)
4. `models` has at least one entry
5. Each model has `inputPer1kTokens` and `outputPer1kTokens` as strings

For flat-rate providers: `inputPer1kTokens` = price per request, `outputPer1kTokens` = `"0"`.

### GET /v1/models

```typescript
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: getSupportedModels().map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: id.split('/')[0],
    })),
  });
});
```

### GET /v1/docs

Returns `text/plain` markdown. This is how AI agents learn to use the provider. **If docs are missing or under 100 characters, the marketplace marks the provider as DEGRADED and agents cannot discover it.**

Use one of two templates:

**LLM template** (Pattern 1):
```
# {PROVIDER_NAME} — Agent Instructions
Standard OpenAI-compatible LLM provider via DRAIN payments.
## How to use via DRAIN
1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with: model + messages (standard chat format)
## Example
model: "{MODEL_ID}"
messages: [{"role": "user", "content": "Explain quantum computing"}]
Streaming is supported (stream: true).
## Top Models
{dynamic list with prices}
Full list: GET /v1/models | Full pricing: GET /v1/pricing
## Pricing
Per-token pricing in USDC. Cost = (input_tokens * input_rate + output_tokens * output_rate) / 1000.
## Notes
- Standard OpenAI chat completions format
- Streaming supported via stream: true
```

**Generic template** (Pattern 2-7, Typ C):
```
# {PROVIDER_NAME} — Agent Instructions
{Description. State "This is NOT a chat/LLM provider." if non-LLM.}
## How to use via DRAIN
1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "{MODEL_ID}"
   - messages: ONE user message containing {describe input format}
## Available Models / Operations
{Table or list: Model ID | Description | Price}
## Input Format
{Exactly what goes in the user message: JSON with fields X,Y,Z? Plain text? Code?}
## Example
model: "{MODEL_ID}"
messages: [{"role": "user", "content": "{concrete example}"}]
## Response
{What the assistant message contains: JSON fields? URLs? Text?}
## Pricing
{Flat rate / per-token / time-based}. Check /v1/pricing for current USDC rates.
## Notes
{Timeouts, limits, constraints}
```

**Checklist:**
- Content-Type: `text/plain`
- Length: 800-2500 characters
- Use dynamic values (prices, model IDs, timeouts) where possible
- An agent with ZERO prior knowledge must be able to use the provider from the docs alone

### GET /health

```typescript
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: drainService.getProviderAddress(), providerName: config.providerName });
});
```

### POST /v1/chat/completions -- Payment Flow

This is the core endpoint. The payment flow is identical for all providers:

```typescript
app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    return res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    return res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
  }

  // 3. Validate model
  const model = req.body.model;
  if (!isModelSupported(model)) {
    return res.status(400).json({ error: { message: `Model not supported: ${model}` } });
  }

  // 4. Calculate cost + validate voucher
  const cost = calculateCost(model, req.body);
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    const headers: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = cost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    return res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
  }

  const channelState = validation.channel!;

  // 5. [OPTIONAL] Rate limit
  // if (!checkRateLimit(voucher.channelId)) return res.status(429).json({ error: { message: 'Rate limit exceeded' } });

  // === YOUR PROVIDER LOGIC HERE ===
  // Call upstream API, run local logic, etc.
  // Get the result and calculate actual cost if different from estimate.

  // 6. Store voucher + respond
  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;
  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `${config.providerName}-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: resultContent }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
});
```

### POST /v1/close-channel

```typescript
app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { finalAmount, signature } = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: finalAmount.toString(), signature });
  } catch (error) {
    res.status(500).json({ error: 'internal_error' });
  }
});
```

### POST /v1/admin/claim

```typescript
app.post('/v1/admin/claim', async (req, res) => {
  if (config.adminPassword) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.adminPassword}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

## Phase 3: Build + Verify

1. Run `npm install` then `npm run build` -- TypeScript must compile with zero errors
2. If build fails, read the error, fix it, rebuild. Max 3 iterations.
3. Verify all 7 endpoints exist in the compiled code
4. Check pricing format: `models` object with `inputPer1kTokens`/`outputPer1kTokens` as strings

## Phase 4: Marketplace Compliance

Simulate the connection test mentally:
- `GET /v1/pricing` returns 200 with `provider` + non-empty `models` object? 
- `provider` address derives from `PROVIDER_PRIVATE_KEY`?
- `GET /v1/docs` returns 200 with 100+ characters of text/plain?
- All model IDs follow `prefix/name` format?

## Phase 5: Registration Data + Logo

Generate all data the user needs for marketplace registration.

### Logo

Generate an SVG logo using the GenerateImage tool. Simple, clean icon representing the service. The user will host it (e.g. on GitHub) and use the raw URL as `logoUrl`.

### Registration payload

Output a ready-to-use JSON for `POST /api/directory/providers`:

```json
{
  "name": "{Provider Name}",
  "apiUrl": "[FILL AFTER DEPLOY - Railway URL]",
  "providerAddress": "[FILL - derived from PROVIDER_PRIVATE_KEY]",
  "description": "{1-2 sentence description}",
  "contactEmail": "[FILL - user's email]",
  "logoUrl": "[FILL - hosted logo URL]",
  "website": "[FILL - user's website]",
  "category": "{one of: llm, image, audio, video, code, multi-modal, scraping, search, data, scheduling, network, forecasting, other}",
  "additionalCategories": [],
  "supportsStreaming": false
}
```

**Profile completeness warning:** The provider is INVISIBLE to AI agents unless ALL 5 fields are set:
- `description` (20%) -- generated by this skill
- `logoUrl` (20%) -- generated by this skill, user must host
- `website` (20%) -- user must provide
- `docsUrl` or `apiUrl` (20%) -- automatic via /v1/docs
- `contactEmail` (20%) -- user must provide

Without 100% completeness, the provider will not appear in `drain_providers` results.

### Post-registration

Status starts as `pending`. An admin must approve the provider. After approval, the marketplace health-check system periodically calls `/v1/pricing` and `/v1/docs` to verify the provider is online.

## Phase 6: Git + PR

1. Create branch: `provider/community-{name}`
2. Stage all files EXCEPT `node_modules/`, `dist/`, `.env`, `*.log`, `package-lock.json`, `data/`
3. Commit: `feat(providers): add community-{name} provider`
4. Push and create PR to `Handshake58/HS58` with summary of what the provider does, which models it exposes, and the pricing model

## Quick Reference: Provider Categories

`llm` | `image` | `audio` | `video` | `code` | `multi-modal` | `scraping` | `search` | `data` | `scheduling` | `network` | `forecasting` | `other`
