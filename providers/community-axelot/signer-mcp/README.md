# Axelot TAO Signer MCP

Local, non-custodial MCP signer for `community-axelot` trade intents.

The HS58 provider returns semantic `axelot.trade-intent.v1` objects. This MCP
runs on the user's machine, loads a local TAO wallet, checks the intent against
local policy, reconstructs the allowlisted Subtensor call, signs locally, and
optionally submits locally.

## Tools

- `tao_wallet_status`: show local coldkey, endpoint, free balance, nonce, and policy hash.
- `tao_generate_wallet`: create a new sr25519 TAO coldkey mnemonic and address.
- `tao_portfolio_snapshot`: read local coldkey stake positions from chain state.
- `tao_policy_get`: return the local policy that gates execution.
- `tao_verify_intent`: validate a provider intent without signing.
- `tao_dry_run_intent`: show the exact reconstructed Subtensor call.
- `tao_sign_trade_intent`: sign locally and return signed extrinsic hex without submitting.
- `tao_submit_signed_extrinsic`: submit a locally signed extrinsic hex.
- `tao_execute_intent`: sign and submit locally to Subtensor.

## Setup

```bash
cd providers/community-axelot/signer-mcp
npm install
cp env.example .env
npm run build
```

Use a dedicated low-value wallet. Start on Bittensor testnet or localnet before
using Finney.

If the user has no TAO wallet yet, call `tao_generate_wallet`, put the returned
`TAO_COLDKEY_MNEMONIC` into the local signer env, restart the signer, then run
`tao_wallet_status`.

For CLI setup, generate a new `.env` with:

```bash
npm run generate-wallet
```

## Cursor MCP Config

```json
{
  "mcpServers": {
    "axelot-tao-signer": {
      "command": "node",
      "args": ["C:/Coding/HS58/providers/community-axelot/signer-mcp/dist/server.js"],
      "env": {
        "TAO_COLDKEY_MNEMONIC": "use-a-dedicated-low-value-trading-wallet",
        "SUBTENSOR_ENDPOINT": "wss://test.finney.opentensor.ai:443",
        "BITTENSOR_CHAIN": "bittensor-testnet",
        "MAX_TAO_PER_TRADE": "0.25",
        "MAX_SLIPPAGE_PCT": "1.5",
        "REQUIRE_CONFIRM": "true",
        "ALLOW_RECYCLE_ALPHA": "false"
      }
    }
  }
}
```

## Execution Flow

1. Ask `community-axelot` for `axelot/trade-plan`.
2. Pass the returned `intent` to `tao_dry_run_intent`.
3. Inspect the reconstructed call and local policy verdict.
4. Call `tao_execute_intent` with `confirm:true` only after user approval.
5. Pass the returned `txHash` back to `axelot/monitor-trade`.

For two-step execution, call `tao_sign_trade_intent` first, inspect/store the
signed hex locally, then call `tao_submit_signed_extrinsic`. Do not send signed
extrinsic hex to the remote provider.

`recycle_alpha` requires both `ALLOW_RECYCLE_ALPHA=true` and
`confirmRecycle:true`.

## Safety Defaults

- No raw provider call data is trusted.
- Limit prices are recomputed locally from current chain pool state.
- `limit_price=0` is rejected unless explicitly enabled.
- Mnemonics, keyfiles, and private keys never leave the local machine.
