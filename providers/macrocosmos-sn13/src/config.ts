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

const DEFAULT_PRICE_SOCIAL_QUERY_USD = 0.003;
const DEFAULT_PRICE_SCRAPING_TASK_USD = 0.005;

export function loadModels(markup: number): void {
  activeModels = new Map();

  const socialPrice = parseFloat(optionalEnv('PRICE_PER_SOCIAL_QUERY', DEFAULT_PRICE_SOCIAL_QUERY_USD.toString()));
  const socialUsdc = BigInt(Math.ceil(socialPrice * markup * 1_000_000));
  activeModels.set('sn13/social-data', { inputPer1k: socialUsdc, outputPer1k: 0n });
  console.log(`  sn13/social-data: $${(Number(socialUsdc) / 1_000_000).toFixed(4)}/query`);

  const scrapingPrice = parseFloat(optionalEnv('PRICE_PER_SCRAPING_TASK', DEFAULT_PRICE_SCRAPING_TASK_USD.toString()));
  const scrapingUsdc = BigInt(Math.ceil(scrapingPrice * markup * 1_000_000));
  activeModels.set('sn13/web-scraping', { inputPer1k: scrapingUsdc, outputPer1k: 0n });
  console.log(`  sn13/web-scraping: $${(Number(scrapingUsdc) / 1_000_000).toFixed(4)}/task`);

  console.log(`Loaded ${activeModels.size} models with ${(markup - 1) * 100}% markup`);
}

export const getModelPricing = (model: string): ModelPricing | null => activeModels.get(model) ?? null;
export const isModelSupported = (model: string): boolean => activeModels.has(model);
export const getSupportedModels = (): string[] => Array.from(activeModels.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markup = 1 + (markupPercent / 100);

  const socialPriceUsd = parseFloat(optionalEnv('PRICE_PER_SOCIAL_QUERY', DEFAULT_PRICE_SOCIAL_QUERY_USD.toString()));
  const scrapingPriceUsd = parseFloat(optionalEnv('PRICE_PER_SCRAPING_TASK', DEFAULT_PRICE_SCRAPING_TASK_USD.toString()));

  const pricePerSocialQuery = BigInt(Math.ceil(socialPriceUsd * markup * 1_000_000));
  const pricePerScrapingTask = BigInt(Math.ceil(scrapingPriceUsd * markup * 1_000_000));

  return {
    macrocosmosApiKey: requireEnv('MACROCOSMOS_API_KEY'),
    pricePerSocialQuery,
    pricePerScrapingTask,
    rateLimitPerMinute: parseInt(optionalEnv('RATE_LIMIT_PER_MINUTE', '10')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup,
    providerName: optionalEnv('PROVIDER_NAME', 'Macrocosmos-SN13'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
