/**
 * HS58-Custom Provider Types
 */

import type { Hash, Hex } from 'viem';

/**
 * Supported models and their pricing
 */
export interface ModelPricing {
  /** Price per 1000 input tokens (USDC wei, 6 decimals) */
  inputPer1k: bigint;
  /** Price per 1000 output tokens (USDC wei, 6 decimals) */
  outputPer1k: bigint;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiBaseUrl: string;
  apiKey: string;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: Hex;
  polygonRpcUrl?: string;
  pricing: Map<string, ModelPricing>;
  claimThreshold: bigint;
  storagePath: string;
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
