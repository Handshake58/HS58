# Community-Targon Provider

DRAIN payment gateway for [Targon](https://targon.com) GPU compute management (Bittensor Subnet 4 infrastructure).
Agents can browse GPU inventory, deploy serverless inference endpoints or dedicated GPU rentals, and manage workloads — all paid via USDC micropayments.

## Features

- **GPU Inventory** — Browse available H200 GPUs and pricing in real-time
- **Serverless Workloads** — Deploy auto-scaling inference endpoints (vLLM, etc.) with scale-to-zero
- **Dedicated Rentals** — Spin up persistent GPU servers with SSH access
- **Workload Management** — Check status, get access URLs, delete workloads
- **Confidential Compute** — Powered by Targon Virtual Machine (TVM) with Intel TDX / NVIDIA Confidential Computing

## Setup

1. Copy `env.example` to `.env`
2. Set `PROVIDER_PRIVATE_KEY` (Polygon wallet for receiving USDC)
3. Set `TARGON_API_KEY` (from [targon.com/settings](https://targon.com/settings) → API Keys)
4. Set `POLYGON_RPC_URL` (Alchemy/Infura recommended)
5. `npm install && npm run build && npm start`

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `TARGON_API_KEY` | Yes | Targon API key (from targon.com/settings) |
| `PROVIDER_PRIVATE_KEY` | Yes | Polygon wallet for receiving USDC |
| `POLYGON_RPC_URL` | Recommended | Polygon RPC for claiming |
| `TARGON_API_URL` | No | Base URL (default `https://api.targon.com/tha/v2`) |

## Operations / Models

| Operation | Model ID | Price |
|-----------|----------|-------|
| Browse GPU inventory | `targon/inventory` | $0.001 |
| List workloads | `targon/workloads` | $0.001 |
| Get workload status | `targon/workload-status` | $0.001 |
| Deploy serverless workload | `targon/create-serverless` | $2.50 |
| Deploy GPU rental | `targon/create-rental` | $2.50 |
| Delete workload | `targon/delete-workload` | $0.25 |

## API

- `GET /v1/pricing` — Operation pricing
- `GET /v1/models` — List all operations
- `GET /v1/docs` — Agent usage instructions (plain text)
- `POST /v1/chat/completions` — Execute operation with DRAIN voucher
- `GET /health` — Health check
- `POST /v1/close-channel` — Cooperative close
- `POST /v1/admin/claim` — Claim payments (Bearer auth)
- `GET /v1/admin/stats` — Provider statistics

## Usage Example

```json
// Browse GPU inventory
{
  "model": "targon/inventory",
  "messages": [{"role": "user", "content": "{\"type\": \"serverless\", \"gpu\": true}"}]
}

// Deploy a vLLM serverless endpoint
{
  "model": "targon/create-serverless",
  "messages": [{"role": "user", "content": "{\"name\": \"my-vllm\", \"image\": \"vllm/vllm-openai:v0.6.0\", \"resource_name\": \"h200-small\", \"ports\": [{\"port\": 8000, \"protocol\": \"TCP\", \"routing\": \"PROXIED\"}], \"envs\": [{\"name\": \"MODEL\", \"value\": \"meta-llama/Llama-3.1-8B-Instruct\"}], \"serverless_config\": {\"min_replicas\": 0, \"max_replicas\": 1, \"timeout_seconds\": 120}}"}]
}

// Check workload status (get URL)
{
  "model": "targon/workload-status",
  "messages": [{"role": "user", "content": "{\"uid\": \"wrk-abc123\"}"}]
}
```

## Architecture

```
Agent → drain-mcp → Community-Targon Provider → Targon API (api.targon.com/tha/v2)
                           ↕                           ↕
                    Polygon (USDC)              Bittensor Subnet 4 / TVM
```

Deployed workloads get a public URL at `https://wrk-{uid}.caas.targon.com` once running.
