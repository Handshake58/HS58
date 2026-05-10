# Axelot User Flows

## Learn Flow

Use this for users who have no wallet connected or only want to understand the
Bittensor dTAO market.

1. Check `/health`, `/v1/models`, and `/v1/schemas`.
2. Confirm the DRAIN Polygon wallet has USDC for payments and POL for gas.
3. Open a DRAIN channel.
4. Call `axelot/market-snapshot`.
5. Call `axelot/opportunity-scan`.
6. Optionally call `axelot/subnet-analyze` for selected netuids.
7. Explain liquidity, emissions, moving-price context, friction, and risk.

No coldkey and no signer are needed.

## Monitor Flow

Use this when the user provides a public coldkey.

1. Call `axelot/portfolio-analyze` with the coldkey.
2. Call `axelot/rebalance-loop` without `amountTao` for read-only analysis.
3. If the user has a TrustedStake strategy, include it as `strategy`.
4. Explain concentration, exposure, candidate changes, and risk notes.

Monitor mode must not execute transactions.
If `rebalance-loop` returns an intent, treat it as a proposal only. Execution
still requires the local signer.

## Trade Flow

Use this only after the user explicitly asks to prepare or execute a trade.
Autonomous agents own scheduling, memory, retries, Taostats/Dwellir enrichment,
and user-facing reporting.

1. Call `axelot/signer-bootstrap` first. If no local signer is available, stop at planning/simulation.
2. Ask for max TAO per trade, max slippage, and strategy source.
3. Call `axelot/risk-preflight`.
4. Call `axelot/trade-plan` only if the preflight is acceptable.
5. Send the returned `intent` to local `tao_dry_run_intent`.
6. Call local `tao_trade_state` to understand active intents, recent decisions, and remaining daily budget.
7. Show the reconstructed Subtensor call and local policy verdict.
8. Ask for explicit user confirmation unless local guarded autopilot is enabled with `REQUIRE_CONFIRM=false`.
9. Call local `tao_execute_intent({ intent, confirm: true })` in manual mode, or `tao_execute_intent({ intent })` in guarded autopilot.
10. Call `axelot/monitor-trade` with the returned `txHash`.

The remote provider must never receive TAO secrets or signed extrinsic hex.
The signer keeps only bounded current trade state, not an unbounded event log.
`coldkey` is optional for planning because the local signer knows its own
coldkey, but include it when available for better context.

## Phase 2 Data Sources

Subtensor remains the source of truth. Optional future enrichment:

- Dwellir RPC fallback for endpoint redundancy and lower latency.
- Taostats enrichment for longer historical context and evidence links.

These sources should improve confidence and diagnostics, not replace local signer
policy or on-chain verification.
