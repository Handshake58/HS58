import type { Hash, Hex } from 'viem';

export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

export interface ProviderConfig {
  readRateLimitPerMinute: number;
  planRateLimitPerMinute: number;
  adminPassword?: string;
  port: number;
  host: string;
  chainId: 137 | 80002;
  providerPrivateKey: Hex;
  polygonRpcUrl?: string;
  pricing: Map<string, ModelPricing>;
  claimThreshold: bigint;
  storagePath: string;
  providerName: string;
  autoClaimIntervalMinutes: number;
  autoClaimBufferSeconds: number;
  subtensorEndpoint: string;
  bittensorChain: string;
  marketCacheTtlMs: number;
  maxSubnetScan: number;
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

export interface SubnetSummary {
  netuid: number;
  taoReserve: number;
  alphaIn: number;
  alphaOut: number;
  spotPrice: number;
  movingPrice: number;
  emissionPerBlock: number;
  emissionPct: number;
  liquidityScore: number;
  trendVsMovingPct: number | null;
  tempo: number;
  ownerHotkey: string | null;
  blockNumber: number;
}

export interface StakePosition {
  netuid: number;
  delegateHotkey: string;
  alphaRao: string;
  alpha: number;
  taoValue: number;
  spotPrice: number;
}

export type TradeAction = 'stake' | 'unstake' | 'full_unstake' | 'move' | 'swap' | 'recycle';

export interface TradeIntent {
  schemaVersion: 'axelot.trade-intent.v1';
  intentId: string;
  providerId: 'community-axelot';
  providerAddress: string;
  chain: string;
  subtensorEndpointHint: string;
  createdAt: string;
  expiresAt: string;
  coldkey: string | null;
  action: TradeAction;
  netuid: number;
  fromNetuid: number | null;
  amountTao: number | null;
  amountAlphaRao: string | null;
  delegateHotkey: string | null;
  fromDelegateHotkey: string | null;
  maxSlippagePct: number;
  allowPartial: boolean;
  preferredExtrinsic: string;
  riskPolicyHash: string | null;
  reason: string;
  evidence: Record<string, unknown>;
}
