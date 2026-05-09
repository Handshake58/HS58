type JsonSchema = Record<string, unknown>;

interface OperationSchema {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  mode?: 'learn' | 'monitor' | 'trade';
  riskLevel?: 'none' | 'read-only' | 'signer-required';
}

const numberRange = (minimum?: number, maximum?: number): JsonSchema => ({
  type: 'number',
  ...(minimum == null ? {} : { minimum }),
  ...(maximum == null ? {} : { maximum }),
});

const integerRange = (minimum?: number, maximum?: number): JsonSchema => ({
  type: 'integer',
  ...(minimum == null ? {} : { minimum }),
  ...(maximum == null ? {} : { maximum }),
});

const stringOrNull: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const numberOrNull: JsonSchema = { anyOf: [{ type: 'number' }, { type: 'null' }] };

const tradeAction: JsonSchema = {
  type: 'string',
  enum: ['stake', 'unstake', 'full_unstake', 'move', 'swap', 'recycle'],
};

export const STRATEGY_ADAPTER_SCHEMA: JsonSchema = {
  $id: 'axelot.strategy-adapter.v1',
  type: 'object',
  additionalProperties: true,
  required: ['source', 'strategyId'],
  properties: {
    source: { type: 'string', enum: ['trustedstake', 'manual', 'custom'] },
    strategyId: { type: 'string', minLength: 1 },
    strategyVersion: { type: 'string' },
    riskClass: { type: 'string', enum: ['risk_averse', 'risk_on', 'unknown'] },
    mode: { type: 'string', enum: ['learn', 'monitor', 'trade'] },
    targetAllocations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['netuid', 'weightPct'],
        properties: {
          netuid: integerRange(0),
          weightPct: numberRange(0, 100),
          delegateHotkey: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    rules: {
      type: 'object',
      additionalProperties: true,
      properties: {
        rebalanceCadence: { type: 'string' },
        thresholdBased: { type: 'boolean' },
        maxSlippagePct: numberRange(0.01, 50),
        minLiquidityTao: numberRange(0),
        maxTaoPerTrade: numberRange(0),
        requireManualConfirm: { type: 'boolean' },
      },
    },
    autonomy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['observe_only', 'manual_confirm', 'guarded_autopilot'] },
        maxTaoPerTrade: numberRange(0),
        maxTaoPerDay: numberRange(0),
        maxTradesPerDay: integerRange(0),
        minSecondsBetweenTrades: integerRange(0),
        maxSlippagePct: numberRange(0.01, 50),
        allowedActions: { type: 'array', items: tradeAction },
        allowedNetuids: { type: 'array', items: integerRange(0) },
        requireDryRun: { type: 'boolean' },
      },
    },
  },
};

export const TRADE_INTENT_SCHEMA: JsonSchema = {
  $id: 'axelot.trade-intent.v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'intentId',
    'providerId',
    'providerAddress',
    'chain',
    'subtensorEndpointHint',
    'createdAt',
    'expiresAt',
    'coldkey',
    'action',
    'netuid',
    'fromNetuid',
    'amountTao',
    'amountAlphaRao',
    'delegateHotkey',
    'fromDelegateHotkey',
    'maxSlippagePct',
    'allowPartial',
    'preferredExtrinsic',
    'riskPolicyHash',
    'reason',
    'evidence',
  ],
  properties: {
    schemaVersion: { const: 'axelot.trade-intent.v1' },
    intentId: { type: 'string', minLength: 1 },
    providerId: { const: 'community-axelot' },
    providerAddress: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
    chain: { type: 'string', minLength: 1 },
    subtensorEndpointHint: { type: 'string', minLength: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    coldkey: stringOrNull,
    action: tradeAction,
    netuid: integerRange(0),
    fromNetuid: { anyOf: [integerRange(0), { type: 'null' }] },
    amountTao: numberOrNull,
    amountAlphaRao: stringOrNull,
    delegateHotkey: stringOrNull,
    fromDelegateHotkey: stringOrNull,
    maxSlippagePct: numberRange(0.01, 50),
    allowPartial: { type: 'boolean' },
    preferredExtrinsic: {
      type: 'string',
      enum: ['add_stake_limit', 'remove_stake_limit', 'remove_stake_full_limit', 'move_stake', 'swap_stake_limit', 'recycle_alpha'],
    },
    riskPolicyHash: stringOrNull,
    reason: { type: 'string' },
    evidence: { type: 'object' },
  },
};

const subnetSummary: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    netuid: integerRange(0),
    taoReserve: { type: 'number' },
    alphaIn: { type: 'number' },
    alphaOut: { type: 'number' },
    spotPrice: { type: 'number' },
    movingPrice: { type: 'number' },
    emissionPerBlock: { type: 'number' },
    emissionPct: { type: 'number' },
    liquidityScore: { type: 'number' },
    trendVsMovingPct: numberOrNull,
    tempo: { type: 'number' },
    ownerHotkey: stringOrNull,
    blockNumber: { type: 'number' },
  },
};

const stakePosition: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    netuid: integerRange(0),
    delegateHotkey: { type: 'string' },
    alphaRao: { type: 'string' },
    alpha: { type: 'number' },
    taoValue: { type: 'number' },
    spotPrice: { type: 'number' },
  },
};

const tradeIntentInputProperties: Record<string, unknown> = {
  mode: { type: 'string', enum: ['learn', 'monitor', 'trade'] },
  strategy: STRATEGY_ADAPTER_SCHEMA,
  action: tradeAction,
  netuid: integerRange(0),
  fromNetuid: integerRange(0),
  amountTao: numberRange(0),
  amountAlphaRao: { type: 'string', pattern: '^[0-9]+$' },
  coldkey: { type: 'string' },
  delegateHotkey: { type: 'string' },
  fromDelegateHotkey: { type: 'string' },
  maxSlippagePct: numberRange(0.01, 50),
  allowPartial: { type: 'boolean' },
  ttlSeconds: integerRange(60, 1800),
  riskPolicyHash: { type: 'string' },
  reason: { type: 'string' },
  confirmRecycle: { type: 'boolean' },
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

export const OPERATION_SCHEMAS: Record<string, OperationSchema> = {
  'axelot/market-snapshot': {
    mode: 'learn',
    riskLevel: 'none',
    inputSchema: objectSchema({
      limit: integerRange(1, 100),
      minReserveTao: numberRange(0),
      force: { type: 'boolean', description: 'Bypass the short market snapshot cache.' },
    }),
    outputSchema: objectSchema({
      operation: { const: 'market-snapshot' },
      chain: { type: 'string' },
      blockNumber: { type: 'number' },
      timestamp: { type: 'string', format: 'date-time' },
      activeSubnets: { type: 'number' },
      subnets: { type: 'array', items: subnetSummary },
      notes: { type: 'array', items: { type: 'string' } },
    }),
  },
  'axelot/subnet-analyze': {
    mode: 'learn',
    riskLevel: 'none',
    inputSchema: objectSchema({
      netuid: integerRange(0),
      netuids: { type: 'array', minItems: 1, maxItems: 25, items: integerRange(0) },
    }),
    outputSchema: objectSchema({
      operation: { const: 'subnet-analyze' },
      chain: { type: 'string' },
      blockNumber: { type: 'number' },
      subnets: { type: 'array', items: { ...subnetSummary, additionalProperties: true } },
    }),
  },
  'axelot/friction-quote': {
    mode: 'learn',
    riskLevel: 'none',
    inputSchema: objectSchema({
      netuid: integerRange(0),
      amountTao: numberRange(0),
      action: { type: 'string', enum: ['stake', 'unstake', 'move', 'swap'] },
    }, ['netuid', 'amountTao']),
    outputSchema: objectSchema({
      operation: { const: 'friction-quote' },
      netuid: { type: 'number' },
      action: { type: 'string' },
      amountTao: { type: 'number' },
      poolReserveTao: { type: 'number' },
      spotPrice: { type: 'number' },
      estimatedOneWayFrictionTao: { type: 'number' },
      estimatedRoundTripBreakEvenTao: { type: 'number' },
      estimatedRoundTripBreakEvenPct: { type: 'number' },
      orderImpactPct: numberOrNull,
      verdict: { type: 'string' },
    }),
  },
  'axelot/portfolio-analyze': {
    mode: 'monitor',
    riskLevel: 'read-only',
    inputSchema: objectSchema({ coldkey: { type: 'string', minLength: 1 }, strategy: STRATEGY_ADAPTER_SCHEMA }, ['coldkey']),
    outputSchema: objectSchema({
      operation: { const: 'portfolio-analyze' },
      coldkey: { type: 'string' },
      chain: { type: 'string' },
      freeTao: numberOrNull,
      totalStakedTao: { type: 'number' },
      positionCount: { type: 'number' },
      positions: { type: 'array', items: stakePosition },
      concentration: { type: 'array', items: { type: 'object' } },
      notes: { type: 'array', items: { type: 'string' } },
    }),
  },
  'axelot/opportunity-scan': {
    mode: 'learn',
    riskLevel: 'none',
    inputSchema: objectSchema({
      limit: integerRange(1, 50),
      minReserveTao: numberRange(0),
      force: { type: 'boolean' },
      strategy: STRATEGY_ADAPTER_SCHEMA,
    }),
    outputSchema: objectSchema({
      operation: { const: 'opportunity-scan' },
      chain: { type: 'string' },
      blockNumber: { type: 'number' },
      ranked: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
  },
  'axelot/risk-preflight': {
    mode: 'trade',
    riskLevel: 'signer-required',
    inputSchema: objectSchema({
      ...tradeIntentInputProperties,
      maxTaoPerTrade: numberRange(0),
      maxOrderImpactPct: numberRange(0),
    }, ['action', 'netuid']),
    outputSchema: objectSchema({
      operation: { const: 'risk-preflight' },
      approved: { type: 'boolean' },
      warnings: { type: 'array', items: { type: 'string' } },
      strategy: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      intent: TRADE_INTENT_SCHEMA,
      signerRequired: { type: 'boolean' },
      signerDefaultSubmit: { const: 'local-only' },
    }),
  },
  'axelot/rebalance-loop': {
    mode: 'monitor',
    riskLevel: 'read-only',
    inputSchema: objectSchema({
      coldkey: { type: 'string' },
      limit: integerRange(1, 50),
      minReserveTao: numberRange(0),
      minScoreForIntent: numberRange(0, 100),
      ...tradeIntentInputProperties,
    }),
    outputSchema: objectSchema({
      operation: { const: 'rebalance-loop' },
      recommendation: { type: 'string' },
      opportunityScan: { type: 'object' },
      portfolio: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      strategy: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      intent: { anyOf: [TRADE_INTENT_SCHEMA, { type: 'null' }] },
      requiresLocalSigner: { type: 'boolean' },
      notes: { type: 'array', items: { type: 'string' } },
    }),
  },
  'axelot/trade-plan': {
    mode: 'trade',
    riskLevel: 'signer-required',
    inputSchema: objectSchema(tradeIntentInputProperties, ['action', 'netuid']),
    outputSchema: objectSchema({
      operation: { const: 'trade-plan' },
      requiresLocalSigner: { type: 'boolean' },
      signerDefaultSubmit: { const: 'local-only' },
      localSigner: { type: 'object' },
      strategy: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      intent: TRADE_INTENT_SCHEMA,
      nextSteps: { type: 'array', items: { type: 'string' } },
    }),
  },
  'axelot/signer-bootstrap': {
    mode: 'trade',
    riskLevel: 'signer-required',
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      operation: { const: 'signer-bootstrap' },
      requiresLocalSigner: { type: 'boolean' },
      mcp: { type: 'object' },
      modes: { type: 'object' },
      strategyPolicyMapping: { type: 'object' },
      autonomyModes: { type: 'object' },
      zeroContextFlow: { type: 'array', items: { type: 'string' } },
      coldkeyPolicy: { type: 'object' },
      dryRunOnlyFlow: { type: 'array', items: { type: 'string' } },
      cursorMcpConfigExample: { type: 'object' },
      safety: { type: 'array', items: { type: 'string' } },
    }),
  },
  'axelot/monitor-trade': {
    mode: 'monitor',
    riskLevel: 'read-only',
    inputSchema: objectSchema({
      txHash: { type: 'string', pattern: '^0x[a-fA-F0-9]+$' },
      depth: integerRange(1, 500),
    }, ['txHash']),
    outputSchema: objectSchema({
      operation: { const: 'monitor-trade' },
      txHash: { type: 'string' },
      chain: { type: 'string' },
    }, ['operation', 'txHash', 'chain']),
  },
};

export function getOperationSchema(model: string): OperationSchema | null {
  return OPERATION_SCHEMAS[model] ?? null;
}

export function getAllSchemas(): Record<string, OperationSchema> {
  return OPERATION_SCHEMAS;
}
