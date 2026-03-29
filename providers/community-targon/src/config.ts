import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing } from './types.js';
import type { Hex } from 'viem';

config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Static pricing for Targon compute operations.
 * inputPer1k = flat price per request (USDC-wei, 6 decimals).
 * outputPer1k = always 0n (flat-rate model).
 *
 * Pricing rationale:
 *   - Read ops (inventory, list, status): $0.001 — informational, minimal overhead
 *   - Create ops: $2.50 — covers ~1hr of H200 compute at $2.49/hr as setup fee
 *   - Delete op: $0.25 — small admin fee
 */
export const MODELS: Map<string, ModelPricing> = new Map([
  ['targon/inventory',         { inputPer1k: 1_000n,    outputPer1k: 0n }], // $0.001
  ['targon/workloads',         { inputPer1k: 1_000n,    outputPer1k: 0n }], // $0.001
  ['targon/workload-status',   { inputPer1k: 1_000n,    outputPer1k: 0n }], // $0.001
  ['targon/create-serverless', { inputPer1k: 2_500_000n, outputPer1k: 0n }], // $2.50
  ['targon/create-rental',     { inputPer1k: 2_500_000n, outputPer1k: 0n }], // $2.50
  ['targon/delete-workload',   { inputPer1k: 250_000n,  outputPer1k: 0n }], // $0.25
]);

export function getModelPricing(model: string): ModelPricing | null {
  return MODELS.get(model) ?? null;
}

export function isModelSupported(model: string): boolean {
  return MODELS.has(model);
}

export function getSupportedModels(): string[] {
  return Array.from(MODELS.keys());
}

export function loadConfig(): ProviderConfig {
  const chainIdStr = optionalEnv('CHAIN_ID', '137');
  const chainId = parseInt(chainIdStr) as 137 | 80002;

  if (chainId !== 137 && chainId !== 80002) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}. Must be 137 or 80002.`);
  }

  return {
    targonApiKey: requireEnv('TARGON_API_KEY'),
    targonApiUrl: optionalEnv('TARGON_API_URL', 'https://api.targon.com/tha/v2').replace(/\/$/, ''),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'Community-Targon'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
  };
}
