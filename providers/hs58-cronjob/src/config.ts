/**
 * HS58-CronJob Provider Configuration
 *
 * Defines static operation models (create/update/delete/list/get/history)
 * and their DRAIN pricing. Only CRONJOB_API_KEY is required.
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

/**
 * Static operation models with base prices in USD.
 * Each "model" maps to one cron-job.org API operation.
 *
 * Prices are in USDC (6 decimals) and multiplied by the markup.
 */
export const OPERATION_BASE_PRICES_USD: Record<string, number> = {
  'cronjob/create':  0.05,  // Creates a new scheduled job
  'cronjob/update':  0.02,  // Modifies an existing job (enable/disable, reschedule, etc.)
  'cronjob/delete':  0.01,  // Removes a job permanently
  'cronjob/list':    0.005, // Lists all jobs in this provider account
  'cronjob/get':     0.005, // Retrieves details of one specific job
  'cronjob/history': 0.005, // Gets execution logs for a job
};

export const OPERATION_DESCRIPTIONS: Record<string, string> = {
  'cronjob/create':  'Create a new scheduled HTTP job. Input: {url, title?, schedule?, requestMethod?, extendedData?}',
  'cronjob/update':  'Update an existing job. Input: {jobId, ...fields to change}',
  'cronjob/delete':  'Delete a job permanently. Input: {jobId}',
  'cronjob/list':    'List all cron jobs in this provider account. No input required.',
  'cronjob/get':     'Get detailed info about one job. Input: {jobId}',
  'cronjob/history': 'Get execution history for a job. Input: {jobId}',
};

let pricingMap: Map<string, ModelPricing> = new Map();

/**
 * Build the pricing map from base prices and markup.
 */
export function buildPricing(markupMultiplier: number): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();

  for (const [op, baseUsd] of Object.entries(OPERATION_BASE_PRICES_USD)) {
    const priceUsd = baseUsd * markupMultiplier;
    const priceWei = BigInt(Math.ceil(priceUsd * 1_000_000));
    map.set(op, { inputPer1k: priceWei, outputPer1k: 0n });
  }

  pricingMap = map;
  return map;
}

export const getModelPricing = (model: string): ModelPricing | null =>
  pricingMap.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  pricingMap.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(pricingMap.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  }

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markupMultiplier = 1 + (markupPercent / 100);

  const pricing = buildPricing(markupMultiplier);

  return {
    cronjobApiKey: requireEnv('CRONJOB_API_KEY'),
    markupMultiplier,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-CronJob'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
