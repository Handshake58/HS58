/**
 * Community TPN Provider Types
 */

import type { Hash, Hex } from 'viem';

// --- DRAIN standard types ---

export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

export interface ProviderConfig {
  tpnApiUrl: string;
  tpnApiKey: string;
  pricePerHourUsdc: number;
  minPriceUsdc: number;
  maxLeaseMinutes: number;
  defaultLeaseMinutes: number;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: Hex;
  polygonRpcUrl?: string;
  claimThreshold: bigint;
  storagePath: string;
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

// --- TPN API types ---

export interface LeaseParams {
  minutes?: number;
  country?: string;
  residential?: boolean;
}

export interface TpnApiRequest {
  minutes: number;
  country?: string;
  type: 'wireguard' | 'socks5';
  residential: string;
}

export interface TpnApiResponse {
  success: boolean;
  vpnConfig: string;
  minutes: number;
  expiresAt: string;
  creditsUsed: number;
  usedFallback: boolean;
  type: string;
  connection_type: string;
}

export type TpnLeaseType = 'wireguard' | 'socks5';
