import type { Hash, Hex } from 'viem';

export interface ModelPricing {
  inputPer1k: bigint; // flat price per request (outputPer1k always 0n)
  outputPer1k: bigint;
}

export interface ProviderConfig {
  targonApiKey: string;
  targonApiUrl: string;
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
  adminPassword?: string;
}

// --- Targon Compute API types ---

export interface TargonInventorySpec {
  gpu_type?: string;
  gpu_count?: number;
  vcpu: number;
  memory: number;
  storage?: number;
}

export interface TargonInventoryItem {
  name: string;
  display_name: string;
  description: string;
  type: string;
  gpu: boolean;
  spec: TargonInventorySpec;
  cost_per_hour: number;
  available: number;
}

export interface TargonWorkloadUrl {
  port: number;
  url: string;
}

export interface TargonWorkloadState {
  status: string;
  message: string;
  ready_replicas: number;
  total_replicas: number;
  urls: TargonWorkloadUrl[];
}

export interface TargonWorkloadResource {
  name: string;
  display_name: string;
  gpu_type?: string;
  gpu_count?: number;
  vcpu: number;
  memory: number;
}

export interface TargonWorkload {
  uid: string;
  name: string;
  image: string;
  type: string;
  resource_name: string;
  project_id?: string;
  app_id?: string;
  state: TargonWorkloadState;
  resource?: TargonWorkloadResource;
  cost_per_hour: number;
  revision?: string;
  created_at: string;
  updated_at: string;
}

export interface TargonWorkloadListResponse {
  items: TargonWorkload[];
  next_cursor: string;
}

// --- DRAIN protocol types ---

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
