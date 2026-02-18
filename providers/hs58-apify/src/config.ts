/**
 * HS58-Apify Provider Configuration
 *
 * Auto-loads popular Actors from Apify Store and calculates pricing
 * from their currentPricingInfo. Only APIFY_API_TOKEN is required.
 */

import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing, StoreActor, EventPricing, StoreActorPricing } from './types.js';
import type { Hex } from 'viem';
import { ApifyService } from './apify.js';

config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

let activeModels: Map<string, ModelPricing> = new Map();
let actorMap: Map<string, StoreActor> = new Map();

const ESTIMATED_RESULTS_PER_RUN = 10;

/**
 * Extract the highest per-event price (FREE tier) from an Actor's pricing.
 * Returns estimated cost for a single run.
 */
function estimateApifyCost(pricing: StoreActorPricing): number {
  if (pricing.pricingModel === 'FREE') return 0.005;

  if (pricing.pricingModel !== 'PAY_PER_EVENT' || !pricing.pricingPerEvent) {
    return 0.02;
  }

  const events = pricing.pricingPerEvent.actorChargeEvents;
  let oneTimeTotal = 0;
  let maxRecurringPrice = 0;

  for (const event of Object.values(events) as EventPricing[]) {
    const price = event.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd
               ?? event.eventPriceUsd
               ?? 0;

    if (event.isOneTimeEvent) {
      oneTimeTotal += price;
    } else {
      maxRecurringPrice = Math.max(maxRecurringPrice, price);
    }
  }

  return Math.max(oneTimeTotal + maxRecurringPrice * ESTIMATED_RESULTS_PER_RUN, 0.003);
}

/**
 * Calculate DRAIN price (USDC wei) and Apify budget for an Actor.
 */
function calculateActorPrice(pricing: StoreActorPricing, markupMultiplier: number): { drainPrice: bigint; apifyBudget: number } {
  const apifyCost = estimateApifyCost(pricing);
  const drainPriceUsd = apifyCost * markupMultiplier;
  const drainPrice = BigInt(Math.ceil(drainPriceUsd * 1_000_000));
  return { drainPrice, apifyBudget: apifyCost };
}

/**
 * Load Actors from Apify Store and calculate pricing.
 */
export async function loadModels(apifyService: ApifyService, actorLimit: number, markupMultiplier: number): Promise<void> {
  console.log(`[config] Loading top ${actorLimit} Actors from Apify Store...`);

  const rawActors = await apifyService.fetchStoreActors(actorLimit);
  const newModels = new Map<string, ModelPricing>();
  const newActors = new Map<string, StoreActor>();

  for (const raw of rawActors) {
    if (!raw.currentPricingInfo) continue;

    // Skip monthly subscription actors (not suitable for per-run micropayments)
    if (raw.currentPricingInfo.pricingModel === 'FLAT_PRICE_PER_MONTH') continue;

    const actorId = `${raw.username}/${raw.name}`;
    const { drainPrice, apifyBudget } = calculateActorPrice(raw.currentPricingInfo, markupMultiplier);

    const actor: StoreActor = {
      id: raw.id,
      name: raw.name,
      username: raw.username,
      title: raw.title,
      description: raw.description,
      currentPricingInfo: raw.currentPricingInfo,
      drainPrice,
      apifyBudget,
    };

    newActors.set(actorId, actor);

    // DRAIN pricing: flat rate per run, encoded as inputPer1k with 1000 tokens = 1 run
    newModels.set(actorId, {
      inputPer1k: drainPrice,
      outputPer1k: 0n,
    });

    const priceStr = (Number(drainPrice) / 1_000_000).toFixed(4);
    console.log(`  ${actorId}: $${priceStr}/run (${raw.currentPricingInfo.pricingModel})`);
  }

  activeModels = newModels;
  actorMap = newActors;
  console.log(`[config] Loaded ${newModels.size} Actors`);
}

export const getModelPricing = (model: string): ModelPricing | null => activeModels.get(model) ?? null;
export const isModelSupported = (model: string): boolean => activeModels.has(model);
export const getSupportedModels = (): string[] => Array.from(activeModels.keys());
export const getActor = (model: string): StoreActor | undefined => actorMap.get(model);
export const getAllActors = (): Map<string, StoreActor> => actorMap;

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  const markupPercent = parseInt(optionalEnv('APIFY_MARKUP_PERCENT', '100'));

  return {
    apifyApiToken: requireEnv('APIFY_API_TOKEN'),
    actorLimit: parseInt(optionalEnv('APIFY_ACTOR_LIMIT', '30')),
    maxItems: parseInt(optionalEnv('APIFY_MAX_ITEMS', '50')),
    maxWait: parseInt(optionalEnv('APIFY_MAX_WAIT', '120')),
    markupMultiplier: 1 + (markupPercent / 100),
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup: 1 + (markupPercent / 100),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-Apify'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
