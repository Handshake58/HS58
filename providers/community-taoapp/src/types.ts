/**
 * Community TaoApp Provider Types
 */

export interface Voucher {
  channelId: string;
  amount: string;
  nonce: string;
  signature: string;
}

export interface StoredVoucher {
  channelId: string;
  amount: bigint;
  nonce: bigint;
  signature: string;
  consumer: string;
  receivedAt: number;
  claimed: boolean;
  claimedAt?: number;
  claimTxHash?: string;
}

export interface ChannelState {
  channelId: string;
  consumer: string;
  deposit: bigint;
  totalCharged: bigint;
  expiry: number;
  createdAt: number;
  lastActivityAt: number;
  lastVoucher?: StoredVoucher;
}

export interface StorageData {
  vouchers: StoredVoucher[];
  channels: Record<string, ChannelState>;
  totalEarned: string;
  totalClaimed: string;
}

export interface ProviderConfig {
  taoappApiUrl: string;
  taoappApiKey: string;
  pricePerRequestUsdc: number;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: `0x${string}`;
  polygonRpcUrl?: string;
  claimThreshold: bigint;
  storagePath: string;
  providerName: string;
  autoClaimIntervalMinutes: number;
  autoClaimBufferSeconds: number;
  adminPassword?: string;
  rateLimitPerMinute: number;
}

export interface TaoAppQueryRequest {
  endpoint: string;
  params?: Record<string, string | number | boolean>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
