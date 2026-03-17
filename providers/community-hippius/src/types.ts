import type { Hash, Hex } from 'viem';

export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

export interface ProviderConfig {
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
  rateLimitPerMinute: number;
  adminPassword?: string;
  maxFileSizeBytes: number;

  hippius: HippiusConfig;
  pricePerMbUpload: bigint;
  pricePerMbDownload: bigint;
  pricePerList: bigint;
  pricePerCreateBucket: bigint;
  pricePerDelete: bigint;
  pricePerMbIpfsPin: bigint;
}

export interface HippiusConfig {
  accessKey: string;
  secretKey: string;
  endpoint: string;
  region: string;
  ipfsBucket: string;
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

export type HippiusOperation =
  | 'hippius/upload'
  | 'hippius/download'
  | 'hippius/list'
  | 'hippius/create-bucket'
  | 'hippius/delete'
  | 'hippius/ipfs-pin';

export interface UploadInput {
  bucket: string;
  key: string;
  content: string;
  contentType?: string;
}

export interface DownloadInput {
  bucket: string;
  key: string;
}

export interface ListInput {
  bucket: string;
  prefix?: string;
}

export interface CreateBucketInput {
  bucket: string;
}

export interface DeleteInput {
  bucket: string;
  key: string;
}

export interface IpfsPinInput {
  content: string;
  filename: string;
  contentType?: string;
}
