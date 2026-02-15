/**
 * HS58-OpenRouter Provider Types
 */

import type { Hash, Hex } from 'viem';

/**
 * Model pricing from OpenRouter
 */
export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

/**
 * OpenRouter model info from API
 */
export interface OpenRouterModel {
  id: string;
  name: string;
  pricing: {
    prompt: string;  // Price per token
    completion: string;
  };
  context_length?: number;
  top_provider?: {
    max_completion_tokens?: number;
  };
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  openrouterApiKey: string;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: Hex;
  polygonRpcUrl?: string;
  pricing: Map<string, ModelPricing>;
  claimThreshold: bigint;
  storagePath: string;
  pricingRefreshInterval: number;
  markup: number;
  providerName: string;
  autoClaimIntervalMinutes: number;
  autoClaimBufferSeconds: number;
}

/**
 * Voucher from X-DRAIN-Voucher header
 */
export interface VoucherHeader {
  channelId: Hash;
  amount: string;
  nonce: string;
  signature: Hex;
}

/**
 * Stored voucher with metadata
 */
export interface StoredVoucher {
  channelId: Hash;
  amount: bigint;
  nonce: bigint;
  signature: Hex;
  consumer: string;
  receivedAt: number;
  claimed: boolean;
  claimedAt?: number;
  claimTxHash?: Hash;
}

/**
 * Channel state tracked by provider
 */
export interface ChannelState {
  channelId: Hash;
  consumer: string;
  deposit: bigint;
  totalCharged: bigint;
  expiry: number;
  lastVoucher?: StoredVoucher;
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Cost calculation result
 */
export interface CostResult {
  cost: bigint;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * DRAIN response headers
 */
export interface DrainResponseHeaders {
  'X-DRAIN-Cost': string;
  'X-DRAIN-Total': string;
  'X-DRAIN-Remaining': string;
  'X-DRAIN-Channel': string;
}

/**
 * DRAIN error response headers
 */
export interface DrainErrorHeaders {
  'X-DRAIN-Error': string;
  'X-DRAIN-Required'?: string;
  'X-DRAIN-Provided'?: string;
}
