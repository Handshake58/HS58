/**
 * HS58-OpenAI Provider Configuration
 * Fetches pricing from Marketplace, applies MARKUP_PERCENT.
 */

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

/**
 * Fetch models from OpenAI API
 */
async function fetchAPIModels(apiKey: string): Promise<string[]> {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
  const data = await response.json() as { data?: Array<{ id: string }> };
  return (data.data || []).map(m => m.id);
}

/**
 * Fetch pricing from Marketplace
 */
async function fetchMarketplacePricing(marketplaceUrl: string): Promise<Record<string, { inputPerM: number; outputPerM: number }>> {
  const response = await fetch(`${marketplaceUrl}/api/directory/pricing?provider=openai`);
  if (!response.ok) throw new Error(`Marketplace error: ${response.status}`);
  return response.json();
}

/**
 * Get default pricing based on model family (fallback if not in Marketplace)
 */
function getDefaultPrice(modelId: string): { inputPerM: number; outputPerM: number } {
  // OpenAI pricing tiers based on model
  if (modelId.includes('gpt-4o-mini')) return { inputPerM: 0.15, outputPerM: 0.60 };
  if (modelId.includes('gpt-4o')) return { inputPerM: 2.50, outputPerM: 10.00 };
  if (modelId.includes('gpt-4-turbo')) return { inputPerM: 10.00, outputPerM: 30.00 };
  if (modelId.includes('gpt-4')) return { inputPerM: 30.00, outputPerM: 60.00 };
  if (modelId.includes('gpt-3.5')) return { inputPerM: 0.50, outputPerM: 1.50 };
  if (modelId.includes('o1-mini')) return { inputPerM: 3.00, outputPerM: 12.00 };
  if (modelId.includes('o1')) return { inputPerM: 15.00, outputPerM: 60.00 };
  if (modelId.includes('o3-mini')) return { inputPerM: 1.10, outputPerM: 4.40 };
  // Default to gpt-4o pricing
  return { inputPerM: 2.50, outputPerM: 10.00 };
}

/**
 * Filter: Only chat-capable models (not embeddings, whisper, dall-e, etc.)
 */
function isChatModel(modelId: string): boolean {
  return modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3');
}

/**
 * Load models: API is source of truth, Marketplace provides pricing (with fallback)
 */
export async function loadModels(apiKey: string, markup: number, marketplaceUrl: string): Promise<void> {
  console.log('Loading models from OpenAI API...');
  const allModels = await fetchAPIModels(apiKey);
  const apiModels = allModels.filter(isChatModel);
  console.log(`  API returned ${allModels.length} models, ${apiModels.length} are chat models`);
  
  console.log('Fetching pricing from Marketplace...');
  const pricing = await fetchMarketplacePricing(marketplaceUrl);
  console.log(`  Marketplace has ${Object.keys(pricing).length} prices configured`);
  
  activeModels = new Map();
  
  // API models are the source of truth - offer what's available
  for (const modelId of apiModels) {
    const prices = pricing[modelId] ?? getDefaultPrice(modelId);
    const usedFallback = !pricing[modelId];
    
    activeModels.set(modelId, {
      inputPer1k: BigInt(Math.ceil((prices.inputPerM / 1000) * 1_000_000 * markup)),
      outputPer1k: BigInt(Math.ceil((prices.outputPerM / 1000) * 1_000_000 * markup)),
    });
    
    console.log(`  ${modelId}: $${prices.inputPerM}/${prices.outputPerM} per M ${usedFallback ? '(fallback)' : '✓'}`);
  }

  if (activeModels.size === 0) throw new Error('No models available from OpenAI API');
  console.log(`Loaded ${activeModels.size} models with ${(markup - 1) * 100}% markup`);
}

export const getModelPricing = (model: string): ModelPricing | null => activeModels.get(model) ?? null;
export const isModelSupported = (model: string): boolean => activeModels.has(model);
export const getSupportedModels = (): string[] => Array.from(activeModels.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));

  return {
    openaiApiKey: requireEnv('OPENAI_API_KEY'),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup: 1 + (markupPercent / 100),
    marketplaceUrl: optionalEnv('MARKETPLACE_URL', 'https://handshake58.com'),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-OpenAI'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}

export function calculateCost(pricing: ModelPricing, inputTokens: number, outputTokens: number): bigint {
  return (BigInt(inputTokens) * pricing.inputPer1k + BigInt(outputTokens) * pricing.outputPer1k) / 1000n;
}
