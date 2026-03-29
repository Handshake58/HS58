import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing, TargonModel } from './types.js';
import type { Hex } from 'viem';

config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    return `MISSING_${name}`;
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

let pricingCache: Map<string, ModelPricing> = new Map();
let modelListCache: TargonModel[] = [];
let lastPricingUpdate = 0;

export async function fetchTargonModels(apiUrl: string, apiKey: string): Promise<TargonModel[]> {
  try {
    const response = await fetch(`${apiUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Targon API error: ${response.status}`);
    }

    const data = await response.json() as { data?: TargonModel[] };
    return data.data || [];
  } catch (error) {
    console.error('Failed to fetch Targon models:', error);
    return [];
  }
}

function convertPricing(model: TargonModel, defaultInputPerM: number, defaultOutputPerM: number, markup: number): ModelPricing {
  let inputPerToken = defaultInputPerM / 1_000_000;
  let outputPerToken = defaultOutputPerM / 1_000_000;

  if (model.pricing) {
    if (model.pricing.input) {
      inputPerToken = parseFloat(model.pricing.input) || inputPerToken;
    }
    if (model.pricing.output) {
      outputPerToken = parseFloat(model.pricing.output) || outputPerToken;
    }
    if (model.pricing.per_token) {
      const pt = parseFloat(model.pricing.per_token) || 0;
      if (pt > 0) {
        inputPerToken = pt;
        outputPerToken = pt;
      }
    }
  }

  const inputPer1k = BigInt(Math.ceil(inputPerToken * 1000 * 1_000_000 * markup));
  const outputPer1k = BigInt(Math.ceil(outputPerToken * 1000 * 1_000_000 * markup));
  return { inputPer1k, outputPer1k };
}

export async function updatePricingCache(
  apiUrl: string,
  apiKey: string,
  defaultInputPerM: number,
  defaultOutputPerM: number,
  markup: number
): Promise<void> {
  console.log('Updating models and pricing from Targon API...');

  const models = await fetchTargonModels(apiUrl, apiKey);

  if (models.length === 0) {
    console.warn('No models returned from Targon API');
    return;
  }

  const newPricing = new Map<string, ModelPricing>();

  for (const model of models) {
    newPricing.set(model.id, convertPricing(model, defaultInputPerM, defaultOutputPerM, markup));
  }

  pricingCache = newPricing;
  modelListCache = models;
  lastPricingUpdate = Date.now();

  console.log(`Loaded pricing for ${newPricing.size} models (${(markup - 1) * 100}% markup)`);
}

export function getModelPricing(model: string): ModelPricing | null {
  return pricingCache.get(model) ?? null;
}

export function isModelSupported(model: string): boolean {
  return pricingCache.has(model);
}

export function getSupportedModels(): string[] {
  return Array.from(pricingCache.keys());
}

export function getModelList(): TargonModel[] {
  return modelListCache;
}

export function getPricingAge(): number {
  return Math.floor((Date.now() - lastPricingUpdate) / 1000);
}

export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number
): bigint {
  const inputCost = (BigInt(inputTokens) * pricing.inputPer1k) / 1000n;
  const outputCost = (BigInt(outputTokens) * pricing.outputPer1k) / 1000n;
  return inputCost + outputCost;
}

export function loadConfig(): ProviderConfig {
  const chainIdStr = optionalEnv('CHAIN_ID', '137');
  const chainId = parseInt(chainIdStr) as 137 | 80002;

  if (chainId !== 137 && chainId !== 80002) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}. Must be 137 or 80002.`);
  }

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markup = 1 + markupPercent / 100;

  return {
    targonApiKey: requireEnv('TARGON_API_KEY'),
    targonApiUrl: optionalEnv('TARGON_API_URL', 'https://api.targon.com/v1').replace(/\/$/, ''),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: pricingCache,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '10000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    pricingRefreshInterval: parseInt(optionalEnv('PRICING_REFRESH_INTERVAL', '3600')) * 1000,
    markup,
    providerName: optionalEnv('PROVIDER_NAME', 'Community-Targon'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    defaultInputPricePerM: parseFloat(optionalEnv('DEFAULT_INPUT_PRICE_PER_M', '0.50')),
    defaultOutputPricePerM: parseFloat(optionalEnv('DEFAULT_OUTPUT_PRICE_PER_M', '1.50')),
  };
}
