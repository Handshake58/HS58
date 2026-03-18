/**
 * HS58-Resend Provider Configuration
 *
 * Flat-rate per-email pricing. No external API calls needed for configuration.
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

const DEFAULT_PRICE_PER_EMAIL_USD = 0.003;

export function loadModels(markup: number): void {
  const pricePerEmail = parseFloat(optionalEnv('PRICE_PER_EMAIL', DEFAULT_PRICE_PER_EMAIL_USD.toString()));
  const priceUsdc = BigInt(Math.ceil(pricePerEmail * markup * 1_000_000));

  activeModels = new Map();

  activeModels.set('resend/send-email', {
    inputPer1k: priceUsdc,
    outputPer1k: 0n,
  });

  console.log(`  resend/send-email: $${(Number(priceUsdc) / 1_000_000).toFixed(4)}/email`);
  console.log(`Loaded 1 model with ${(markup - 1) * 100}% markup`);
}

export const getModelPricing = (model: string): ModelPricing | null => activeModels.get(model) ?? null;
export const isModelSupported = (model: string): boolean => activeModels.has(model);
export const getSupportedModels = (): string[] => Array.from(activeModels.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markup = 1 + (markupPercent / 100);
  const pricePerEmail = parseFloat(optionalEnv('PRICE_PER_EMAIL', DEFAULT_PRICE_PER_EMAIL_USD.toString()));
  const priceUsdc = BigInt(Math.ceil(pricePerEmail * markup * 1_000_000));

  const allowedDomainsStr = optionalEnv('RESEND_ALLOWED_DOMAINS', '');
  const allowedDomains = allowedDomainsStr
    ? allowedDomainsStr.split(',').map(d => d.trim()).filter(Boolean)
    : [];

  return {
    resendApiKey: requireEnv('RESEND_API_KEY'),
    defaultFrom: requireEnv('RESEND_DEFAULT_FROM'),
    allowedDomains,
    pricePerEmail: priceUsdc,
    maxRecipientsPerEmail: parseInt(optionalEnv('MAX_RECIPIENTS_PER_EMAIL', '10')),
    maxBodySizeBytes: parseInt(optionalEnv('MAX_BODY_SIZE_BYTES', '102400')),
    rateLimitPerMinute: parseInt(optionalEnv('RATE_LIMIT_PER_MINUTE', '12')),
    minEmailIntervalMs: Math.max(1000, parseInt(optionalEnv('MIN_EMAIL_INTERVAL_SECONDS', '5')) * 1000),
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
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Resend'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
