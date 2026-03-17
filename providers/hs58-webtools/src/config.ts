import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing } from './types.js';
import type { Hex } from 'viem';

config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

let activeModels: Map<string, ModelPricing> = new Map();

function usd(price: number): bigint {
  return BigInt(Math.ceil(price * 1_000_000));
}

export function loadModels(): void {
  activeModels = new Map();

  const models: [string, number][] = [
    ['webtools/fetch-clean',     0.0075],
    ['webtools/fetch-markdown',  0.01],
    ['webtools/fetch-html',      0.0075],
    ['webtools/url-meta',        0.0075],
    ['webtools/url-links',       0.0075],
    ['webtools/rss-parse',       0.01],
    ['webtools/sitemap-parse',   0.01],
    ['webtools/robots-txt',      0.0075],
    ['webtools/url-expand',      0.0075],
    ['webtools/webhook-send',    0.0075],
    ['webtools/http-probe',      0.0075],
    ['webtools/http-headers',    0.0075],
  ];

  for (const [id, price] of models) {
    activeModels.set(id, { inputPer1k: usd(price), outputPer1k: 0n });
  }

  console.log(`Loaded ${activeModels.size} models (flat-rate pricing)`);
}

export const getModelPricing = (model: string): ModelPricing | null =>
  activeModels.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  activeModels.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(activeModels.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  loadModels();

  return {
    rateLimitPerMinute: parseInt(optionalEnv('RATE_LIMIT_PER_MINUTE', '30')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Webtools'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
