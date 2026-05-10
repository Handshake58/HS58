#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SignerOptions, SubmittableExtrinsic } from '@polkadot/api/types';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringCamelCase } from '@polkadot/util';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const RAO_PER_TAO = 1_000_000_000n;
const DEFAULT_ENDPOINT = 'wss://test.finney.opentensor.ai:443';

type TradeAction = 'stake' | 'unstake' | 'full_unstake' | 'move' | 'swap' | 'recycle';

interface LocalPolicy {
  maxTaoPerTrade: number;
  maxTaoPerDay: number;
  maxTradesPerDay: number;
  maxOpenExposureTao: number;
  maxSlippagePct: number;
  minSecondsBetweenTrades: number;
  requireConfirm: boolean;
  allowUnprotected: boolean;
  allowRecycleAlpha: boolean;
  allowedProviders: string[];
  allowedActions: TradeAction[];
  allowedNetuids: number[];
}

interface ActiveIntent {
  intentId: string;
  providerId: string;
  strategyId: string | null;
  action: TradeAction;
  netuid: number;
  fromNetuid: number | null;
  amountTao: number | null;
  amountAlphaRao: string | null;
  reason: string | null;
  status: 'submitted' | 'failed';
  txHash: string | null;
  blockHash: string | null;
  createdAt: string;
  expiresAt: string;
}

interface RecentDecision {
  intentId: string;
  decision: 'submitted' | 'blocked' | 'failed';
  reason: string;
  createdAt: string;
}

interface TradeState {
  date: string;
  taoUsedToday: number;
  tradesToday: number;
  lastTradeAt: string | null;
  lastIntentId: string | null;
  lastDryRunIntentId: string | null;
  lastDryRunAt: string | null;
  activeIntents: ActiveIntent[];
  recentDecisions: RecentDecision[];
}

interface TradeIntent {
  schemaVersion: 'axelot.trade-intent.v1';
  intentId: string;
  providerId: string;
  chain: string;
  subtensorEndpointHint?: string;
  createdAt: string;
  expiresAt: string;
  coldkey?: string | null;
  action: TradeAction;
  netuid: number;
  fromNetuid?: number | null;
  amountTao?: number | null;
  amountAlphaRao?: string | null;
  delegateHotkey?: string | null;
  fromDelegateHotkey?: string | null;
  maxSlippagePct: number;
  allowPartial?: boolean;
  preferredExtrinsic?: string;
  riskPolicyHash?: string | null;
  reason?: string;
  evidence?: Record<string, unknown>;
}

interface StakePosition {
  netuid: number;
  delegateHotkey: string;
  alphaRao: string;
  alpha: number;
  taoValue: number;
  spotPrice: number;
}

const TradeIntentSchema = z.object({
  schemaVersion: z.literal('axelot.trade-intent.v1'),
  intentId: z.string().min(1),
  providerId: z.string().min(1),
  chain: z.string().min(1),
  subtensorEndpointHint: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  coldkey: z.string().nullable().optional(),
  action: z.enum(['stake', 'unstake', 'full_unstake', 'move', 'swap', 'recycle']),
  netuid: z.number().int().min(0),
  fromNetuid: z.number().int().min(0).nullable().optional(),
  amountTao: z.number().positive().nullable().optional(),
  amountAlphaRao: z.string().nullable().optional(),
  delegateHotkey: z.string().nullable().optional(),
  fromDelegateHotkey: z.string().nullable().optional(),
  maxSlippagePct: z.number().positive(),
  allowPartial: z.boolean().optional(),
  preferredExtrinsic: z.string().optional(),
  riskPolicyHash: z.string().nullable().optional(),
  reason: z.string().optional(),
  evidence: z.record(z.unknown()).optional(),
});

const server = new McpServer({ name: 'axelot-tao-signer', version: '0.1.0' });

let api: ApiPromise | null = null;
let provider: WsProvider | null = null;
let coldkeyPair: KeyringPair | null = null;

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, bigintReplacer, 2) }] };
}

function err(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function taoToRao(tao: number): bigint {
  if (!Number.isFinite(tao) || tao < 0) throw new Error('Invalid TAO amount');
  return BigInt(Math.round(tao * 1e9));
}

function raoToTao(rao: bigint): number {
  return Number(rao) / 1e9;
}

function csv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

function loadPolicy(): LocalPolicy {
  return {
    maxTaoPerTrade: Number(process.env.MAX_TAO_PER_TRADE ?? 0.25),
    maxTaoPerDay: Number(process.env.MAX_TAO_PER_DAY ?? 1),
    maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY ?? 25),
    maxOpenExposureTao: Number(process.env.MAX_OPEN_EXPOSURE_TAO ?? 2),
    maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT ?? 1.5),
    minSecondsBetweenTrades: Number(process.env.MIN_SECONDS_BETWEEN_TRADES ?? 0),
    requireConfirm: process.env.REQUIRE_CONFIRM !== 'false',
    allowUnprotected: process.env.ALLOW_UNPROTECTED === 'true' || process.env.ALLOW_RESTORE_UNPROTECTED === 'true',
    allowRecycleAlpha: process.env.ALLOW_RECYCLE_ALPHA === 'true',
    allowedProviders: csv('ALLOWED_PROVIDERS', 'community-axelot'),
    allowedActions: csv('ALLOWED_ACTIONS', 'stake,unstake,full_unstake,move,swap,recycle') as TradeAction[],
    allowedNetuids: csv('ALLOWED_NETUIDS', '').map(Number).filter((n) => Number.isInteger(n) && n >= 0),
  };
}

function policyHash(policy = loadPolicy()): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(policy)).digest('hex')}`;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function tradeStatePath(): string {
  return process.env.TRADE_STATE_PATH ?? './data/trade-state.json';
}

function emptyTradeState(): TradeState {
  return {
    date: todayKey(),
    taoUsedToday: 0,
    tradesToday: 0,
    lastTradeAt: null,
    lastIntentId: null,
    lastDryRunIntentId: null,
    lastDryRunAt: null,
    activeIntents: [],
    recentDecisions: [],
  };
}

function normalizeTradeState(state: TradeState): TradeState {
  const today = todayKey();
  const activeMax = Number(process.env.TRADE_STATE_ACTIVE_LIMIT ?? 20);
  const recentMax = Number(process.env.TRADE_STATE_RECENT_LIMIT ?? 30);
  return {
    ...state,
    date: today,
    taoUsedToday: state.date === today ? Number(state.taoUsedToday) || 0 : 0,
    tradesToday: state.date === today ? Number(state.tradesToday) || 0 : 0,
    activeIntents: (state.activeIntents ?? []).slice(-activeMax),
    recentDecisions: (state.recentDecisions ?? []).slice(-recentMax),
  };
}

function readTradeState(): TradeState {
  const path = tradeStatePath();
  if (!existsSync(path)) return emptyTradeState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TradeState;
    return normalizeTradeState({ ...emptyTradeState(), ...parsed });
  } catch {
    return emptyTradeState();
  }
}

function writeTradeState(state: TradeState): void {
  const path = tradeStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalizeTradeState(state), null, 2));
}

function rememberDecision(state: TradeState, decision: RecentDecision): TradeState {
  return normalizeTradeState({
    ...state,
    recentDecisions: [...state.recentDecisions, decision],
  });
}

function extractStrategyId(intent: TradeIntent): string | null {
  const evidence = intent.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  const strategy = (evidence as Record<string, unknown>).strategy;
  if (!strategy || typeof strategy !== 'object' || Array.isArray(strategy)) return null;
  const strategyId = (strategy as Record<string, unknown>).strategyId;
  return typeof strategyId === 'string' && strategyId.trim() ? strategyId.trim() : null;
}

function recordExecution(intent: TradeIntent, result: { success: boolean; txHash?: string; blockHash?: string; error?: string }): TradeState {
  const state = readTradeState();
  const now = new Date().toISOString();
  const amountTao = intent.amountTao ?? 0;
  const decision: RecentDecision = {
    intentId: intent.intentId,
    decision: result.success ? 'submitted' : 'failed',
    reason: result.success ? (intent.reason ?? 'submitted') : (result.error ?? 'submission failed'),
    createdAt: now,
  };
  const next = rememberDecision({
    ...state,
    taoUsedToday: result.success ? state.taoUsedToday + amountTao : state.taoUsedToday,
    tradesToday: result.success ? state.tradesToday + 1 : state.tradesToday,
    lastTradeAt: result.success ? now : state.lastTradeAt,
    lastIntentId: result.success ? intent.intentId : state.lastIntentId,
    activeIntents: result.success
      ? [
          ...state.activeIntents.filter((item) => item.intentId !== intent.intentId),
          {
            intentId: intent.intentId,
            providerId: intent.providerId,
            strategyId: extractStrategyId(intent),
            action: intent.action,
            netuid: intent.netuid,
            fromNetuid: intent.fromNetuid ?? null,
            amountTao: intent.amountTao ?? null,
            amountAlphaRao: intent.amountAlphaRao ?? null,
            reason: intent.reason ?? null,
            status: 'submitted',
            txHash: result.txHash ?? null,
            blockHash: result.blockHash ?? null,
            createdAt: now,
            expiresAt: intent.expiresAt,
          },
        ]
      : state.activeIntents.filter((item) => item.intentId !== intent.intentId),
  }, decision);
  writeTradeState(next);
  return next;
}

function recordBlocked(intent: TradeIntent, reason: string): TradeState {
  const next = rememberDecision(readTradeState(), {
    intentId: intent.intentId,
    decision: 'blocked',
    reason,
    createdAt: new Date().toISOString(),
  });
  writeTradeState(next);
  return next;
}

function recordDryRun(intent: TradeIntent): TradeState {
  const next = normalizeTradeState({
    ...readTradeState(),
    lastDryRunIntentId: intent.intentId,
    lastDryRunAt: new Date().toISOString(),
  });
  writeTradeState(next);
  return next;
}

async function getApi(): Promise<ApiPromise> {
  if (api?.isConnected) return api;
  const endpoint = process.env.SUBTENSOR_ENDPOINT ?? DEFAULT_ENDPOINT;
  provider = new WsProvider(endpoint);
  api = await ApiPromise.create({ provider });
  return api;
}

async function getColdkey(): Promise<KeyringPair> {
  if (coldkeyPair) return coldkeyPair;
  const mnemonic = process.env.TAO_COLDKEY_MNEMONIC;
  if (!mnemonic) throw new Error('TAO_COLDKEY_MNEMONIC is not configured');
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  coldkeyPair = keyring.addFromMnemonic(mnemonic);
  return coldkeyPair;
}

async function getFreeBalance(address: string): Promise<bigint> {
  const chain = await getApi();
  const accountInfo = await chain.query.system.account(address);
  const data = (accountInfo as unknown as { data: { free: { toString: () => string } } }).data;
  return BigInt(data.free.toString());
}

async function getPoolData(netuid: number) {
  const chain = await getApi();
  const mod = chain.query[stringCamelCase('SubtensorModule')];
  const [taoRaw, alphaInRaw, alphaOutRaw, movingRaw] = await Promise.all([
    mod[stringCamelCase('SubnetTAO')](netuid),
    mod[stringCamelCase('SubnetAlphaIn')](netuid),
    mod[stringCamelCase('SubnetAlphaOut')](netuid),
    mod[stringCamelCase('SubnetMovingPrice')](netuid).catch(() => null),
  ]);
  const taoReserveRao = BigInt((taoRaw as { toString: () => string }).toString());
  const alphaInRao = BigInt((alphaInRaw as { toString: () => string }).toString());
  const alphaOutRao = BigInt((alphaOutRaw as { toString: () => string }).toString());
  const spotPrice = alphaInRao > 0n ? Number((taoReserveRao * RAO_PER_TAO) / alphaInRao) / 1e9 : 0;
  const movingString = movingRaw ? (movingRaw as { toString: () => string }).toString() : '';
  return {
    netuid,
    taoReserveRao,
    alphaInRao,
    alphaOutRao,
    taoReserveTao: raoToTao(taoReserveRao),
    alphaIn: raoToTao(alphaInRao),
    alphaOut: raoToTao(alphaOutRao),
    spotPrice,
    movingPrice: movingString ? Number(movingString) / 1e18 : spotPrice,
  };
}

async function getStakesForColdkey(coldkey: string): Promise<StakePosition[]> {
  const chain = await getApi();
  const callRoot = (chain as unknown as { call?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> }).call;
  const runtimeApi = callRoot?.stakeInfoRuntimeApi;
  if (!runtimeApi || typeof runtimeApi.getStakeInfoForColdkey !== 'function') return [];
  const raw = await runtimeApi.getStakeInfoForColdkey(coldkey);
  const json = (raw as { toJSON?: () => unknown }).toJSON?.() ?? raw;
  if (!Array.isArray(json)) return [];

  const out: StakePosition[] = [];
  for (const item of json as Array<Record<string, unknown>>) {
    const netuid = Number(item.netuid);
    const delegateHotkey = String(item.hotkey ?? '');
    if (!Number.isInteger(netuid) || !delegateHotkey || item.stake == null) continue;
    let alphaRao = 0n;
    try {
      alphaRao = BigInt(typeof item.stake === 'object' ? (item.stake as { toString: () => string }).toString() : String(item.stake));
    } catch {
      alphaRao = 0n;
    }
    if (alphaRao <= 0n) continue;
    const pool = await getPoolData(netuid);
    out.push({
      netuid,
      delegateHotkey,
      alphaRao: alphaRao.toString(),
      alpha: raoToTao(alphaRao),
      taoValue: raoToTao(alphaRao) * pool.spotPrice,
      spotPrice: pool.spotPrice,
    });
  }
  return out.sort((a, b) => b.taoValue - a.taoValue);
}

function alphaRaoForTaoExit(amountTao: number, pool: Awaited<ReturnType<typeof getPoolData>>, fullBalance?: bigint): bigint {
  const dTaoRao = taoToRao(amountTao);
  if (pool.taoReserveRao > 0n && pool.alphaInRao > 0n && dTaoRao < pool.taoReserveRao) {
    const desired = (pool.alphaInRao * dTaoRao) / (pool.taoReserveRao - dTaoRao);
    return fullBalance && desired >= fullBalance ? (fullBalance * 995n) / 1000n : desired;
  }
  return fullBalance ? (fullBalance * 995n) / 1000n : 0n;
}

function computeLimitPrice(pool: Awaited<ReturnType<typeof getPoolData>>, action: TradeAction, maxSlippagePct: number): bigint {
  if (!(pool.spotPrice > 0)) return 0n;
  const multiplier = action === 'stake' ? 1 + maxSlippagePct / 100 : 1 - maxSlippagePct / 100;
  return taoToRao(Math.max(0, pool.spotPrice * multiplier));
}

async function verifyIntent(intentInput: unknown) {
  const intent = TradeIntentSchema.parse(intentInput) as TradeIntent;
  const policy = loadPolicy();
  const state = readTradeState();
  const coldkey = await getColdkey();
  const warnings: string[] = [];
  const errors: string[] = [];
  const amountTao = intent.amountTao ?? 0;

  if (intent.coldkey && intent.coldkey !== coldkey.address) errors.push('intent coldkey does not match local signer coldkey');
  if (Date.parse(intent.expiresAt) <= Date.now()) errors.push('intent expired');
  if (!policy.allowedProviders.includes(intent.providerId)) errors.push(`provider ${intent.providerId} not allowed`);
  if (!policy.allowedActions.includes(intent.action)) errors.push(`action ${intent.action} not allowed`);
  if (policy.allowedNetuids.length > 0 && !policy.allowedNetuids.includes(intent.netuid)) errors.push(`netuid ${intent.netuid} not allowed`);
  if (amountTao > policy.maxTaoPerTrade) errors.push(`amountTao exceeds maxTaoPerTrade ${policy.maxTaoPerTrade}`);
  if (state.taoUsedToday + amountTao > policy.maxTaoPerDay) errors.push(`daily TAO budget exceeded: ${state.taoUsedToday + amountTao} > ${policy.maxTaoPerDay}`);
  if (state.tradesToday >= policy.maxTradesPerDay) errors.push(`daily trade count exceeded: ${state.tradesToday} >= ${policy.maxTradesPerDay}`);
  if (state.lastIntentId === intent.intentId) errors.push('duplicate intentId already executed by this signer');
  if (policy.minSecondsBetweenTrades > 0 && state.lastTradeAt) {
    const elapsedSeconds = (Date.now() - Date.parse(state.lastTradeAt)) / 1000;
    if (elapsedSeconds < policy.minSecondsBetweenTrades) errors.push(`cooldown active: wait ${Math.ceil(policy.minSecondsBetweenTrades - elapsedSeconds)}s`);
  }
  const localPolicyHash = policyHash(policy);
  if (intent.riskPolicyHash && intent.riskPolicyHash !== localPolicyHash) errors.push('intent riskPolicyHash does not match local signer policy hash');
  if (intent.maxSlippagePct > policy.maxSlippagePct) errors.push(`maxSlippagePct exceeds policy max ${policy.maxSlippagePct}`);
  if (intent.action === 'recycle' && !policy.allowRecycleAlpha) errors.push('recycle_alpha is disabled by local policy');

  const positions = await getStakesForColdkey(coldkey.address);
  const pool = await getPoolData(intent.action === 'move' || intent.action === 'swap' ? (intent.fromNetuid ?? intent.netuid) : intent.netuid);
  const position = positions.find((p) => p.netuid === (intent.fromNetuid ?? intent.netuid));
  const callPreview = buildCallPreview(intent, pool, position);
  if (callPreview.limitPrice === '0' && ['add_stake_limit', 'remove_stake_limit', 'remove_stake_full_limit', 'swap_stake_limit'].includes(callPreview.callName) && !policy.allowUnprotected) {
    errors.push('limit_price=0 rejected by policy');
  }
  if (['unstake', 'full_unstake', 'move', 'swap', 'recycle'].includes(intent.action) && !position) {
    errors.push('no matching local stake position found for exit/move/swap/recycle');
  }
  if (intent.action === 'move' && intent.fromNetuid == null) errors.push('fromNetuid required for move');
  if (!intent.delegateHotkey && intent.action === 'stake') warnings.push('delegateHotkey missing; signer cannot pick validator in MVP');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    policy,
    policyHash: localPolicyHash,
    tradeState: state,
    remainingTaoToday: Math.max(0, policy.maxTaoPerDay - state.taoUsedToday),
    remainingTradesToday: Math.max(0, policy.maxTradesPerDay - state.tradesToday),
    coldkey: coldkey.address,
    chain: process.env.BITTENSOR_CHAIN ?? 'bittensor-testnet',
    endpoint: process.env.SUBTENSOR_ENDPOINT ?? DEFAULT_ENDPOINT,
    callPreview,
  };
}

function buildCallPreview(intent: TradeIntent, pool: Awaited<ReturnType<typeof getPoolData>>, position?: StakePosition) {
  const maxSlippagePct = intent.maxSlippagePct;
  const limitPrice = computeLimitPrice(pool, intent.action, maxSlippagePct);
  const amountAlphaRao =
    intent.amountAlphaRao ? BigInt(intent.amountAlphaRao)
    : intent.amountTao ? alphaRaoForTaoExit(intent.amountTao, pool, position?.alphaRao ? BigInt(position.alphaRao) : undefined)
    : 0n;
  const amountStakeRao = intent.amountTao ? taoToRao(intent.amountTao) : 0n;
  const hotkey = intent.delegateHotkey ?? position?.delegateHotkey ?? '';
  const fromHotkey = intent.fromDelegateHotkey ?? position?.delegateHotkey ?? hotkey;

  if (intent.action === 'stake') {
    return { callName: 'add_stake_limit', args: [hotkey, intent.netuid, amountStakeRao.toString(), limitPrice.toString(), Boolean(intent.allowPartial)], limitPrice: limitPrice.toString(), amountUnit: 'TAO-rao' };
  }
  if (intent.action === 'unstake') {
    return { callName: 'remove_stake_limit', args: [hotkey, intent.netuid, amountAlphaRao.toString(), limitPrice.toString(), Boolean(intent.allowPartial)], limitPrice: limitPrice.toString(), amountUnit: 'ALPHA-rao' };
  }
  if (intent.action === 'full_unstake') {
    return { callName: 'remove_stake_full_limit', args: [hotkey, intent.netuid, limitPrice.toString()], limitPrice: limitPrice.toString(), amountUnit: 'all ALPHA' };
  }
  if (intent.action === 'move' && fromHotkey !== hotkey) {
    return { callName: 'move_stake', args: [fromHotkey, hotkey, intent.fromNetuid, intent.netuid, amountAlphaRao.toString()], limitPrice: 'n/a', amountUnit: 'ALPHA-rao' };
  }
  if (intent.action === 'move' || intent.action === 'swap') {
    return { callName: 'swap_stake_limit', args: [fromHotkey, intent.fromNetuid ?? intent.netuid, intent.netuid, amountAlphaRao.toString(), limitPrice.toString(), Boolean(intent.allowPartial)], limitPrice: limitPrice.toString(), amountUnit: 'ALPHA-rao' };
  }
  return { callName: 'recycle_alpha', args: [hotkey, amountAlphaRao.toString(), intent.netuid], limitPrice: 'n/a', amountUnit: 'ALPHA-rao' };
}

async function buildExtrinsic(intentInput: unknown): Promise<{ tx: SubmittableExtrinsic<'promise'>; preview: Awaited<ReturnType<typeof verifyIntent>>['callPreview']; verification: Awaited<ReturnType<typeof verifyIntent>> }> {
  const intent = TradeIntentSchema.parse(intentInput) as TradeIntent;
  const verification = await verifyIntent(intent);
  if (!verification.valid) throw new Error(`intent rejected: ${verification.errors.join('; ')}`);
  const chain = await getApi();
  const mod = chain.tx[stringCamelCase('SubtensorModule')];
  const preview = verification.callPreview;
  const [a0, a1, a2, a3, a4] = preview.args;
  let tx: SubmittableExtrinsic<'promise'>;

  if (preview.callName === 'add_stake_limit') tx = mod[stringCamelCase('add_stake_limit')](a0, a1, BigInt(String(a2)), BigInt(String(a3)), a4);
  else if (preview.callName === 'remove_stake_limit') tx = mod[stringCamelCase('remove_stake_limit')](a0, a1, BigInt(String(a2)), BigInt(String(a3)), a4);
  else if (preview.callName === 'remove_stake_full_limit') tx = mod[stringCamelCase('remove_stake_full_limit')](a0, a1, BigInt(String(a2)));
  else if (preview.callName === 'move_stake') tx = mod[stringCamelCase('move_stake')](a0, a1, a2, a3, BigInt(String(a4)));
  else if (preview.callName === 'swap_stake_limit') tx = mod[stringCamelCase('swap_stake_limit')](a0, a1, a2, BigInt(String(a3)), BigInt(String(a4)), preview.args[5]);
  else if (preview.callName === 'recycle_alpha') tx = mod[stringCamelCase('recycle_alpha')](a0, BigInt(String(a1)), a2);
  else throw new Error(`unsupported call: ${preview.callName}`);

  return { tx, preview, verification };
}

async function signAndSendWithRetry(
  txFactory: () => Promise<SubmittableExtrinsic<'promise'>>,
  signer: KeyringPair,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tx = await txFactory();
    const chain = await getApi();
    const nonce = await chain.rpc.system.accountNextIndex(signer.address);
    const result = await signAndSend(tx, signer, { nonce: nonce.toNumber() });
    if (result.success) return result;
    const isBadSignature = /1010|bad signature/i.test(result.error ?? '');
    if (!isBadSignature || attempt === 1) return result;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { success: false, error: 'unreachable retry state' };
}

async function signAndSend(
  tx: SubmittableExtrinsic<'promise'>,
  signer: KeyringPair,
  options: Partial<SignerOptions> = {},
) {
  return new Promise<{ success: boolean; txHash?: string; blockHash?: string; error?: string }>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ success: false, error: 'Transaction timed out after 240s' });
      }
    }, 240_000);

    tx.signAndSend(signer, options, ({ status, dispatchError, txHash }) => {
      if (done) return;
      if (status.isInBlock || status.isFinalized) {
        clearTimeout(timeout);
        done = true;
        if (dispatchError) {
          let error = dispatchError.toString();
          if (dispatchError.isModule) {
            try {
              const decoded = tx.registry.findMetaError(dispatchError.asModule);
              error = `${decoded.section}.${decoded.method}: ${decoded.docs.join(' ')}`;
            } catch {
              error = dispatchError.toString();
            }
          }
          resolve({ success: false, txHash: txHash.toHex(), error });
        } else {
          const blockHash = status.isInBlock ? status.asInBlock.toHex() : status.asFinalized.toHex();
          resolve({ success: true, txHash: txHash.toHex(), blockHash });
        }
      }
    }).catch((error) => {
      if (!done) {
        clearTimeout(timeout);
        done = true;
        resolve({ success: false, error: String(error) });
      }
    });
  });
}

async function submitSignedExtrinsic(signedExtrinsic: string) {
  if (!/^0x[a-fA-F0-9]+$/.test(signedExtrinsic)) throw new Error('signedExtrinsic must be hex');
  const chain = await getApi();
  const tx = chain.tx(signedExtrinsic);
  return new Promise<{ success: boolean; txHash?: string; blockHash?: string; error?: string }>((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ success: false, error: 'Transaction timed out after 240s' });
      }
    }, 240_000);

    tx.send(({ status, dispatchError, txHash }) => {
      if (done) return;
      if (status.isInBlock || status.isFinalized) {
        clearTimeout(timeout);
        done = true;
        if (dispatchError) {
          let error = dispatchError.toString();
          if (dispatchError.isModule) {
            try {
              const decoded = tx.registry.findMetaError(dispatchError.asModule);
              error = `${decoded.section}.${decoded.method}: ${decoded.docs.join(' ')}`;
            } catch {
              error = dispatchError.toString();
            }
          }
          resolve({ success: false, txHash: txHash.toHex(), error });
        } else {
          const blockHash = status.isInBlock ? status.asInBlock.toHex() : status.asFinalized.toHex();
          resolve({ success: true, txHash: txHash.toHex(), blockHash });
        }
      }
    }).catch((error) => {
      if (!done) {
        clearTimeout(timeout);
        done = true;
        resolve({ success: false, error: String(error) });
      }
    });
  });
}

server.tool('tao_wallet_status', 'Show local TAO signer wallet, endpoint, balance, nonce, and policy hash.', {}, async () => {
  try {
    const chain = await getApi();
    const coldkey = await getColdkey();
    const [free, nonce] = await Promise.all([getFreeBalance(coldkey.address), chain.rpc.system.accountNextIndex(coldkey.address)]);
    return ok({
      address: coldkey.address,
      chain: process.env.BITTENSOR_CHAIN ?? 'bittensor-testnet',
      endpoint: process.env.SUBTENSOR_ENDPOINT ?? DEFAULT_ENDPOINT,
      freeTao: raoToTao(free),
      freeRao: free.toString(),
      nonce: nonce.toString(),
      policyHash: policyHash(),
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_generate_wallet', 'Generate a new local sr25519 TAO coldkey mnemonic and address for users who do not have a wallet yet.', {}, async () => {
  try {
    await cryptoWaitReady();
    const mnemonic = mnemonicGenerate(12);
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
    const pair = keyring.addFromMnemonic(mnemonic);
    return ok({
      address: pair.address,
      mnemonic,
      env: {
        TAO_COLDKEY_MNEMONIC: mnemonic,
        SUBTENSOR_ENDPOINT: process.env.SUBTENSOR_ENDPOINT ?? DEFAULT_ENDPOINT,
        BITTENSOR_CHAIN: process.env.BITTENSOR_CHAIN ?? 'bittensor-testnet',
      },
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_portfolio_snapshot', 'Read local coldkey stake positions via Bittensor runtime API.', {}, async () => {
  try {
    const coldkey = await getColdkey();
    const [free, positions] = await Promise.all([getFreeBalance(coldkey.address), getStakesForColdkey(coldkey.address)]);
    return ok({
      coldkey: coldkey.address,
      freeTao: raoToTao(free),
      totalStakedTao: positions.reduce((sum, p) => sum + p.taoValue, 0),
      positions,
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_policy_get', 'Return local signer policy and policy hash.', {}, async () => ok({ policy: loadPolicy(), policyHash: policyHash() }));

server.tool('tao_trade_state', 'Return bounded local trade state for autonomous agents: active intents, recent decisions, and daily budget usage.', {}, async () => {
  const policy = loadPolicy();
  const state = readTradeState();
  return ok({
    state,
    policyHash: policyHash(policy),
    autonomy: policy.requireConfirm ? 'manual_confirm' : 'guarded_autopilot',
    remainingTaoToday: Math.max(0, policy.maxTaoPerDay - state.taoUsedToday),
    remainingTradesToday: Math.max(0, policy.maxTradesPerDay - state.tradesToday),
  });
});

server.tool('tao_verify_intent', 'Verify an Axelot trade intent against local wallet state and policy.', {
  intent: z.unknown(),
}, async ({ intent }) => {
  try {
    return ok(await verifyIntent(intent));
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_dry_run_intent', 'Dry-run a trade intent and show the exact reconstructed Subtensor call without signing.', {
  intent: z.unknown(),
}, async ({ intent }) => {
  try {
    const parsed = TradeIntentSchema.parse(intent) as TradeIntent;
    const verification = await verifyIntent(parsed);
    const tradeState = verification.valid ? recordDryRun(parsed) : readTradeState();
    return ok({ ...verification, dryRun: true, willSign: false, tradeState });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_sign_trade_intent', 'Sign a verified intent locally and return signed extrinsic hex without submitting.', {
  intent: z.unknown(),
  confirm: z.boolean().default(false),
  confirmRecycle: z.boolean().default(false),
}, async ({ intent, confirm, confirmRecycle }) => {
  try {
    const parsed = TradeIntentSchema.parse(intent) as TradeIntent;
    const policy = loadPolicy();
    if (policy.requireConfirm && !confirm) return err('confirm:true required by local policy');
    if (parsed.action === 'recycle' && !confirmRecycle) return err('confirmRecycle:true required for recycle_alpha');
    const { tx, preview, verification } = await buildExtrinsic(parsed);
    const coldkey = await getColdkey();
    const chain = await getApi();
    const nonce = await chain.rpc.system.accountNextIndex(coldkey.address);
    await tx.signAsync(coldkey, { nonce: nonce.toNumber() });
    return ok({ signedExtrinsic: tx.toHex(), callPreview: preview, verification });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_execute_intent', 'Verify, sign, and submit a trade intent locally to Subtensor.', {
  intent: z.unknown(),
  confirm: z.boolean().default(false),
  confirmRecycle: z.boolean().default(false),
}, async ({ intent, confirm, confirmRecycle }) => {
  let parsed: TradeIntent | null = null;
  try {
    parsed = TradeIntentSchema.parse(intent) as TradeIntent;
    const policy = loadPolicy();
    if (policy.requireConfirm && !confirm) {
      recordBlocked(parsed, 'confirm:true required by local policy');
      return err('confirm:true required by local policy');
    }
    if (!policy.requireConfirm) {
      const state = readTradeState();
      if (state.lastDryRunIntentId !== parsed.intentId) {
        recordBlocked(parsed, 'guarded_autopilot requires a matching tao_dry_run_intent first');
        return err('guarded_autopilot requires a matching tao_dry_run_intent first');
      }
    }
    if (parsed.action === 'recycle' && !confirmRecycle) {
      recordBlocked(parsed, 'confirmRecycle:true required for recycle_alpha');
      return err('confirmRecycle:true required for recycle_alpha');
    }
    let preview: unknown = null;
    let verification: unknown = null;
    const coldkey = await getColdkey();
    const result = await signAndSendWithRetry(async () => {
      const built = await buildExtrinsic(parsed);
      preview = built.preview;
      verification = built.verification;
      return built.tx;
    }, coldkey);
    const tradeState = recordExecution(parsed, result);
    return ok({ ...result, callPreview: preview, verification, tradeState });
  } catch (error) {
    if (parsed) recordBlocked(parsed, error instanceof Error ? error.message : String(error));
    return err(error instanceof Error ? error.message : String(error));
  }
});

server.tool('tao_submit_signed_extrinsic', 'Submit a locally signed Subtensor extrinsic hex without sending it to the provider.', {
  signedExtrinsic: z.string().regex(/^0x[a-fA-F0-9]+$/),
}, async ({ signedExtrinsic }) => {
  try {
    return ok(await submitSignedExtrinsic(signedExtrinsic));
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`axelot-tao-signer ready (${process.env.BITTENSOR_CHAIN ?? 'bittensor-testnet'} ${process.env.SUBTENSOR_ENDPOINT ?? DEFAULT_ENDPOINT})`);

