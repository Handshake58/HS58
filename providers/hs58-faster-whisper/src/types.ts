/**
 * HS58-Faster-Whisper Provider Types
 */

import type { Hash, Hex } from 'viem';

/**
 * Audio pricing per model (price per second of audio)
 */
export interface AudioPricing {
  /** Price per second of audio (USDC wei, 6 decimals) */
  pricePerSecond: bigint;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  whisperServerUrl: string;
  whisperApiKey: string;
  defaultModel: string;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: Hex;
  polygonRpcUrl?: string;
  pricing: Map<string, AudioPricing>;
  claimThreshold: bigint;
  storagePath: string;
  markup: number;
  marketplaceUrl: string;
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
 * Transcription result from speaches server (verbose_json format)
 */
export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
}
