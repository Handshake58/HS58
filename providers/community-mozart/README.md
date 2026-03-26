# community-mozart

> Multi-provider AI orchestration for Handshake58.

The only AI orchestration layer on Handshake58. Send one goal in plain English — Mozart plans it, routes it across the optimal mix of Bittensor-native and external providers, and returns one synthesized answer. Pay once for the whole workflow.

**Bittensor-native providers get priority:** Chutes (SN22), Desearch (SN22), Numinous (SN6), Vericore.

## Models

| Model ID | Description |
|---|---|
| `mozart/auto` | Full auto-orchestration — planner decides everything |
| `mozart/plan` | Dry-run — returns the execution plan without running |
| `mozart/pipeline` | User-defined DAG pipeline — full control over steps |

## Quick Start

```bash
cp env.example .env
# fill in your keys
npm install && npm run dev
```

## Deploy on Railway

1. Fork or clone this directory into your repo
2. Create a new Railway service, connect your repo
3. Set root directory to `/community-mozart`
4. Add environment variables from `env.example`
5. Add a Railway Volume at `/app/data` (required for voucher persistence)
6. Deploy

## Example Request

```json
{
  "mode": "auto",
  "goal": "Find the latest news on Bittensor dTAO and write a concise briefing",
  "budget_usd": 0.15
}
```

Send as the `content` of a user message to `POST /v1/chat/completions` with `model: "mozart/auto"` and an `X-DRAIN-Voucher` header.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Service health + provider address |
| `GET /v1/models` | List available models |
| `GET /v1/pricing` | Pricing details |
| `GET /v1/docs` | Full agent instructions (plain text) |
| `POST /v1/chat/completions` | Main inference endpoint |
| `POST /v1/admin/claim` | Manual USDC claim trigger |

## Contact

mozartorchestra@proton.com
