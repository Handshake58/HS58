/**
 * HS58-CronJob Provider Types
 */

import type { Hash, Hex } from 'viem';

export interface ModelPricing {
  inputPer1k: bigint;
  outputPer1k: bigint;
}

export interface ProviderConfig {
  cronjobApiKey: string;
  markupMultiplier: number;
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

// --- cron-job.org API types ---

export type RequestMethod = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface JobSchedule {
  timezone?: string;
  expiresAt?: number;
  hours?: number[];
  mdays?: number[];
  minutes?: number[];
  months?: number[];
  wdays?: number[];
}

export interface JobAuth {
  enable?: boolean;
  user?: string;
  password?: string;
}

export interface JobNotificationSettings {
  onFailure?: boolean;
  onFailureCount?: number;
  onSuccess?: boolean;
  onDisable?: boolean;
}

export interface JobExtendedData {
  headers?: Record<string, string>;
  body?: string;
}

export interface CronJob {
  jobId?: number;
  enabled?: boolean;
  title?: string;
  saveResponses?: boolean;
  url: string;
  lastStatus?: number;
  lastDuration?: number;
  lastExecution?: number;
  nextExecution?: number;
  type?: number;
  requestTimeout?: number;
  redirectSuccess?: boolean;
  folderId?: number;
  schedule?: JobSchedule;
  requestMethod?: RequestMethod;
  auth?: JobAuth;
  notification?: JobNotificationSettings;
  extendedData?: JobExtendedData;
}

export interface HistoryItem {
  jobLogId: number;
  jobId: number;
  identifier: string;
  date: number;
  datePlanned: number;
  jitter: number;
  url: string;
  duration: number;
  status: number;
  statusText: string;
  httpStatus: number;
  headers: string | null;
  body: string | null;
  stats: {
    nameLookup: number;
    connect: number;
    appConnect: number;
    preTransfer: number;
    startTransfer: number;
    total: number;
  };
}

export interface CreateJobInput {
  url: string;
  title?: string;
  enabled?: boolean;
  schedule?: JobSchedule;
  requestMethod?: RequestMethod;
  extendedData?: JobExtendedData;
  auth?: JobAuth;
  saveResponses?: boolean;
  requestTimeout?: number;
  redirectSuccess?: boolean;
}

export interface UpdateJobInput {
  jobId: number;
  url?: string;
  title?: string;
  enabled?: boolean;
  schedule?: JobSchedule;
  requestMethod?: RequestMethod;
  extendedData?: JobExtendedData;
  auth?: JobAuth;
  saveResponses?: boolean;
  requestTimeout?: number;
  redirectSuccess?: boolean;
}

export interface DeleteJobInput {
  jobId: number;
}

export interface GetJobInput {
  jobId: number;
}

export interface GetHistoryInput {
  jobId: number;
}
