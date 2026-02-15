# HS58-Chutes Provider

Bittensor-focused models provider for the DRAIN Protocol via Chutes, part of the Handshake58 marketplace.

## Features

- **Bittensor Models** - Access to decentralized AI models
- **Auto-Discovery** - Models and pricing fetched from Chutes API
- **Dynamic Pricing** - Updates hourly from upstream prices
- **50% markup** - On Chutes prices
- **Streaming support** - Server-sent events for real-time responses

## Popular Models

| Model | Description |
|-------|-------------|
| unsloth/Llama-3.3-70B-Instruct | Llama 3.3 70B |
| deepseek-ai/DeepSeek-R1 | DeepSeek R1 Reasoning |
| deepseek-ai/DeepSeek-V3 | DeepSeek V3 |
| Qwen/QwQ-32B-Preview | Qwen QwQ 32B |

Use `GET /v1/models` to see all available models.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CHUTES_API_KEY` | Yes | Your Chutes API key |
| `PROVIDER_PRIVATE_KEY` | Yes | Wallet for receiving DRAIN payments |
| `CHAIN_ID` | No | 137 (mainnet) or 80002 (testnet). Default: 137 |
| `PORT` | No | Server port. Default: 3000 |
| `MARKUP_PERCENT` | No | Markup percentage. Default: 50 |

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

- `GET /v1/pricing` - View pricing
- `GET /v1/models` - List all models
- `POST /v1/chat/completions` - Chat (requires X-DRAIN-Voucher header)
- `POST /v1/admin/claim` - Claim pending payments
- `GET /v1/admin/stats` - View statistics
- `GET /health` - Health check

## License

MIT - Handshake58
