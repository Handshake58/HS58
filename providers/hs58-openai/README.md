# HS58-OpenAI Provider

OpenAI provider for the DRAIN Protocol with 50% markup on upstream prices.

## Supported Models

- **GPT-4o** - Flagship multimodal model
- **GPT-4o mini** - Fast and affordable
- **GPT-4 Turbo** - High capability
- **o1** - Advanced reasoning
- **o1-mini** - Compact reasoning
- **o3-mini** - Latest reasoning model
- **GPT-3.5 Turbo** - Legacy model

## Pricing

All prices include a 50% markup on OpenAI's official prices.

| Model | Input (per 1K tokens) | Output (per 1K tokens) |
|-------|----------------------|------------------------|
| gpt-4o | $0.00375 | $0.015 |
| gpt-4o-mini | $0.000225 | $0.0009 |
| o1 | $0.0225 | $0.09 |
| o1-mini | $0.0045 | $0.018 |
| o3-mini | $0.00165 | $0.0066 |

## Environment Variables

```bash
OPENAI_API_KEY=sk-...
PROVIDER_PRIVATE_KEY=0x...
CHAIN_ID=137
CLAIM_THRESHOLD=1000000
PORT=8080
```

## Deployment

1. Deploy to Railway with root directory `/providers/hs58-openai`
2. Set environment variables
3. Register in Handshake58 Marketplace

## API Endpoints

- `GET /v1/pricing` - View pricing
- `GET /v1/models` - List models
- `POST /v1/chat/completions` - Chat (requires X-DRAIN-Voucher)
- `GET /health` - Health check
