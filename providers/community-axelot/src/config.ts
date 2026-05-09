import { config as loadDotenv } from 'dotenv';
import type { Hex } from 'viem';
import type { ModelPricing, ProviderConfig } from './types.js';

loadDotenv();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string => process.env[name] ?? defaultValue;

function usd(price: number): bigint {
  return BigInt(Math.ceil(price * 1_000_000));
}

let activeModels = new Map<string, ModelPricing>();

export const MODEL_DESCRIPTIONS: Record<string, string> = {
  'axelot/market-snapshot': 'Current Bittensor dTAO market snapshot with liquidity, price, emissions, and moving-price context.',
  'axelot/subnet-analyze': 'Deep current-state analysis for selected netuids.',
  'axelot/friction-quote': 'Entry/exit/move friction and round-trip break-even quote for a planned TAO amount.',
  'axelot/portfolio-analyze': 'Read-only analysis of a coldkey portfolio using on-chain stake state.',
  'axelot/opportunity-scan': 'Ranked current opportunity scan across subnets using Axelot-style liquidity, emission, and trend features.',
  'axelot/risk-preflight': 'Policy-aware preflight for a proposed stake, unstake, move, swap, or recycle action.',
  'axelot/rebalance-loop': 'Full read-only decision pass returning next best action and signer-ready intent when appropriate.',
  'axelot/trade-plan': 'Build a non-custodial semantic trade intent for the local TAO signer MCP.',
  'axelot/signer-bootstrap': 'Return local TAO signer MCP setup and capability-check instructions.',
  'axelot/monitor-trade': 'Search recent Bittensor blocks for a submitted extrinsic hash and return monitoring context.',
};

export const MODEL_METADATA: Record<string, { mode: 'learn' | 'monitor' | 'trade'; riskLevel: 'none' | 'read-only' | 'signer-required'; requiresColdkey: boolean; requiresLocalSigner: boolean }> = {
  'axelot/market-snapshot': { mode: 'learn', riskLevel: 'none', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/subnet-analyze': { mode: 'learn', riskLevel: 'none', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/friction-quote': { mode: 'learn', riskLevel: 'none', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/opportunity-scan': { mode: 'learn', riskLevel: 'none', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/portfolio-analyze': { mode: 'monitor', riskLevel: 'read-only', requiresColdkey: true, requiresLocalSigner: false },
  'axelot/rebalance-loop': { mode: 'monitor', riskLevel: 'read-only', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/monitor-trade': { mode: 'monitor', riskLevel: 'read-only', requiresColdkey: false, requiresLocalSigner: false },
  'axelot/risk-preflight': { mode: 'trade', riskLevel: 'signer-required', requiresColdkey: false, requiresLocalSigner: true },
  'axelot/trade-plan': { mode: 'trade', riskLevel: 'signer-required', requiresColdkey: false, requiresLocalSigner: true },
  'axelot/signer-bootstrap': { mode: 'trade', riskLevel: 'signer-required', requiresColdkey: false, requiresLocalSigner: true },
};

export function loadModels(): void {
  const prices: [string, number][] = [
    ['axelot/market-snapshot', 0.015],
    ['axelot/subnet-analyze', 0.02],
    ['axelot/friction-quote', 0.008],
    ['axelot/portfolio-analyze', 0.03],
    ['axelot/opportunity-scan', 0.05],
    ['axelot/risk-preflight', 0.04],
    ['axelot/rebalance-loop', 0.12],
    ['axelot/trade-plan', 0.08],
    ['axelot/signer-bootstrap', 0.001],
    ['axelot/monitor-trade', 0.01],
  ];

  activeModels = new Map(prices.map(([id, price]) => [id, { inputPer1k: usd(price), outputPer1k: 0n }]));
}

export const getModelPricing = (model: string): ModelPricing | null => activeModels.get(model) ?? null;
export const isModelSupported = (model: string): boolean => activeModels.has(model);
export const getSupportedModels = (): string[] => Array.from(activeModels.keys());

export function isPlanningModel(model: string): boolean {
  return ['axelot/rebalance-loop', 'axelot/trade-plan', 'axelot/risk-preflight'].includes(model);
}

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  loadModels();

  return {
    readRateLimitPerMinute: parseInt(optionalEnv('READ_RATE_LIMIT_PER_MINUTE', '30')),
    planRateLimitPerMinute: parseInt(optionalEnv('PLAN_RATE_LIMIT_PER_MINUTE', '10')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'Community-Axelot'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    subtensorEndpoint: optionalEnv('SUBTENSOR_ENDPOINT', 'wss://entrypoint-finney.opentensor.ai:443'),
    bittensorChain: optionalEnv('BITTENSOR_CHAIN', 'bittensor-finney'),
    marketCacheTtlMs: parseInt(optionalEnv('MARKET_CACHE_TTL_MS', '15000')),
    maxSubnetScan: parseInt(optionalEnv('MAX_SUBNET_SCAN', '256')),
  };
}
