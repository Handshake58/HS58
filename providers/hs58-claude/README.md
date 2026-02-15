# HS58-Claude Provider

Anthropic Claude provider for the DRAIN Protocol, part of the Handshake58 marketplace.

## Features

- **OpenAI-compatible API** - Drop-in replacement for OpenAI clients
- **DRAIN Protocol payments** - Pay per request with USDC vouchers
- **50% markup** - On upstream Anthropic prices
- **Streaming support** - Server-sent events for real-time responses

## Supported Models

| Model | Input (per 1K) | Output (per 1K) |
|-------|----------------|-----------------|
| claude-3-5-sonnet-latest | $0.0045 | $0.0225 |
| claude-3-5-haiku-latest | $0.0015 | $0.0075 |
| claude-3-opus-latest | $0.0225 | $0.1125 |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
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

## Usage

```bash
curl -X POST https://hs58-claude.up.railway.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-DRAIN-Voucher: {\"channelId\":\"0x...\",\"amount\":\"1000000\",\"nonce\":\"1\",\"signature\":\"0x...\"}" \
  -d '{
    "model": "claude-3-5-sonnet-latest",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## License

MIT - Handshake58
