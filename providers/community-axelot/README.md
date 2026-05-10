# Community-Axelot

Non-custodial Bittensor dTAO trading intelligence provider for Handshake58.

This provider sells Axelot-style market analysis, friction quotes, risk preflights,
trade intents, signer bootstrap instructions, and transaction monitoring through
DRAIN micropayments. It never accepts or stores TAO wallet material.

## Operations

- Learn: `axelot/market-snapshot`, `axelot/subnet-analyze`, `axelot/friction-quote`, `axelot/opportunity-scan`.
- Monitor: `axelot/portfolio-analyze`, read-only `axelot/rebalance-loop`, `axelot/monitor-trade`.
- Trade: `axelot/risk-preflight`, `axelot/trade-plan`, `axelot/signer-bootstrap`.

Schemas are available from `GET /v1/schemas` and summarized in `CONTRACT.md`.
Agent instructions live in `AGENT_RUNBOOK.md`, and user onboarding flows live in
`docs/user-flows.md`.

## Strategy Adapter

Axelot does not need to own the strategy content. TrustedStake or another partner
can provide strategy data, and agents pass it as `strategy` using
`axelot.strategy-adapter.v1`.

The schema is exposed from `GET /v1/schemas` and checked into
`strategy-adapter.schema.json`. The provider treats strategy input as
recommendation context; the local signer remains the enforcement layer for TAO
execution limits.

## Non-Custodial Trading Flow

1. Agent pays this provider with `drain-mcp`.
2. Provider returns research or an `axelot.trade-intent.v1` semantic intent.
3. User configures a local `axelot-tao-signer-mcp`.
4. Local signer dry-runs, reconstructs an allowlisted Subtensor call, signs, and submits locally.
5. Provider monitors the returned tx hash.

The DRAIN payment wallet is on Polygon. It needs USDC for provider payments and
POL for gas; USDC alone is not enough to open, close, or claim payment channels.

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

Recommended install:

```bash
npm install -g axelot-tao-signer-mcp
```

Cursor/agent MCP config can use:

```json
{
  "mcpServers": {
    "axelot-tao-signer": {
      "command": "axelot-tao-signer-mcp"
    }
  }
}
```

The companion MCP also lives in `signer-mcp/` for local development:

```bash
cd signer-mcp
npm install
npm run generate-wallet
npm run build
node dist/server.js
```

The normal-user tools are `tao_generate_wallet`, `tao_dry_run_intent`,
`tao_trade_state`, and `tao_execute_intent`. Advanced local-only flows can use
`tao_sign_trade_intent` plus `tao_submit_signed_extrinsic`.

## Marketplace Registration

After deploying the provider, submit the public provider URL and Polygon wallet
address at `https://handshake58.com/become-provider`. Use
`provider-profile.example.json` as the profile checklist and replace the
placeholder URL/address with production values.
