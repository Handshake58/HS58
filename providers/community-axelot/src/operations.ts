import type { Address } from 'viem';
import { BittensorClient } from './bittensor.js';
import type { ProviderConfig, StakePosition, SubnetSummary, TradeAction, TradeIntent } from './types.js';
import { computeAlphaRaoForTaoExit, estimateOneWayFriction, estimateRoundTripBreakEven, makeIntentId, orderImpactPct, raoToTao } from './math.js';

interface OperationContext {
  config: ProviderConfig;
  bittensor: BittensorClient;
  providerAddress: Address;
}

export async function executeOperation(model: string, inputText: string, ctx: OperationContext): Promise<Record<string, unknown>> {
  const input = parseJson(inputText);
  switch (model) {
    case 'axelot/market-snapshot':
      return marketSnapshot(input, ctx);
    case 'axelot/subnet-analyze':
      return subnetAnalyze(input, ctx);
    case 'axelot/friction-quote':
      return frictionQuote(input, ctx);
    case 'axelot/portfolio-analyze':
      return portfolioAnalyze(input, ctx);
    case 'axelot/opportunity-scan':
      return opportunityScan(input, ctx);
    case 'axelot/risk-preflight':
      return riskPreflight(input, ctx);
    case 'axelot/trade-plan':
      return tradePlan(input, ctx);
    case 'axelot/rebalance-loop':
      return rebalanceLoop(input, ctx);
    case 'axelot/signer-bootstrap':
      return signerBootstrap(ctx);
    case 'axelot/monitor-trade':
      return monitorTrade(input, ctx);
    default:
      throw new Error(`Unsupported model: ${model}`);
  }
}

function parseJson(inputText: string): Record<string, unknown> {
  const trimmed = inputText.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON user message: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function marketSnapshot(input: Record<string, unknown>, ctx: OperationContext) {
  const limit = clampInt(input.limit, 1, 100, 25);
  const minReserveTao = numberOr(input.minReserveTao, 0);
  const snap = await ctx.bittensor.getMarketSnapshot(input.force === true);
  const filtered = snap.subnets.filter((s) => s.taoReserve >= minReserveTao).slice(0, limit);
  return {
    operation: 'market-snapshot',
    chain: ctx.config.bittensorChain,
    blockNumber: snap.blockNumber,
    timestamp: new Date(snap.timestamp).toISOString(),
    activeSubnets: snap.subnets.length,
    subnets: filtered,
    notes: ['Current on-chain snapshot only; historical deltas require an external indexer.', 'This is NOT financial advice. Use local signer dry-run before any execution.'],
  };
}

async function subnetAnalyze(input: Record<string, unknown>, ctx: OperationContext) {
  const netuids = parseNetuids(input);
  const snap = await ctx.bittensor.getMarketSnapshot();
  const rows = netuids
    .map((netuid) => snap.subnets.find((s) => s.netuid === netuid))
    .filter((s): s is SubnetSummary => Boolean(s))
    .map((s) => ({
      ...s,
      labels: labelsForSubnet(s),
      entryQualityScore: scoreSubnet(s),
      defaultRiskNotes: riskNotes(s),
    }));
  return { operation: 'subnet-analyze', chain: ctx.config.bittensorChain, blockNumber: snap.blockNumber, subnets: rows };
}

async function frictionQuote(input: Record<string, unknown>, ctx: OperationContext) {
  const netuid = requiredInt(input.netuid, 'netuid');
  const amountTao = requiredNumber(input.amountTao, 'amountTao');
  const action = stringOr(input.action, 'stake') as 'stake' | 'unstake' | 'move' | 'swap';
  const pool = await requiredSubnet(ctx, netuid);
  const oneWay = estimateOneWayFriction({ amountTao, poolReserveTao: pool.taoReserve, action });
  const roundTrip = estimateRoundTripBreakEven({ amountTao, poolReserveTao: pool.taoReserve });
  const impactPct = orderImpactPct(amountTao, pool.taoReserve);
  return {
    operation: 'friction-quote',
    netuid,
    action,
    amountTao,
    poolReserveTao: pool.taoReserve,
    spotPrice: pool.spotPrice,
    estimatedOneWayFrictionTao: oneWay,
    estimatedRoundTripBreakEvenTao: roundTrip,
    estimatedRoundTripBreakEvenPct: (roundTrip / amountTao) * 100,
    orderImpactPct: impactPct,
    verdict: impactPct != null && impactPct > 2 ? 'thin_or_large_order' : 'ok',
  };
}

async function portfolioAnalyze(input: Record<string, unknown>, ctx: OperationContext) {
  const coldkey = requiredString(input.coldkey, 'coldkey');
  const [positions, freeRao] = await Promise.all([
    ctx.bittensor.getStakesForColdkey(coldkey),
    ctx.bittensor.getFreeBalance(coldkey),
  ]);
  const totalStakedTao = positions.reduce((sum, p) => sum + p.taoValue, 0);
  const freeTao = freeRao == null ? null : raoToTao(freeRao);
  return {
    operation: 'portfolio-analyze',
    coldkey,
    chain: ctx.config.bittensorChain,
    freeTao,
    totalStakedTao,
    positionCount: positions.length,
    positions,
    concentration: concentration(positions),
    notes: positions.length === 0 ? ['No delegated alpha positions found via StakeInfoRuntimeApi.'] : [],
  };
}

async function opportunityScan(input: Record<string, unknown>, ctx: OperationContext) {
  const limit = clampInt(input.limit, 1, 50, 10);
  const minReserveTao = numberOr(input.minReserveTao, 50);
  const snap = await ctx.bittensor.getMarketSnapshot(input.force === true);
  const ranked = snap.subnets
    .filter((s) => s.taoReserve >= minReserveTao)
    .map((s) => ({
      netuid: s.netuid,
      score: scoreSubnet(s),
      labels: labelsForSubnet(s),
      emissionPct: s.emissionPct,
      taoReserve: s.taoReserve,
      trendVsMovingPct: s.trendVsMovingPct,
      spotPrice: s.spotPrice,
      ownerHotkey: s.ownerHotkey,
      notes: riskNotes(s),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { operation: 'opportunity-scan', chain: ctx.config.bittensorChain, blockNumber: snap.blockNumber, ranked };
}

async function riskPreflight(input: Record<string, unknown>, ctx: OperationContext) {
  const intent = await buildIntent(input, ctx, false);
  const amountTao = intent.amountTao ?? 0;
  const pool = await requiredSubnet(ctx, intent.netuid);
  const impactPct = amountTao > 0 ? orderImpactPct(amountTao, pool.taoReserve) : null;
  const maxTaoPerTrade = numberOr(input.maxTaoPerTrade, Number.POSITIVE_INFINITY);
  const maxOrderImpactPct = numberOr(input.maxOrderImpactPct, 2);
  const warnings: string[] = strategyAllocationWarnings(input.strategy);
  if (amountTao > maxTaoPerTrade) warnings.push(`amountTao ${amountTao} exceeds maxTaoPerTrade ${maxTaoPerTrade}`);
  if (impactPct != null && impactPct > maxOrderImpactPct) warnings.push(`order impact ${impactPct.toFixed(2)}% exceeds maxOrderImpactPct ${maxOrderImpactPct}%`);
  if (intent.action === 'recycle' && input.confirmRecycle !== true) warnings.push('recycle_alpha requires confirmRecycle:true and local signer policy approval');
  return {
    operation: 'risk-preflight',
    approved: warnings.length === 0,
    warnings,
    strategy: strategySummary(input.strategy),
    intent,
    signerRequired: true,
    signerDefaultSubmit: 'local-only',
  };
}

async function tradePlan(input: Record<string, unknown>, ctx: OperationContext) {
  const intent = await buildIntent(input, ctx, true);
  return {
    operation: 'trade-plan',
    requiresLocalSigner: true,
    signerDefaultSubmit: 'local-only',
    localSigner: signerMetadata(),
    strategy: strategySummary(input.strategy),
    warnings: strategyAllocationWarnings(input.strategy),
    intent,
    nextSteps: [
      'Install/configure axelot-tao-signer-mcp locally.',
      'Call tao_dry_run_intent with the intent to inspect the reconstructed Subtensor call.',
      'Call tao_execute_intent only after the user approves the local signer preview, or use tao_sign_trade_intent then tao_submit_signed_extrinsic locally.',
      'Call axelot/monitor-trade with the returned txHash.',
    ],
  };
}

async function rebalanceLoop(input: Record<string, unknown>, ctx: OperationContext) {
  const coldkey = typeof input.coldkey === 'string' ? input.coldkey : null;
  const [scan, portfolio] = await Promise.all([
    opportunityScan({ limit: input.limit ?? 8, minReserveTao: input.minReserveTao ?? 50 }, ctx),
    coldkey ? portfolioAnalyze({ coldkey }, ctx) : Promise.resolve(null),
  ]);
  const ranked = scan.ranked as Array<{ netuid: number; score: number; labels: string[]; taoReserve: number; ownerHotkey: string | null }>;
  const top = ranked[0];
  const shouldPlan = top && top.score >= numberOr(input.minScoreForIntent, 55) && numberOr(input.amountTao, 0) > 0;
  const intent = shouldPlan
    ? await buildIntent({ ...input, action: input.action ?? 'stake', netuid: input.netuid ?? top.netuid, delegateHotkey: input.delegateHotkey ?? top.ownerHotkey }, ctx, true)
    : null;
  return {
    operation: 'rebalance-loop',
    recommendation: intent ? 'consider_intent_after_local_dry_run' : 'research_only_or_hold',
    opportunityScan: scan,
    portfolio,
    strategy: strategySummary(input.strategy),
    intent,
    requiresLocalSigner: Boolean(intent),
    notes: ['This provider never signs TAO transactions. Use the local signer MCP for dry-run and execution.'],
  };
}

function signerBootstrap(ctx: OperationContext) {
  return {
    operation: 'signer-bootstrap',
    requiresLocalSigner: true,
    mcp: signerMetadata(),
    modes: {
      learn: 'No wallet or signer. Use market-snapshot, subnet-analyze, friction-quote, and opportunity-scan.',
      monitor: 'Public coldkey only. Use portfolio-analyze and read-only rebalance-loop.',
      trade: 'Local signer required. Provider returns semantic intents; signer enforces policy and submits locally.',
    },
    strategyPolicyMapping: {
      provider: 'Uses optional axelot.strategy-adapter.v1 input for recommendation context.',
      signer: 'Enforces max trade size, daily budget, trade count, cooldown, slippage, confirmation, recycle permission, and allowed calls locally.',
    },
    autonomyModes: {
      manualConfirm: 'Default. REQUIRE_CONFIRM=true, every execution needs explicit user confirmation.',
      guardedAutopilot: 'Opt-in local mode. Set strategy.autonomy.mode="guarded_autopilot" and local REQUIRE_CONFIRM=false. Agent may execute only inside signer policy and bounded trade-state limits.',
      observeOnly: 'Agent can use provider analysis and tao_trade_state but should not call execution tools.',
    },
    zeroContextFlow: [
      'Start in Learn mode with market-snapshot and opportunity-scan.',
      'Use Monitor mode only after the user provides a public coldkey.',
      'Before Trade mode, call axelot/signer-bootstrap and verify the local signer is available.',
      'If the local signer is not available, stop at planning/simulation and do not execute.',
      'Use tao_trade_state before execution so the agent can explain current active intents and remaining daily budget.',
    ],
    coldkeyPolicy: {
      providerInput: 'coldkey is optional for risk-preflight and trade-plan because the local signer knows its own coldkey.',
      recommended: 'include coldkey when available for better portfolio context and clearer intent checks.',
      forbidden: 'never send mnemonics, keyfiles, private keys, passwords, or signed extrinsic hex to the provider.',
    },
    install: {
      npmPackage: 'axelot-tao-signer-mcp',
      npmGlobalCommand: 'npm install -g axelot-tao-signer-mcp',
      mcpCommand: 'axelot-tao-signer-mcp',
      repository: 'https://github.com/Handshake58/HS58.git',
      packagePath: 'providers/community-axelot/signer-mcp',
      commands: [
        'npm install -g axelot-tao-signer-mcp',
      ],
      fallbackCommands: [
        'git clone https://github.com/Handshake58/HS58.git',
        'cd HS58/providers/community-axelot/signer-mcp',
        'npm install',
        'npm run generate-wallet',
        'npm run build',
      ],
    },
    cursorMcpConfigExample: {
      mcpServers: {
        'axelot-tao-signer': {
          command: 'axelot-tao-signer-mcp',
          env: {
            TAO_COLDKEY_MNEMONIC: 'generated-or-existing-dedicated-low-value-tao-wallet',
            SUBTENSOR_ENDPOINT: ctx.config.subtensorEndpoint,
            BITTENSOR_CHAIN: ctx.config.bittensorChain,
            MAX_TAO_PER_TRADE: '0.01',
            MAX_TAO_PER_DAY: '0.05',
            MAX_TRADES_PER_DAY: '5',
            MAX_SLIPPAGE_PCT: '1.5',
            MIN_SECONDS_BETWEEN_TRADES: '300',
            REQUIRE_CONFIRM: 'true',
            ALLOW_RECYCLE_ALPHA: 'false',
            ALLOWED_ACTIONS: 'stake,unstake,full_unstake,move,swap',
            ALLOWED_NETUIDS: '',
            TRADE_STATE_PATH: './data/trade-state.json',
          },
        },
      },
    },
    dryRunOnlyFlow: [
      'Call tao_wallet_status to confirm the local signer wallet and policy hash.',
      'Call tao_dry_run_intent with the provider intent.',
      'Call tao_trade_state to inspect active intents and remaining budget.',
      'In guarded autopilot, tao_execute_intent requires the same intentId to have been dry-run first.',
      'Do not call tao_execute_intent unless user confirmation or local guarded autopilot policy allows execution.',
    ],
    safety: [
      'Never send TAO mnemonics, keyfiles, or private keys to the Axelot provider.',
      'The signer reconstructs allowlisted calls locally from semantic trade intents.',
      'If intent.riskPolicyHash is present, the signer rejects mismatches against the local policy hash.',
      'Default execution mode is local submit; provider monitors tx hashes only.',
      'If the user has no TAO wallet, run tao_generate_wallet or npm run generate-wallet in the signer package.',
    ],
  };
}

async function monitorTrade(input: Record<string, unknown>, ctx: OperationContext) {
  const txHash = requiredString(input.txHash, 'txHash');
  const depth = clampInt(input.depth, 1, 500, 60);
  const result = await ctx.bittensor.monitorExtrinsic(txHash, depth);
  return { operation: 'monitor-trade', txHash, chain: ctx.config.bittensorChain, ...result };
}

async function buildIntent(input: Record<string, unknown>, ctx: OperationContext, includeEvidence: boolean): Promise<TradeIntent> {
  const action = requiredAction(input.action);
  const netuid = requiredInt(input.netuid, 'netuid');
  const fromNetuid = input.fromNetuid == null ? null : requiredInt(input.fromNetuid, 'fromNetuid');
  const amountTao = input.amountTao == null ? null : requiredNumber(input.amountTao, 'amountTao');
  const maxSlippagePct = numberOr(input.maxSlippagePct, 1.5);
  const allowPartial = input.allowPartial === true;
  const coldkey = typeof input.coldkey === 'string' ? input.coldkey : null;
  const reason = stringOr(input.reason, `Axelot ${action} plan for SN${netuid}`);
  const pool = await requiredSubnet(ctx, action === 'move' || action === 'swap' ? (fromNetuid ?? netuid) : netuid);
  const positions = coldkey ? await ctx.bittensor.getStakesForColdkey(coldkey).catch(() => [] as StakePosition[]) : [];
  const matchingPosition = positions.find((p) => p.netuid === (fromNetuid ?? netuid));
  const delegateHotkey = stringOrNull(input.delegateHotkey) ?? (action === 'stake' ? pool.ownerHotkey : matchingPosition?.delegateHotkey ?? null);
  const fromDelegateHotkey = stringOrNull(input.fromDelegateHotkey) ?? matchingPosition?.delegateHotkey ?? null;

  let amountAlphaRao: string | null = typeof input.amountAlphaRao === 'string' ? input.amountAlphaRao : null;
  if (!amountAlphaRao && amountTao != null && ['unstake', 'move', 'swap', 'recycle'].includes(action)) {
    const fullBalance = matchingPosition?.alphaRao ? BigInt(matchingPosition.alphaRao) : undefined;
    const { alphaRao } = computeAlphaRaoForTaoExit({
      amountTao,
      taoReserveRao: BigInt(Math.round(pool.taoReserve * 1e9)),
      alphaInRao: BigInt(Math.round(pool.alphaIn * 1e9)),
      fullBalanceAlphaRao: fullBalance,
    });
    amountAlphaRao = alphaRao > 0n ? alphaRao.toString() : null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + clampInt(input.ttlSeconds, 60, 1800, 300) * 1000);
  const preferredExtrinsic = preferredExtrinsicFor(action, Boolean(delegateHotkey && fromDelegateHotkey && delegateHotkey !== fromDelegateHotkey));
  const evidence = includeEvidence
    ? {
        marketBlock: pool.blockNumber,
        spotPrice: pool.spotPrice,
        taoReserve: pool.taoReserve,
        roundTripBreakEvenPct: amountTao && amountTao > 0 ? (estimateRoundTripBreakEven({ amountTao, poolReserveTao: pool.taoReserve }) / amountTao) * 100 : null,
        orderImpactPct: amountTao ? orderImpactPct(amountTao, pool.taoReserve) : null,
        strategy: strategySummary(input.strategy),
      }
    : {};
  const base = { action, netuid, fromNetuid, amountTao, delegateHotkey, fromDelegateHotkey, createdAt: now.toISOString() };

  return {
    schemaVersion: 'axelot.trade-intent.v1',
    intentId: makeIntentId(base),
    providerId: 'community-axelot',
    providerAddress: ctx.providerAddress,
    chain: ctx.config.bittensorChain,
    subtensorEndpointHint: ctx.config.subtensorEndpoint,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    coldkey,
    action,
    netuid,
    fromNetuid,
    amountTao,
    amountAlphaRao,
    delegateHotkey,
    fromDelegateHotkey,
    maxSlippagePct,
    allowPartial,
    preferredExtrinsic,
    riskPolicyHash: stringOrNull(input.riskPolicyHash),
    reason,
    evidence,
  };
}

async function requiredSubnet(ctx: OperationContext, netuid: number): Promise<SubnetSummary> {
  const snap = await ctx.bittensor.getMarketSnapshot();
  const subnet = snap.subnets.find((s) => s.netuid === netuid);
  if (!subnet) throw new Error(`No active/tradeable subnet found for netuid ${netuid}`);
  return subnet;
}

function parseNetuids(input: Record<string, unknown>): number[] {
  if (Array.isArray(input.netuids)) return input.netuids.map((n) => requiredInt(n, 'netuids[]')).slice(0, 25);
  return [requiredInt(input.netuid, 'netuid')];
}

function labelsForSubnet(s: SubnetSummary): string[] {
  const labels: string[] = [];
  if (s.emissionPct < 0.05) labels.push('DEATH_WATCH');
  else if (s.emissionPct < 0.3) labels.push('THIN_EMISSION');
  if ((s.trendVsMovingPct ?? 0) > 5) labels.push('ABOVE_MOVING_PRICE');
  if ((s.trendVsMovingPct ?? 0) < -5) labels.push('BELOW_MOVING_PRICE');
  if (s.taoReserve < 50) labels.push('THIN_LIQUIDITY');
  if (s.taoReserve >= 500 && s.emissionPct >= 0.3) labels.push('CORE_LIQUID');
  return labels;
}

function scoreSubnet(s: SubnetSummary): number {
  const emissionScore = Math.min(40, s.emissionPct * 8);
  const liquidityScore = Math.min(35, s.liquidityScore * 10);
  const trend = s.trendVsMovingPct == null ? 5 : Math.max(-10, Math.min(20, s.trendVsMovingPct));
  const penalty = s.emissionPct < 0.05 ? 35 : s.taoReserve < 25 ? 20 : 0;
  return Math.round(Math.max(0, emissionScore + liquidityScore + trend - penalty));
}

function riskNotes(s: SubnetSummary): string[] {
  const notes: string[] = [];
  if (s.emissionPct < 0.05) notes.push('Emission share is near zero; normal trend entries are high risk.');
  if (s.taoReserve < 50) notes.push('Thin pool; use small size and strict slippage limits.');
  if ((s.trendVsMovingPct ?? 0) > 10) notes.push('Price is far above moving price; avoid late-FOMO entries without pullback confirmation.');
  return notes;
}

function concentration(positions: StakePosition[]) {
  const total = positions.reduce((sum, p) => sum + p.taoValue, 0);
  return positions.map((p) => ({ netuid: p.netuid, pct: total > 0 ? (p.taoValue / total) * 100 : 0 })).slice(0, 10);
}

function signerMetadata() {
  return {
    name: 'axelot-tao-signer',
    package: 'axelot-tao-signer-mcp',
    localPath: 'providers/community-axelot/signer-mcp',
    installCommand: 'npm install -g axelot-tao-signer-mcp',
    defaultSubmit: 'local-only',
    requiredTools: ['tao_generate_wallet', 'tao_wallet_status', 'tao_portfolio_snapshot', 'tao_policy_get', 'tao_trade_state', 'tao_verify_intent', 'tao_dry_run_intent', 'tao_sign_trade_intent', 'tao_submit_signed_extrinsic', 'tao_execute_intent'],
  };
}

function strategySummary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const strategy = value as Record<string, unknown>;
  const allocation = strategyAllocationSummary(strategy);
  return {
    schemaVersion: 'axelot.strategy-adapter.v1',
    source: stringOr(strategy.source, 'custom'),
    strategyId: stringOr(strategy.strategyId, 'unspecified'),
    strategyVersion: stringOrNull(strategy.strategyVersion),
    riskClass: stringOr(strategy.riskClass, 'unknown'),
    mode: stringOr(strategy.mode, 'monitor'),
    targetAllocationCount: allocation.count,
    targetAllocationWeightPct: allocation.weightPct,
    allocationWarning: allocation.warning,
    rulesProvided: Boolean(strategy.rules && typeof strategy.rules === 'object'),
    enforcement: 'provider-recommendation-only-local-signer-enforces-policy',
  };
}

function strategyAllocationWarnings(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const summary = strategyAllocationSummary(value as Record<string, unknown>);
  return summary.warning ? [summary.warning] : [];
}

function strategyAllocationSummary(strategy: Record<string, unknown>): { count: number; weightPct: number | null; warning: string | null } {
  const allocations = strategy.targetAllocations;
  if (!Array.isArray(allocations)) return { count: 0, weightPct: null, warning: null };
  const weightPct = allocations.reduce((sum, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return sum;
    const weight = Number((item as Record<string, unknown>).weightPct);
    return Number.isFinite(weight) ? sum + weight : sum;
  }, 0);
  const rounded = Math.round(weightPct * 100) / 100;
  const warning = allocations.length > 0 && Math.abs(rounded - 100) > 0.01
    ? `targetAllocations weightPct sums to ${rounded}, expected 100`
    : null;
  return { count: allocations.length, weightPct: rounded, warning };
}

function preferredExtrinsicFor(action: TradeAction, crossHotkey: boolean): string {
  if (action === 'stake') return 'add_stake_limit';
  if (action === 'unstake') return 'remove_stake_limit';
  if (action === 'full_unstake') return 'remove_stake_full_limit';
  if (action === 'move') return crossHotkey ? 'move_stake' : 'swap_stake_limit';
  if (action === 'swap') return 'swap_stake_limit';
  return 'recycle_alpha';
}

function requiredAction(value: unknown): TradeAction {
  const action = requiredString(value, 'action') as TradeAction;
  if (!['stake', 'unstake', 'full_unstake', 'move', 'swap', 'recycle'].includes(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  return action;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredInt(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function requiredNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive finite number`);
  return n;
}

function numberOr(value: unknown, defaultValue: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function stringOr(value: unknown, defaultValue: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : defaultValue;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampInt(value: unknown, min: number, max: number, defaultValue: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return defaultValue;
  return Math.max(min, Math.min(max, n));
}
