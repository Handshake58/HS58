# HS58-OpenRouter Provider

Multi-model provider for the DRAIN Protocol via OpenRouter, part of the Handshake58 marketplace.

## Features

- **200+ Models** - Access to GPT-4, Claude, Llama, Mixtral, and more
- **Auto-Discovery** - Models and pricing fetched automatically from OpenRouter
- **Dynamic Pricing** - Updates hourly from upstream prices
- **50% markup** - On OpenRouter prices
- **Streaming support** - Server-sent events for real-time responses

## Popular Models

| Model | Type |
|-------|------|
| openai/gpt-4-turbo | Chat |
| anthropic/claude-3-opus | Chat |
| meta-llama/llama-3-70b | Chat |
| mistralai/mixtral-8x7b | Chat |

Use `GET /v1/models` to see all available models.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter API key |
| `PROVIDER_PRIVATE_KEY` | Yes | Wallet for receiving DRAIN payments |
| `CHAIN_ID` | No | 137 (mainnet) or 80002 (testnet). Default: 137 |
| `PORT` | No | Server port. Default: 3000 |
| `MARKUP_PERCENT` | No | Markup percentage. Default: 50 |
| `PRICING_REFRESH_INTERVAL` | No | Seconds between price updates. Default: 3600 |

## Deployment

### Railway

1. Create new service from this directory
2. Set environment variables
3. Deploy

### Local Development

```bash
npm install
cp env.example .env
# Edit .env with your values
npm run dev
```

## API Endpoints

- `GET /v1/pricing` - View pricing for all models
- `GET /v1/pricing?filter=gpt` - Filter models by name
- `GET /v1/models` - List all models
- `POST /v1/chat/completions` - Chat (requires X-DRAIN-Voucher header)
- `POST /v1/admin/claim` - Claim pending payments
- `POST /v1/admin/refresh-pricing` - Force refresh pricing from OpenRouter
- `GET /v1/admin/stats` - View statistics
- `GET /health` - Health check

## License

MIT - Handshake58
