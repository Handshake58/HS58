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
- `tao_trade_state`: show bounded local trade state for autonomous agents.
- `tao_verify_intent`: validate a provider intent without signing.
- `tao_dry_run_intent`: show the exact reconstructed Subtensor call.
- `tao_sign_trade_intent`: sign locally and return signed extrinsic hex without submitting.
- `tao_submit_signed_extrinsic`: submit a locally signed extrinsic hex.
- `tao_execute_intent`: sign and submit locally to Subtensor.

## Setup

Recommended npm install:

```bash
npm install -g axelot-tao-signer-mcp
```

Then add it to your Cursor/agent MCP config using the global binary shown below.

Fallback from the HS58 repo:

```bash
git clone https://github.com/Handshake58/HS58.git
cd HS58/providers/community-axelot/signer-mcp
npm install
npm run generate-wallet
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
      "command": "axelot-tao-signer-mcp",
      "env": {
        "TAO_COLDKEY_MNEMONIC": "generated-or-existing-dedicated-low-value-tao-wallet",
        "SUBTENSOR_ENDPOINT": "wss://entrypoint-finney.opentensor.ai:443",
        "BITTENSOR_CHAIN": "bittensor-finney",
        "MAX_TAO_PER_TRADE": "0.01",
        "MAX_TAO_PER_DAY": "0.05",
        "MAX_TRADES_PER_DAY": "5",
        "MAX_SLIPPAGE_PCT": "1.5",
        "MIN_SECONDS_BETWEEN_TRADES": "300",
        "REQUIRE_CONFIRM": "true",
        "ALLOW_RECYCLE_ALPHA": "false",
        "ALLOWED_ACTIONS": "stake,unstake,full_unstake,move,swap",
        "ALLOWED_NETUIDS": "",
        "TRADE_STATE_PATH": "./data/trade-state.json"
      }
    }
  }
}
```

If you use the repo fallback instead of npm, set `command` to `node` and `args`
to the absolute `dist/server.js` path.

`ALLOWED_NETUIDS=""` means all netuids are allowed by local policy. Use a
comma-separated list such as `64,1,8` to restrict execution to specific subnets.

## Execution Flow

1. Ask `community-axelot` for `axelot/trade-plan`.
2. Pass the returned `intent` to `tao_dry_run_intent`.
3. Inspect the reconstructed call and local policy verdict.
4. Call `tao_trade_state` to see current daily budget, active intents, and recent decisions.
5. Call `tao_execute_intent` with `confirm:true` only after user approval, unless the user explicitly configured `REQUIRE_CONFIRM=false`.
6. Pass the returned `txHash` back to `axelot/monitor-trade`.

If `riskPolicyHash` is present on an intent, it must match the local
`tao_policy_get` hash. In guarded autopilot (`REQUIRE_CONFIRM=false`),
`tao_execute_intent` also requires that the same `intentId` was dry-run first.

For two-step execution, call `tao_sign_trade_intent` first, inspect/store the
signed hex locally, then call `tao_submit_signed_extrinsic`. Do not send signed
extrinsic hex to the remote provider.

`recycle_alpha` requires both `ALLOW_RECYCLE_ALPHA=true` and
`confirmRecycle:true`.

## Autonomous Mode

Default mode is manual confirmation. If the user wants a Clawdbot-like agent to
trade autonomously, they can opt in locally with `REQUIRE_CONFIRM=false`.

Autonomous signing is still bounded by local policy:

- `MAX_TAO_PER_TRADE`
- `MAX_TAO_PER_DAY`
- `MAX_TRADES_PER_DAY`
- `MIN_SECONDS_BETWEEN_TRADES`
- `MAX_SLIPPAGE_PCT`
- `ALLOWED_ACTIONS`
- `ALLOWED_NETUIDS` (`""` means no netuid restriction)
- `ALLOW_RECYCLE_ALPHA`

The signer keeps a small bounded state file at `TRADE_STATE_PATH`. It stores
daily budget usage, active submitted intents, and recent decisions so an
autonomous agent can explain what it is in and why. It is not an append-only log.

Strategy autonomy example for agents:

```json
{
  "autonomy": {
    "mode": "guarded_autopilot",
    "maxTaoPerTrade": 0.01,
    "maxTaoPerDay": 0.05,
    "maxTradesPerDay": 5,
    "minSecondsBetweenTrades": 300,
    "maxSlippagePct": 1.5,
    "allowedActions": ["stake", "unstake", "move", "swap"],
    "allowedNetuids": [64],
    "requireDryRun": true
  }
}
```

This strategy field is advisory context for agents. The actual opt-in is local:
set `REQUIRE_CONFIRM=false` and keep strict signer limits.

Guarded autopilot still requires a matching local `tao_dry_run_intent` before
execution. This prevents an autonomous agent from skipping call reconstruction
and policy preview.

## Safety Defaults

- No raw provider call data is trusted.
- Limit prices are recomputed locally from current chain pool state.
- `limit_price=0` is rejected unless explicitly enabled.
- `riskPolicyHash` mismatches are rejected when the intent includes a hash.
- Mnemonics, keyfiles, and private keys never leave the local machine.
