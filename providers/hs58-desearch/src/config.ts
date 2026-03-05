/**
 * HS58-Desearch Provider Configuration
 *
 * Pricing is dynamic per request based on item count.
 * Base prices from Desearch API docs:
 *   - AI search endpoints:  $0.40 / 1000 items
 *   - Twitter endpoints:    $0.15 / 1000 posts
 *   - Web SERP search:      $0.10 / 100 searches ($1.00 / 1000)
 *   - Web crawl:            $0.50 / 1000 pages
 */

import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing } from './types.js';
import type { Hex } from 'viem';

config();

/** Price per 1000 units in USD (before markup) */
export const PRICE_PER_1000_USD: Record<string, number> = {
  'desearch/ai-search':            0.40,
  'desearch/ai-web-search':        0.40,
  'desearch/ai-twitter-search':    0.40,
  'desearch/twitter':              0.15,
  'desearch/twitter-urls':         0.15,
  'desearch/twitter-post':         0.15,
  'desearch/twitter-user-search':  0.15,
  'desearch/twitter-retweeters':   0.15,
  'desearch/twitter-user-posts':   0.15,
  'desearch/twitter-replies':      0.15,
  'desearch/twitter-post-replies': 0.15,
  'desearch/web':                  1.00, // $0.10/100 = $1.00/1000
  'desearch/web-crawl':            0.50,
};

/** Default unit count used for /v1/pricing display */
export const DEFAULT_UNITS: Record<string, number> = {
  'desearch/ai-search':            10,
  'desearch/ai-web-search':        10,
  'desearch/ai-twitter-search':    10,
  'desearch/twitter':              20,
  'desearch/twitter-urls':         5,
  'desearch/twitter-post':         1,
  'desearch/twitter-user-search':  10,
  'desearch/twitter-retweeters':   20,
  'desearch/twitter-user-posts':   20,
  'desearch/twitter-replies':      10,
  'desearch/twitter-post-replies': 10,
  'desearch/web':                  1,
  'desearch/web-crawl':            1,
};

export const MODEL_DESCRIPTIONS: Record<string, string> = {
  'desearch/ai-search':            'AI Contextual Search across web, X, Reddit, YouTube, HN, Wikipedia, arXiv. Input: {prompt, tools[], count?, date_filter?, result_type?}',
  'desearch/ai-web-search':        'AI Web Links Search (web, HN, Reddit, Wikipedia, YouTube, arXiv). Input: {prompt, tools[], count?}',
  'desearch/ai-twitter-search':    'AI X Posts Links Search using AI-powered models. Input: {prompt, count?}',
  'desearch/twitter':              'X Search API with rich filters (date, user, lang, media, engagement). Input: {query, sort?, user?, start_date?, end_date?, lang?, count?, min_likes?, ...}',
  'desearch/twitter-urls':         'Fetch full post data for a list of X post URLs. Input: {urls: string[]}',
  'desearch/twitter-post':         'Retrieve a single X post by ID. Input: {id}',
  'desearch/twitter-user-search':  'Search X posts by a specific user with optional keyword filter. Input: {user, query?, count?}',
  'desearch/twitter-retweeters':   'Get list of users who retweeted a post. Input: {id, cursor?}',
  'desearch/twitter-user-posts':   'Get a user\'s latest timeline posts. Input: {username, cursor?}',
  'desearch/twitter-replies':      'Fetch tweets and replies by a user. Input: {user, count?, query?}',
  'desearch/twitter-post-replies': 'Fetch replies to a specific post. Input: {post_id, count?, query?}',
  'desearch/web':                  'SERP Web Search — paginated search engine results. Input: {query, start?}',
  'desearch/web-crawl':            'Crawl a URL and return its content as text or HTML. Input: {url, format?}',
};

let pricingMap: Map<string, ModelPricing> = new Map();

/**
 * Build the pricing map using default unit counts for display.
 * Actual per-request cost is calculated dynamically in the route handler.
 */
export function buildPricing(markupMultiplier: number): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();

  for (const [model, pricePerK] of Object.entries(PRICE_PER_1000_USD)) {
    const units = DEFAULT_UNITS[model] ?? 10;
    const typicalUsd = (units / 1000) * pricePerK * markupMultiplier;
    const typicalWei = BigInt(Math.ceil(typicalUsd * 1_000_000));
    map.set(model, { inputPer1k: typicalWei, outputPer1k: 0n });
  }

  pricingMap = map;
  return map;
}

/**
 * Calculate the actual cost in USDC wei for a specific request.
 */
export function calculateRequestCost(
  modelId: string,
  params: Record<string, any>,
  markupMultiplier: number,
): bigint {
  const pricePerK = PRICE_PER_1000_USD[modelId] ?? 0;
  let units: number;

  switch (modelId) {
    case 'desearch/twitter-urls':
      units = Math.max(((params.urls as string[]) ?? []).length, 1);
      break;
    // Flat per-call (1 item/page/search)
    case 'desearch/twitter-post':
    case 'desearch/web':
    case 'desearch/web-crawl':
      units = 1;
      break;
    // Cursor-based: assume ~20 results
    case 'desearch/twitter-retweeters':
    case 'desearch/twitter-user-posts':
      units = 20;
      break;
    // Count-based
    default:
      units = (params.count as number) ?? DEFAULT_UNITS[modelId] ?? 10;
  }

  const priceUsd = (units / 1000) * pricePerK * markupMultiplier;
  // Minimum: $0.0001 to avoid dust amounts
  const minWei = 100n; // 0.0001 USDC
  const calculated = BigInt(Math.ceil(priceUsd * 1_000_000));
  return calculated > minWei ? calculated : minWei;
}

export const getModelPricing = (model: string): ModelPricing | null =>
  pricingMap.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  pricingMap.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(pricingMap.keys());

export function loadConfig(): ProviderConfig {
  // Direct process.env references so Railway detects all variables via static analysis
  const DESEARCH_API_KEY     = process.env.DESEARCH_API_KEY;
  const PROVIDER_PRIVATE_KEY = process.env.PROVIDER_PRIVATE_KEY;
  const POLYGON_RPC_URL      = process.env.POLYGON_RPC_URL;
  const CHAIN_ID             = process.env.CHAIN_ID             ?? '137';
  const PROVIDER_NAME        = process.env.PROVIDER_NAME        ?? 'HS58-Desearch';
  const MARKUP_PERCENT       = process.env.MARKUP_PERCENT       ?? '50';
  const CLAIM_THRESHOLD      = process.env.CLAIM_THRESHOLD      ?? '1000000';
  const PORT                 = process.env.PORT                 ?? '3000';
  const HOST                 = process.env.HOST                 ?? '0.0.0.0';
  const STORAGE_PATH         = process.env.STORAGE_PATH         ?? './data/vouchers.json';
  const AUTO_CLAIM_INTERVAL_MINUTES = process.env.AUTO_CLAIM_INTERVAL_MINUTES ?? '10';
  const AUTO_CLAIM_BUFFER_SECONDS   = process.env.AUTO_CLAIM_BUFFER_SECONDS   ?? '3600';

  if (!DESEARCH_API_KEY)     throw new Error('Missing env: DESEARCH_API_KEY');
  if (!PROVIDER_PRIVATE_KEY) throw new Error('Missing env: PROVIDER_PRIVATE_KEY');

  const chainId = parseInt(CHAIN_ID) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  const markupMultiplier = 1 + (parseInt(MARKUP_PERCENT) / 100);
  const pricing = buildPricing(markupMultiplier);

  return {
    desearchApiKey: DESEARCH_API_KEY,
    markupMultiplier,
    port: parseInt(PORT),
    host: HOST,
    chainId,
    providerPrivateKey: PROVIDER_PRIVATE_KEY as Hex,
    polygonRpcUrl: POLYGON_RPC_URL || undefined,
    pricing,
    claimThreshold: BigInt(CLAIM_THRESHOLD),
    storagePath: STORAGE_PATH,
    providerName: PROVIDER_NAME,
    autoClaimIntervalMinutes: parseInt(AUTO_CLAIM_INTERVAL_MINUTES),
    autoClaimBufferSeconds: parseInt(AUTO_CLAIM_BUFFER_SECONDS),
  };
}
