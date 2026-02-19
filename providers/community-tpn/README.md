# Community TPN Provider

DRAIN payment gateway for **TPN WireGuard VPN leases** via [Bittensor Subnet 65](https://github.com/taofu-labs/tpn-subnet).

AI agents pay with USDC micropayments (via [DRAIN protocol](https://handshake58.com)) and receive VPN connection configs in return.

## What it does

```
Agent → DRAIN Payment → This Provider → TPN API → VPN Config → Agent
```

- Accepts DRAIN micropayments (USDC on Polygon)
- Requests VPN leases from the TPN API (`https://api.taoprivatenetwork.com`)
- Returns WireGuard VPN configs
- Time-based pricing: cost scales with lease duration

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp env.example .env
# Edit .env: set PROVIDER_PRIVATE_KEY, TPN_API_URL, TPN_API_KEY

# 3. Run
npm run dev
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROVIDER_PRIVATE_KEY` | Yes | — | Polygon wallet private key for receiving DRAIN payments |
| `TPN_API_URL` | Yes | — | TPN API URL (e.g. `https://api.taoprivatenetwork.com`) |
| `TPN_API_KEY` | Yes | — | API key for TPN (get from TPN team) |
| `PRICE_PER_HOUR_USDC` | No | `0.005` | USDC price per hour of VPN lease |
| `MIN_PRICE_USDC` | No | `0.001` | Minimum USDC charge per request |
| `MAX_LEASE_MINUTES` | No | `1440` | Maximum lease duration (24h) |
| `POLYGON_RPC_URL` | No | public | Polygon RPC for on-chain operations |
| `CHAIN_ID` | No | `137` | 137 = Polygon mainnet, 80002 = Amoy testnet |

### Pricing Formula

```
cost = max(MIN_PRICE_USDC, minutes / 60 * PRICE_PER_HOUR_USDC)
```

Examples with defaults ($0.005/h, min $0.001):

| Lease Duration | Cost |
|---|---|
| 5 minutes | $0.001 (minimum) |
| 1 hour | $0.005 |
| 6 hours | $0.030 |
| 24 hours | $0.120 |

## API Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/pricing` | Pricing info |
| `GET` | `/v1/models` | Available models (tpn/wireguard) |
| `GET` | `/v1/docs` | Agent usage instructions |
| `POST` | `/v1/chat/completions` | Request a VPN lease (requires DRAIN voucher) |
| `GET` | `/health` | Health check |

### Admin

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/admin/claim` | Trigger manual payment claim |
| `GET` | `/v1/admin/stats` | Provider statistics |
| `GET` | `/v1/admin/vouchers` | List unclaimed vouchers |

## Agent Usage

### Request a WireGuard VPN

```
model: "tpn/wireguard"
messages: [{"role": "user", "content": "{\"minutes\": 60, \"country\": \"US\"}"}]
```

### Lease Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `minutes` | number | 60 | Lease duration in minutes |
| `country` | string | any | ISO 3166-1 alpha-2 country code (e.g. "US", "DE", "NL") |
| `residential` | boolean | false | true for residential IPs, false for datacenter |

## Deployment

### Railway

```bash
npm run build
# Deploy via Railway CLI or connect GitHub repo
```

### VPS

```bash
npm run build
npm start
```

## For TPN Subnet Operators

This provider is designed to be deployed by anyone. Set `TPN_API_URL` and `TPN_API_KEY` to your TPN API credentials.

You only need:
1. A Polygon wallet (for receiving DRAIN payments)
2. TPN API access (URL + API key)
3. This provider running as a service

No Bittensor wallet is needed — it communicates with TPN via their public API.

## License

MIT
