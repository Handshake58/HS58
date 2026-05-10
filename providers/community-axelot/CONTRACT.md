# Community-Axelot Provider Contract

`community-axelot` is a Handshake58/DRAIN provider for Bittensor dTAO market
intelligence and non-custodial trading intents.

DRAIN is the Polygon USDC payment channel used to pay this provider. It is not
used for TAO signing or Bittensor execution.

Agents using DRAIN need a Polygon wallet funded with both USDC and POL: USDC
pays provider requests, while POL pays gas for channel open, close, and claim
transactions.

## Endpoints

- `GET /health`: provider and Subtensor connection health.
- `GET /v1/pricing`: flat USDC price per model plus input schemas.
- `GET /v1/models`: model discovery with input and output schemas.
- `GET /v1/schemas`: all operation schemas plus `axelot.trade-intent.v1` and `axelot.strategy-adapter.v1`.
- `GET /v1/docs`: human-readable agent instructions.
- `POST /v1/chat/completions`: paid DRAIN operation execution.
- `POST /v1/close-channel`: DRAIN channel close authorization.
- `POST /v1/admin/claim`: optional voucher claim trigger.

## Operation Models

- Learn: `axelot/market-snapshot`, `axelot/subnet-analyze`, `axelot/friction-quote`, `axelot/opportunity-scan`.
- Monitor: `axelot/portfolio-analyze`, read-only `axelot/rebalance-loop`, `axelot/monitor-trade`.
- Trade: `axelot/risk-preflight`, `axelot/trade-plan`, `axelot/signer-bootstrap`.

## Request Rules

`/v1/chat/completions` uses the OpenAI-style envelope required by HS58
providers. The selected `model` is one operation ID. The first user message
content must be a JSON object string matching that operation's input schema.

Example:

```json
{
  "model": "axelot/trade-plan",
  "messages": [
    {
      "role": "user",
      "content": "{\"action\":\"stake\",\"netuid\":1,\"amountTao\":0.25,\"coldkey\":\"5...\",\"maxSlippagePct\":1.5}"
    }
  ]
}
```

## Trade Intent Contract

Trading operations never return raw Subtensor calls for blind signing. They
return semantic `axelot.trade-intent.v1` objects:

- action: `stake`, `unstake`, `full_unstake`, `move`, `swap`, or `recycle`.
- amounts: `amountTao` for entry/valuation, `amountAlphaRao` for exits when known.
- routing: `netuid`, optional `fromNetuid`, delegate hotkeys when known.
- risk: `maxSlippagePct`, `allowPartial`, optional local `riskPolicyHash`.
- execution hint: `preferredExtrinsic`, never trusted as raw call data.
- evidence: current pool data and friction estimates used to build the plan.

The full JSON schema is exposed at `GET /v1/schemas`.

## Strategy Adapter Contract

Provider inputs may include optional `strategy` context matching
`axelot.strategy-adapter.v1`. The adapter is intentionally neutral so strategy
providers such as TrustedStake can define methodology while Axelot handles
agentic analysis and non-custodial execution.

Minimum object:

```json
{
  "source": "trustedstake",
  "strategyId": "bittensor-safe-index",
  "riskClass": "risk_averse",
  "mode": "monitor"
}
```

The provider may use this object for recommendations, scoring, and intent
context. The local signer must still enforce hard limits such as max TAO per
trade, max slippage, and confirmation requirements.

Agents should check or normalize `targetAllocations[].weightPct` so the strategy
allocation sums to 100. The schema defines shape; the strategy source or agent
owns economic consistency.

If DRAIN is unavailable or a paid call returns `voucher_required`, agents should
still use `/v1/schemas` and `/v1/docs` for payload validation, use local signer
tools such as `tao_generate_wallet`, `tao_policy_get`, `tao_trade_state`, and
`tao_wallet_status`, and stop before paid provider calls or execution.

## Autonomous Agents

Autonomous agents such as Clawdbot own scheduling, state, retries, Taostats
enrichment, Dwellir RPC usage, and user-facing observability. This provider is
the intelligence and intent layer, not the daemon.

The local signer exposes `tao_trade_state`, a bounded current-state view for
agents. It tracks daily budget usage, active submitted intents, and recent
decisions so agents can explain what they are in and why without reading an
unbounded log.

Default execution mode is manual confirmation. A user may opt into guarded
autopilot locally by setting `REQUIRE_CONFIRM=false` on the signer. Even then,
the signer must enforce local policy limits such as max TAO per trade, max TAO
per day, max trades per day, cooldown, max slippage, allowed actions, and
allowed netuids.

In guarded autopilot, `tao_execute_intent` requires a matching local
`tao_dry_run_intent` for the same `intentId`. If an intent includes
`riskPolicyHash`, the signer rejects it unless it matches the local
`tao_policy_get` hash. `ALLOWED_NETUIDS=""` means no netuid restriction; use a
comma-separated list to restrict execution.

Exact autonomy enum example:

```json
{
  "autonomy": {
    "mode": "guarded_autopilot",
    "requireDryRun": true
  }
}
```

## Non-Custodial Execution

The local `signer-mcp/` package is the only component allowed to hold TAO wallet
material. Its expected agent flow is:

1. Call provider `axelot/signer-bootstrap` before entering Trade mode.
2. Call provider `axelot/risk-preflight`.
3. Call provider `axelot/trade-plan`.
4. Send the returned `intent` to local `tao_dry_run_intent`.
5. Call local `tao_trade_state` to inspect active intents and remaining budget.
6. Inspect local policy verdict and reconstructed Subtensor call.
7. Call `tao_execute_intent` with `confirm:true` after user approval, unless guarded autopilot is locally enabled and the same `intentId` was dry-run first.
8. Send the returned `txHash` to provider `axelot/monitor-trade`.

`coldkey` is optional for `risk-preflight` and `trade-plan` because the local
signer knows its own coldkey. Include it when available for better portfolio
context and clearer intent checks.

For split signing/submission, use local `tao_sign_trade_intent` followed by
local `tao_submit_signed_extrinsic`. Signed extrinsic hex must stay local and
must not be sent back to the provider.

The provider must not receive mnemonics, keyfiles, private keys, passwords, or
signed extrinsic hex. Signed extrinsic relay is intentionally local-only for MVP.

## Safety Invariants

- Provider analysis is advisory and not financial advice.
- Provider cannot submit Bittensor transactions.
- Local signer recomputes limit prices from current chain state.
- `limit_price=0` is rejected by default.
- `recycle_alpha` requires explicit local policy and `confirmRecycle:true`.
- Finney usage should start with dedicated low-value wallets only.
