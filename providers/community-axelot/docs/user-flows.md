# Axelot User Flows

## Learn Flow

Use this for users who have no wallet connected or only want to understand the
Bittensor dTAO market.

1. Open a DRAIN channel.
2. Call `axelot/market-snapshot`.
3. Call `axelot/opportunity-scan`.
4. Optionally call `axelot/subnet-analyze` for selected netuids.
5. Explain liquidity, emissions, moving-price context, friction, and risk.

No coldkey and no signer are needed.

## Monitor Flow

Use this when the user provides a public coldkey.

1. Call `axelot/portfolio-analyze` with the coldkey.
2. Call `axelot/rebalance-loop` without `amountTao` for read-only analysis.
3. If the user has a TrustedStake strategy, include it as `strategy`.
4. Explain concentration, exposure, candidate changes, and risk notes.

Monitor mode must not execute transactions.

## Trade Flow

Use this only after the user explicitly asks to prepare or execute a trade.

1. Call `axelot/signer-bootstrap` if the local signer is not configured.
2. Ask for max TAO per trade, max slippage, and strategy source.
3. Call `axelot/risk-preflight`.
4. Call `axelot/trade-plan` only if the preflight is acceptable.
5. Send the returned `intent` to local `tao_dry_run_intent`.
6. Show the reconstructed Subtensor call and local policy verdict.
7. Ask for explicit user confirmation.
8. Call local `tao_execute_intent({ intent, confirm: true })`.
9. Call `axelot/monitor-trade` with the returned `txHash`.

The remote provider must never receive TAO secrets or signed extrinsic hex.

## Phase 2 Data Sources

Subtensor remains the source of truth. Optional future enrichment:

- Dwellir RPC fallback for endpoint redundancy and lower latency.
- Taostats enrichment for longer historical context and evidence links.

These sources should improve confidence and diagnostics, not replace local signer
policy or on-chain verification.
