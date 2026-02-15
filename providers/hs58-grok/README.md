# HS58-Grok Provider

xAI Grok provider for the DRAIN Protocol, part of the Handshake58 marketplace.

## Features

- **OpenAI-compatible API** - Drop-in replacement for OpenAI clients
- **DRAIN Protocol payments** - Pay per request with USDC vouchers
- **50% markup** - On upstream xAI prices
- **Streaming support** - Server-sent events for real-time responses

## Supported Models

| Model | Input (per 1K) | Output (per 1K) |
|-------|----------------|-----------------|
| grok-4 | $0.0045 | $0.0225 |
| grok-4.1-fast-reasoning | $0.0003 | $0.00075 |
| grok-code-fast-1 | $0.0003 | $0.00225 |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XAI_API_KEY` | Yes | Your xAI API key |
| `PROVIDER_PRIVATE_KEY` | Yes | Wallet for receiving DRAIN payments |
| `CHAIN_ID` | No | 137 (mainnet) or 80002 (testnet). Default: 137 |
| `PORT` | No | Server port. Default: 3000 |
| `CLAIM_THRESHOLD` | No | Min amount to trigger claim. Default: $10 |

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
- `GET /v1/models` - List models
- `POST /v1/chat/completions` - Chat (requires X-DRAIN-Voucher header)
- `POST /v1/admin/claim` - Claim pending payments
- `GET /v1/admin/stats` - View statistics
- `GET /health` - Health check

## License

MIT - Handshake58
