/**
 * HS58-Chutes Provider Configuration
 * 
 * Auto-discovers models and pricing from Chutes API.
 * Applies 50% markup on all upstream prices.
 */

import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing, ChutesModel } from './types.js';
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
let modelListCache: ChutesModel[] = [];
let lastPricingUpdate = 0;

/**
 * Fetch models from Chutes LLM API
 * Endpoint: https://llm.chutes.ai/v1/models
 */
export async function fetchChutesModels(apiKey: string): Promise<ChutesModel[]> {
  try {
    console.log('  Fetching from https://llm.chutes.ai/v1/models...');
    
    const response = await fetch('https://llm.chutes.ai/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  Chutes API error: ${response.status} - ${errorText}`);
      throw new Error(`Chutes API error: ${response.status}`);
    }
    
    const data = await response.json() as { data?: any[] };
    console.log(`  API returned ${data.data?.length || 0} models`);
    
    // Map to our format with pricing from model metadata
    return (data.data || []).map((m: any) => {
      // Chutes pricing is per 1M tokens
      const inputPrice = m.pricing?.input || m.pricing?.prompt || 0.10;
      const outputPrice = m.pricing?.output || m.pricing?.completion || 0.30;
      
      return {
        id: m.id,
        name: m.id.split('/').pop() || m.id,
        input_price: inputPrice,
        output_price: outputPrice,
        context_length: m.context_length || 32000,
      };
    });
  } catch (error) {
    console.error('Failed to fetch Chutes models:', error);
    console.log('  Using fallback models...');
    return getDefaultModels();
  }
}

/**
 * Default models as fallback if API doesn't return pricing
 * Based on https://llm.chutes.ai available models
 */
function getDefaultModels(): ChutesModel[] {
  return [
    // DeepSeek models
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', input_price: 0.30, output_price: 1.00 },
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', input_price: 0.30, output_price: 1.00 },
    { id: 'deepseek-ai/DeepSeek-V3.1', name: 'DeepSeek V3.1', input_price: 0.20, output_price: 0.80 },
    { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', name: 'DeepSeek R1 Distill 70B', input_price: 0.03, output_price: 0.13 },
    // Qwen models
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', input_price: 0.07, output_price: 0.26 },
    { id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen 3 235B', input_price: 0.30, output_price: 1.00 },
    { id: 'Qwen/Qwen3-32B', name: 'Qwen 3 32B', input_price: 0.05, output_price: 0.20 },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen 2.5 Coder 32B', input_price: 0.04, output_price: 0.16 },
    // Mistral models
    { id: 'unsloth/Mistral-Small-24B-Instruct-2501', name: 'Mistral Small 24B', input_price: 0.05, output_price: 0.22 },
    { id: 'unsloth/Mistral-Nemo-Instruct-2407', name: 'Mistral Nemo', input_price: 0.03, output_price: 0.11 },
    // Hermes models
    { id: 'NousResearch/Hermes-4-70B', name: 'Hermes 4 70B', input_price: 0.11, output_price: 0.38 },
    // Gemma models
    { id: 'unsloth/gemma-3-27b-it', name: 'Gemma 3 27B', input_price: 0.13, output_price: 0.52 },
  ];
}

/**
 * Convert Chutes pricing to DRAIN pricing (with markup)
 * 
 * Chutes pricing is per million tokens
 * DRAIN pricing is per 1000 tokens in USDC wei (6 decimals)
 * 
 * Formula: (price_per_million / 1000) * 1_000_000 * markup
 */
function convertPricing(model: ChutesModel, markup: number): ModelPricing {
  const inputPer1k = BigInt(Math.ceil((model.input_price / 1000) * 1_000_000 * markup));
  const outputPer1k = BigInt(Math.ceil((model.output_price / 1000) * 1_000_000 * markup));
  
  return { inputPer1k, outputPer1k };
}

/**
 * Update pricing cache from Chutes API
 */
export async function updatePricingCache(apiKey: string, markup: number): Promise<void> {
  console.log('🔄 Updating pricing from Chutes API...');
  
  let models = await fetchChutesModels(apiKey);
  
  // Use defaults if API returned empty
  if (models.length === 0) {
    console.warn('⚠️ No models returned from Chutes API, using defaults');
    models = getDefaultModels();
  }

  const newPricing = new Map<string, ModelPricing>();
  
  for (const model of models) {
    newPricing.set(model.id, convertPricing(model, markup));
    console.log(`  ${model.id}: $${model.input_price}/$${model.output_price} per M`);
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
export function getModelList(): ChutesModel[] {
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
  const markup = 1 + (markupPercent / 100);

  return {
    chutesApiKey: requireEnv('CHUTES_API_KEY'),
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
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Chutes'),
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
