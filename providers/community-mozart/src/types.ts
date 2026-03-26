import type { Hash, Hex } from 'viem';

// ─── DRAIN primitives ─────────────────────────────────────────────────────────

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
  claimThreshold: bigint;
  storagePath: string;
  providerName: string;
  autoClaimIntervalMinutes: number;
  autoClaimBufferSeconds: number;
  // Upstream keys
  openrouterApiKey: string; // optional — Chutes used as primary
  desearchApiKey: string;
  chutesApiKey: string;
  e2bApiKey?: string;
  replicateApiToken?: string;
  // Mozart config
  markupMultiplier: number;
  maxPlanSteps: number;
  plannerModel: string;
  synthesizerModel: string;
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

// ─── Mozart / Orchestra primitives ───────────────────────────────────────────

export type ProviderName =
  | 'chutes'
  | 'openrouter'
  | 'desearch'
  | 'e2b'
  | 'replicate'
  | 'numinous'
  | 'vericore';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  provider: ProviderName;
  model: string;
  task: string;
  input_from?: string[];
  parallel?: boolean;
  required?: boolean;
  estimated_cost_usd: number;
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  estimated_total_cost_usd: number;
  reasoning: string;
}

export interface StepResult {
  step_id: string;
  provider: ProviderName;
  model: string;
  status: StepStatus;
  output?: string;
  error?: string;
  cost_usd: number;
  duration_ms: number;
  tokens_used?: number;
}

export interface OrchestrationResult {
  goal: string;
  plan: ExecutionPlan;
  steps: StepResult[];
  synthesis: string;
  total_cost_usd: number;
  total_duration_ms: number;
  providers_used: ProviderName[];
}

export type MozartMode = 'auto' | 'plan' | 'pipeline';

export interface MozartRequest {
  mode: MozartMode;
  goal: string;
  steps?: PlanStep[];
  context?: string;
  budget_usd?: number;
  providers?: ProviderName[];
  stream?: boolean;
}

export interface MozartStreamEvent {
  event: 'plan' | 'step_start' | 'step_done' | 'step_fail' | 'synthesis' | 'done' | 'error';
  data: any;
  timestamp: number;
}
