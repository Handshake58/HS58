/**
 * Community Taostats Provider Configuration
 *
 * Flat-rate pricing: fixed cost per API request.
 */

import { config } from 'dotenv';
import type { ProviderConfig } from './types.js';
import type { Hex } from 'viem';

config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

/**
 * Allowlist of known Taostats API endpoint prefixes.
 * Prevents arbitrary path traversal while covering the full API surface.
 */
const ALLOWED_ENDPOINTS = [
  // Price
  'price/latest', 'price/history', 'price/ohlc',
  // Wallets / Accounts
  'account/latest', 'account/history', 'transfer',
  'exchange', 'coldkey_swap/pending',
  'on_chain_identity/latest', 'on_chain_identity/history',
  // Staking / Delegation
  'stake/latest', 'stake/history',
  'dtao/stake_balance_aggregated/latest',
  'dtao/slippage/latest',
  'delegation/event',
  'stake/portfolio',
  // Validation
  'validator/latest', 'validator/history',
  'validator/metrics/latest', 'validator/metrics/history',
  'validator/parent_child/latest', 'validator/parent_child/history',
  'validator/performance/latest', 'validator/performance/history',
  'validator/weights/latest/v2', 'validator/weights/history/v2',
  'validator/alpha_shares/latest', 'validator/alpha_shares/history',
  'validator/subnet/latest',
  'validator/yield/latest',
  'hotkey/emission',
  'validator/apy/history',
  // Mining
  'miner/weight/latest', 'miner/weight/history',
  'miner/coldkey',
  // Metagraph
  'metagraph/latest', 'metagraph/history',
  'root_metagraph/latest', 'root_metagraph/history',
  'neuron/registration', 'neuron/deregistration',
  'subnet/coldkey_distribution', 'subnet/axon_ip_distribution',
  'subnet/miner_incentive_distribution',
  // Subnet
  'subnet/latest', 'subnet/history',
  'subnet/pool/latest', 'subnet/pool/history',
  'subnet/emission',
  'subnet/identity/latest', 'subnet/identity/history',
  'subnet/owner',
  'subnet/registration_cost/latest', 'subnet/registration_cost/history',
  'subnet/registration',
  'subnet/deregistration_ranking/latest', 'subnet/deregistration_ranking/history',
  'subnet/price/sum', 'subnet/price/sum/latest', 'subnet/price/sum/history',
  'subnet/burned_alpha', 'subnet/burned_alpha/total',
  'subnet/github/latest', 'subnet/github/history',
  'subnet/tao_flow',
  // Network / Chain
  'block/latest', 'block/interval',
  'extrinsic', 'event', 'chain_call',
  'stats/latest', 'stats/history',
  'runtime_version/latest', 'runtime_version/history',
  'proxy_call', 'tao_emission',
  // Liquidity
  'liquidity/distribution', 'liquidity/position',
  'liquidity/position_event', 'liquidity/tick_to_price',
  // EVM
  'evm/transaction', 'evm/block', 'evm/contract', 'evm/log', 'evm/address',
  // CoinGecko
  'coingecko/asset', 'coingecko/event', 'coingecko/block', 'coingecko/pair',
  // Tax / Accounting
  'tax/report', 'tax/report/csv', 'tax/tokens_held',
  // Trading View
  'tradingview/history',
];

export function isEndpointAllowed(endpoint: string): boolean {
  const normalized = endpoint.replace(/^\/+|\/+$/g, '').toLowerCase();
  return ALLOWED_ENDPOINTS.some(allowed =>
    normalized === allowed.toLowerCase() || normalized.startsWith(allowed.toLowerCase() + '/')
  );
}

export function getAllowedEndpoints(): string[] {
  return [...ALLOWED_ENDPOINTS];
}

export function getRequestCost(cfg: ProviderConfig): bigint {
  return BigInt(Math.ceil(cfg.pricePerRequestUsdc * 1_000_000));
}

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  return {
    taostatsApiUrl: optionalEnv('TAOSTATS_API_URL', 'https://api.taostats.io'),
    taostatsApiKey: requireEnv('TAOSTATS_API_KEY'),
    pricePerRequestUsdc: parseFloat(optionalEnv('PRICE_PER_REQUEST_USDC', '0.005')),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'Community-Taostats'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
