# Community-Axelot

Non-custodial Bittensor dTAO trading intelligence provider for Handshake58.

This provider sells Axelot-style market analysis, friction quotes, risk preflights,
trade intents, signer bootstrap instructions, and transaction monitoring through
DRAIN micropayments. It never accepts or stores TAO wallet material.

## Operations

- `axelot/market-snapshot`
- `axelot/subnet-analyze`
- `axelot/friction-quote`
- `axelot/portfolio-analyze`
- `axelot/opportunity-scan`
- `axelot/risk-preflight`
- `axelot/rebalance-loop`
- `axelot/trade-plan`
- `axelot/signer-bootstrap`
- `axelot/monitor-trade`

Schemas are available from `GET /v1/schemas` and summarized in `CONTRACT.md`.

## Non-Custodial Trading Flow

1. Agent pays this provider with `drain-mcp`.
2. Provider returns research or an `axelot.trade-intent.v1` semantic intent.
3. User configures a local `axelot-tao-signer-mcp`.
4. Local signer dry-runs, reconstructs an allowlisted Subtensor call, signs, and submits locally.
5. Provider monitors the returned tx hash.

The provider never receives TAO mnemonics, keyfiles, private keys, or signed wallet
secrets. `recycle_alpha` is represented as an intent only and must be gated by the
local signer policy plus manual confirmation.

## Setup

```bash
npm install
npm run build
```

Configure environment from `env.example`, then:

```bash
npm start
```

Use a persistent volume for `STORAGE_PATH`; vouchers are required for DRAIN claims.

## Local TAO Signer

The companion MCP lives in `signer-mcp/`:

```bash
cd signer-mcp
npm install
cp env.example .env
npm run build
node dist/server.js
```

For Cursor MCP config, point the command to `signer-mcp/dist/server.js`. The
important tools are `tao_dry_run_intent`, `tao_sign_trade_intent`, and
`tao_execute_intent`.

## Marketplace Registration

After deploying the provider, submit the public provider URL and Polygon wallet
address at `https://handshake58.com/become-provider`. Use
`provider-profile.example.json` as the profile checklist and replace the
placeholder URL/address with production values.
