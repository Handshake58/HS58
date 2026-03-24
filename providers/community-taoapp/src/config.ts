/**
 * Community TaoApp Provider Configuration
 *
 * Flat-rate pricing: fixed cost per API request.
 */
import { config } from 'dotenv';
import type { ProviderConfig } from './types.js';
config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

/**
 * Allowlist of known TAO.app API endpoint prefixes.
 * Covers all documented endpoints from the OpenAPI spec.
 * Prevents arbitrary path traversal.
 */
const ALLOWED_ENDPOINTS = [
  // Macro Analytics
  'analytics/macro/aggregated',
  'analytics/dynamic-info/aggregated',
  'analytics/macro/fear_greed',
  'analytics/macro/fear_greed/current',
  'analytics/macro/root_claim_stats',
  'analytics/macro/root_claim_stats/current',

  // Subnets Analytics
  'analytics/subnets/aggregated',
  'analytics/subnets/holders',
  'subnets/ohlc',
  'analytics/subnets/info',
  'analytics/subnets/valuation',
  'analytics/subnets/transactions',
  'analytics/subnets/social/summary',

  // Price Sustainability
  'price-sustainability',

  // APY
  'apy/root',
  'apy/alpha',

  // TAO Metrics
  'current',
  'historical-price',

  // Subnet Screener
  'subnet_screener',

  // Subnet Tags
  'subnet_tags',

  // Validator Identities
  'validator_identities',

  // Portfolio
  'portfolio/events',
  'portfolio/transactions',
  'portfolio/transfers',
  'portfolio/stake-transfers/external',
  'portfolio/stake-transfers/internal',
  'portfolio/last-root-claim',
  'portfolio/allocation',
  'portfolio/historical-stake',

  // Accounting
  'accounting/events',
  'accounting/balance-history',
  'accounting/spot-balance',
  'accounting/emissions-events',
  'accounting/price-at-block',

  // Block
  'blocks/latest',
  'block/by-timestamp',
  'block/events',

  // Validators
  'validators/stakes',

  // Subnets
  'subnets/identity-changes',
  'subnets/about/summaries',
  'subnets/about',
  'subnets/sparklines',

  // Chain
  'chain/runtime-version',
];

/**
 * Dynamic path endpoints that contain path parameters (e.g. netuid, block_number).
 * These are matched by prefix only.
 */
const DYNAMIC_PREFIXES = [
  'analytics/subnets/info/',
  'analytics/subnets/metagraph/',
  'analytics/subnets/social/',
  'block/',
  'tx/',
  'address/extrinsics',
  'validators/stakes/',
];

export function isEndpointAllowed(endpoint: string): boolean {
  const normalized = endpoint.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (ALLOWED_ENDPOINTS.some(allowed => normalized === allowed.toLowerCase())) {
    return true;
  }
  if (DYNAMIC_PREFIXES.some(prefix => normalized.startsWith(prefix.toLowerCase()))) {
    return true;
  }
  return false;
}

export function getAllowedEndpoints(): string[] {
  return [...ALLOWED_ENDPOINTS, ...DYNAMIC_PREFIXES.map(p => `${p}{param}`)];
}

export function getRequestCost(cfg: ProviderConfig): bigint {
  return BigInt(Math.ceil(cfg.pricePerRequestUsdc * 1_000_000));
}

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137'));
  if (chainId !== 137 && chainId !== 80002)
    throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  return {
    taoappApiUrl: optionalEnv('TAOAPP_API_URL', 'https://api.tao.app'),
    taoappApiKey: requireEnv('TAOAPP_API_KEY'),
    pricePerRequestUsdc: parseFloat(optionalEnv('PRICE_PER_REQUEST_USDC', '0.005')),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId: chainId as 137 | 80002,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as `0x${string}`,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'Community-TaoApp'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    rateLimitPerMinute: parseInt(optionalEnv('RATE_LIMIT_PER_MINUTE', '10')),
  };
}
