/**
 * HS58-Custom Provider Configuration
 * 
 * Models and pricing are configured via environment variables.
 * No external API calls needed for configuration.
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
 * Default pricing per 1M tokens (USD) -- used when CUSTOM_PRICING is not set.
 * Conservative defaults that work for most open-source models.
 */
const DEFAULT_INPUT_PER_M = 0.10;
const DEFAULT_OUTPUT_PER_M = 0.20;

/**
 * Load models and pricing from environment variables.
 * 
 * CUSTOM_MODELS: comma-separated model IDs (required)
 *   Example: "llama3:8b,mistral:7b,codellama:13b"
 * 
 * CUSTOM_PRICING: JSON object mapping model IDs to pricing (optional)
 *   Example: {"llama3:8b":{"input":0.05,"output":0.10},"mistral:7b":{"input":0.03,"output":0.06}}
 *   Prices are per 1M tokens in USD. Models not in this map get the default pricing.
 */
export function loadModels(markup: number): void {
  const modelsStr = requireEnv('CUSTOM_MODELS');
  const modelIds = modelsStr.split(',').map(m => m.trim()).filter(Boolean);

  if (modelIds.length === 0) {
    throw new Error('CUSTOM_MODELS is empty. Provide comma-separated model IDs.');
  }

  // Parse custom pricing if provided
  let customPricing: Record<string, { input: number; output: number }> = {};
  const pricingStr = process.env.CUSTOM_PRICING;
  if (pricingStr) {
    try {
      customPricing = JSON.parse(pricingStr);
    } catch (e) {
      throw new Error(`Invalid CUSTOM_PRICING JSON: ${e}`);
    }
  }

  activeModels = new Map();

  for (const modelId of modelIds) {
    const prices = customPricing[modelId] ?? {
      input: DEFAULT_INPUT_PER_M,
      output: DEFAULT_OUTPUT_PER_M,
    };

    activeModels.set(modelId, {
      inputPer1k: BigInt(Math.ceil((prices.input / 1000) * 1_000_000 * markup)),
      outputPer1k: BigInt(Math.ceil((prices.output / 1000) * 1_000_000 * markup)),
    });

    const usedDefault = !customPricing[modelId];
    console.log(`  ${modelId}: $${prices.input}/${prices.output} per M ${usedDefault ? '(default)' : '✓'}`);
  }

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
    apiBaseUrl: requireEnv('CUSTOM_API_BASE_URL'),
    apiKey: optionalEnv('CUSTOM_API_KEY', ''),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup: 1 + (markupPercent / 100),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Custom'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}

export function calculateCost(pricing: ModelPricing, inputTokens: number, outputTokens: number): bigint {
  return (BigInt(inputTokens) * pricing.inputPer1k + BigInt(outputTokens) * pricing.outputPer1k) / 1000n;
}
