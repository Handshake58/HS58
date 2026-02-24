/**
 * HS58-Faster-Whisper Provider Configuration
 * Pricing per second of audio, applied per model with markup.
 */

import { config } from 'dotenv';
import type { ProviderConfig, AudioPricing } from './types.js';
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
 * Base prices per second (USDC, before markup):
 *   tiny:   $0.00004/sec  = 40 USDC-wei/sec
 *   base:   $0.00006/sec  = 60 USDC-wei/sec
 *   small:  $0.00008/sec  = 80 USDC-wei/sec
 *   medium: $0.00012/sec  = 120 USDC-wei/sec
 */
const BASE_PRICES: Record<string, number> = {
  'Systran/faster-whisper-tiny':      40,
  'Systran/faster-whisper-tiny.en':   40,
  'Systran/faster-whisper-base':      60,
  'Systran/faster-whisper-base.en':   60,
  'Systran/faster-whisper-small':     80,
  'Systran/faster-whisper-small.en':  80,
  'Systran/faster-whisper-medium':    120,
  'Systran/faster-whisper-medium.en': 120,
};

let activePricing: Map<string, AudioPricing> = new Map();

/**
 * Load models from the speaches server
 */
async function fetchAvailableModels(serverUrl: string, apiKey: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${serverUrl}/v1/models`, { headers });
    if (!response.ok) throw new Error(`Speaches API error: ${response.status}`);

    const data = await response.json() as { data?: Array<{ id: string }> };
    return (data.data || []).map(m => m.id).filter(id => id.includes('whisper'));
  } catch (error) {
    console.warn('Could not fetch models from speaches server, using defaults');
    return Object.keys(BASE_PRICES);
  }
}

/**
 * Initialize pricing for available models
 */
export async function loadModels(serverUrl: string, apiKey: string, markup: number): Promise<void> {
  console.log('Loading models from speaches server...');
  const models = await fetchAvailableModels(serverUrl, apiKey);
  console.log(`  Found ${models.length} whisper models`);

  activePricing = new Map();

  for (const modelId of models) {
    const basePrice = BASE_PRICES[modelId];
    if (!basePrice) {
      console.log(`  ${modelId}: no pricing configured, skipping`);
      continue;
    }

    activePricing.set(modelId, {
      pricePerSecond: BigInt(Math.ceil(basePrice * markup)),
    });

    const finalPrice = Math.ceil(basePrice * markup);
    console.log(`  ${modelId}: ${finalPrice} USDC-wei/sec ($${(finalPrice / 1_000_000).toFixed(6)}/sec)`);
  }

  if (activePricing.size === 0) {
    console.warn('No models matched pricing config, loading all defaults');
    for (const [modelId, basePrice] of Object.entries(BASE_PRICES)) {
      activePricing.set(modelId, {
        pricePerSecond: BigInt(Math.ceil(basePrice * markup)),
      });
    }
  }

  console.log(`Loaded ${activePricing.size} models with ${(markup - 1) * 100}% markup`);
}

export const getModelPricing = (model: string): AudioPricing | null =>
  activePricing.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  activePricing.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(activePricing.keys());

/**
 * Calculate cost for a transcription based on audio duration
 */
export function calculateCost(pricing: AudioPricing, durationSeconds: number): bigint {
  const ceilDuration = BigInt(Math.ceil(durationSeconds));
  return ceilDuration * pricing.pricePerSecond;
}

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));

  return {
    whisperServerUrl: optionalEnv('WHISPER_SERVER_URL', 'http://localhost:8100'),
    whisperApiKey: optionalEnv('WHISPER_API_KEY', ''),
    defaultModel: optionalEnv('DEFAULT_MODEL', 'Systran/faster-whisper-base'),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activePricing,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup: 1 + (markupPercent / 100),
    marketplaceUrl: optionalEnv('MARKETPLACE_URL', 'https://handshake58.com'),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Faster-Whisper'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
