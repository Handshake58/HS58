/**
 * HS58-OpenRouter Provider Configuration
 * 
 * Auto-discovers models and pricing from OpenRouter API.
 * Applies 50% markup on all upstream prices.
 */

import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing, OpenRouterModel } from './types.js';
import type { Hex } from 'viem';

// Load .env file
config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`⚠️ Missing required environment variable: ${name}`);
    console.error(`Please set ${name} in Railway Variables`);
    return `MISSING_${name}`;
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// Global pricing cache
let pricingCache: Map<string, ModelPricing> = new Map();
let modelListCache: OpenRouterModel[] = [];
let lastPricingUpdate = 0;

/**
 * Fetch models and pricing from OpenRouter API
 */
export async function fetchOpenRouterModels(apiKey: string, providerName: string): Promise<OpenRouterModel[]> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://handshake58.com',
        'X-Title': providerName,
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { data?: OpenRouterModel[] };
    return data.data || [];
  } catch (error) {
    console.error('Failed to fetch OpenRouter models:', error);
    return [];
  }
}

/**
 * Convert OpenRouter pricing to DRAIN pricing (with markup)
 * 
 * OpenRouter pricing is per token (as string, e.g., "0.000003")
 * DRAIN pricing is per 1000 tokens in USDC wei (6 decimals)
 * 
 * Formula: (price_per_token * 1000 * 1_000_000) * markup
 */
function convertPricing(orModel: OpenRouterModel, markup: number): ModelPricing {
  const promptPrice = parseFloat(orModel.pricing.prompt) || 0;
  const completionPrice = parseFloat(orModel.pricing.completion) || 0;
  
  // Convert to per-1000 tokens in USDC wei with markup
  // 1 USDC = 1_000_000 wei (6 decimals)
  const inputPer1k = BigInt(Math.ceil(promptPrice * 1000 * 1_000_000 * markup));
  const outputPer1k = BigInt(Math.ceil(completionPrice * 1000 * 1_000_000 * markup));
  
  return { inputPer1k, outputPer1k };
}

/**
 * Update pricing cache from OpenRouter API
 */
export async function updatePricingCache(apiKey: string, markup: number, providerName: string): Promise<void> {
  console.log('🔄 Updating pricing from OpenRouter API...');
  
  const models = await fetchOpenRouterModels(apiKey, providerName);
  
  if (models.length === 0) {
    console.warn('⚠️ No models returned from OpenRouter API');
    return;
  }

  const newPricing = new Map<string, ModelPricing>();
  
  for (const model of models) {
    if (model.pricing?.prompt && model.pricing?.completion) {
      newPricing.set(model.id, convertPricing(model, markup));
    }
  }

  pricingCache = newPricing;
  modelListCache = models;
  lastPricingUpdate = Date.now();
  
  console.log(`✅ Loaded pricing for ${newPricing.size} models (${markup * 100 - 100}% markup)`);
}

/**
 * Get pricing for a model
 */
export function getModelPricing(model: string): ModelPricing | null {
  return pricingCache.get(model) ?? null;
}

/**
 * Check if a model is supported
 */
export function isModelSupported(model: string): boolean {
  return pricingCache.has(model);
}

/**
 * Get all supported models
 */
export function getSupportedModels(): string[] {
  return Array.from(pricingCache.keys());
}

/**
 * Get full model list with details
 */
export function getModelList(): OpenRouterModel[] {
  return modelListCache;
}

/**
 * Get pricing cache age in seconds
 */
export function getPricingAge(): number {
  return Math.floor((Date.now() - lastPricingUpdate) / 1000);
}

/**
 * Load and validate configuration
 */
export function loadConfig(): ProviderConfig {
  const chainIdStr = optionalEnv('CHAIN_ID', '137');
  const chainId = parseInt(chainIdStr) as 137 | 80002;
  
  if (chainId !== 137 && chainId !== 80002) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}. Must be 137 (mainnet) or 80002 (testnet).`);
  }

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markup = 1 + (markupPercent / 100); // 50% -> 1.5

  return {
    openrouterApiKey: requireEnv('OPENROUTER_API_KEY'),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: pricingCache, // Will be populated by updatePricingCache
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '10000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    pricingRefreshInterval: parseInt(optionalEnv('PRICING_REFRESH_INTERVAL', '3600')) * 1000, // 1 hour
    markup,
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-OpenRouter'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}

/**
 * Calculate cost for a request
 */
export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number
): bigint {
  const inputCost = (BigInt(inputTokens) * pricing.inputPer1k) / 1000n;
  const outputCost = (BigInt(outputTokens) * pricing.outputPer1k) / 1000n;
  return inputCost + outputCost;
}
