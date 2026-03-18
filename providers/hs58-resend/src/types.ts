/**
 * HS58-Resend Provider Types
 */

import type { Hash, Hex } from 'viem';

export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

export interface ProviderConfig {
  resendApiKey: string;
  defaultFrom: string;
  allowedDomains: string[];
  pricePerEmail: bigint;
  maxRecipientsPerEmail: number;
  maxBodySizeBytes: number;
  rateLimitPerMinute: number;
  minEmailIntervalMs: number;
  adminPassword?: string;
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

export interface VoucherHeader {
  channelId: Hash;
  amount: string;
  nonce: string;
  signature: Hex;
}

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

export interface CostResult {
  cost: bigint;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DrainResponseHeaders {
  'X-DRAIN-Cost': string;
  'X-DRAIN-Total': string;
  'X-DRAIN-Remaining': string;
  'X-DRAIN-Channel': string;
}

export interface DrainErrorHeaders {
  'X-DRAIN-Error': string;
  'X-DRAIN-Required'?: string;
  'X-DRAIN-Provided'?: string;
}

export interface SendEmailParams {
  from?: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  tags?: Array<{ name: string; value: string }>;
}
