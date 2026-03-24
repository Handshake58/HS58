import express from 'express';
import cors from 'cors';
import { config as dotenv } from 'dotenv';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { orchestrate } from './planner.js';
import { ORCHESTRA_BASE_FEE_USDC, ORCHESTRA_PLAN_FEE_USDC, PROVIDER_COST_ESTIMATES, DRAIN_ADDRESSES } from './constants.js';
import type { ProviderConfig, OrchestraRequest, OrchestraStreamEvent } from './types.js';

dotenv();

function requireEnv(k: string): string { const v = process.env[k]; if (!v) { console.error(`[config] Missing: ${k}`); return `MISSING_${k}`; } return v; }
function optEnv(k: string, d: string): string { return process.env[k] ?? d; }

const chainId = parseInt(optEnv('CHAIN_ID', '137')) as 137 | 80002;

const config: ProviderConfig = {
  port: parseInt(optEnv('PORT', '3000')), host: optEnv('HOST', '0.0.0.0'), chainId,
  providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
  polygonRpcUrl: process.env.POLYGON_RPC_URL,
  claimThreshold: BigInt(optEnv('CLAIM_THRESHOLD', '10000000')),
  storagePath: optEnv('STORAGE_PATH', '/app/data/vouchers.json'),
  providerName: optEnv('PROVIDER_NAME', 'HS58-Orchestra'),
  autoClaimIntervalMinutes: parseInt(optEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
  autoClaimBufferSeconds: parseInt(optEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  openrouterApiKey: requireEnv('OPENROUTER_API_KEY'),
  desearchApiKey: requireEnv('DESEARCH_API_KEY'),
  chutesApiKey: requireEnv('CHUTES_API_KEY'),
  e2bApiKey: process.env.E2B_API_KEY,
  replicateApiToken: process.env.REPLICATE_API_TOKEN,
  markupMultiplier: 1 + parseInt(optEnv('MARKUP_PERCENT', '30')) / 100,
  maxPlanSteps: parseInt(optEnv('MAX_PLAN_STEPS', '6')),
  plannerModel: optEnv('PLANNER_MODEL', 'deepseek-ai/DeepSeek-R1'),
  synthesizerModel: optEnv('SYNTHESIZER_MODEL', 'deepseek-ai/DeepSeek-V3-0324'),
};

const storage      = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const app          = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

function paymentHeaders() {
  return { 'X-Payment-Protocol': 'drain-v2', 'X-Payment-Provider': drainService.getProviderAddress(), 'X-Payment-Contract': DRAIN_ADDRESSES[chainId], 'X-Payment-Chain': String(chainId), 'X-Payment-Docs': '/v1/docs' };
}

async function requirePayment(req: express.Request, res: express.Response, minCost: bigint): Promise<{ voucher: any; channel: any } | null> {
  const header = req.headers['x-drain-voucher'] as string | undefined;
  if (!header) { res.status(402).set({ ...paymentHeaders(), 'X-DRAIN-Error': 'voucher_required' }).json({ error: { message: 'X-DRAIN-Voucher header required', code: 'voucher_required' } }); return null; }
  const voucher = drainService.parseVoucherHeader(header);
  if (!voucher) { res.status(402).json({ error: { message: 'Invalid voucher format', code: 'invalid_voucher' } }); return null; }
  const validation = await drainService.validateVoucher(voucher, minCost);
  if (!validation.valid) { res.status(402).set({ 'X-DRAIN-Error': validation.error!, 'X-DRAIN-Required': minCost.toString() }).json({ error: { message: `Payment error: ${validation.error}`, code: validation.error } }); return null; }
  return { voucher, channel: validation.channel };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: drainService.getProviderAddress(), providerName: config.providerName, chainId: config.chainId, model:3, modes: ['auto', 'plan', 'pipeline'], bittensor_native: ['chutes', 'desearch', 'numinous', 'vericore'] });
});

app.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: [
    { id: 'orchestra/auto',     object: 'model', owned_by: 'hs58-orchestra', description: 'Full auto-orchestration. Send a goal, Orchestra plans and executes across providers.' },
    { id: 'orchestra/plan',     object: 'model', owned_by: 'hs58-orchestra', description: 'Dry-run planning only. Returns execution plan without running it.' },
    { id: 'orchestra/pipeline', object: 'model', owned_by: 'hs58-orchestra', description: 'User-defined pipeline with explicit steps and DAG scheduling.' },
  ]});
});

app.get('/v1/pricing', (_req, res) => {
  const markup = Math.round((config.markupMultiplier - 1) * 100);
  res.json({
    provider: drainService.getProviderAddress(), providerName: config.providerName, chainId: config.chainId, currency: 'USDC', markup: `${markup}%`,
    fees: { base_coordination: `$${formatUnits(ORCHESTRA_BASE_FEE_USDC, 6)} per orchestration`, plan_only: `$${formatUnits(ORCHESTRA_PLAN_FEE_USDC, 6)} per plan` },
    provider_cost_estimates: Object.fromEntries(Object.entries(PROVIDER_COST_ESTIMATES).map(([k, v]) => [k, `$${formatUnits(v as bigint, 6)}`])),
  });
});

app.get('/v1/docs', (_req, res) => {
  const markup = Math.round((config.markupMultiplier - 1) * 100);
  res.type('text/plain').send(`# HS58-Orchestra\n\nThe only AI orchestration layer on Handshake58.\nSend one goal. Orchestra plans it, runs it across providers in parallel, returns one synthesized answer.\n\n## Request schema\n{ "mode": "auto|plan|pipeline", "goal": "<what you want>", "context": "<optional>", "budget_usd": 0.10, "providers": [], "stream": false, "steps": [] }\n\n## Pricing\nBase fee: $${formatUnits(ORCHESTRA_BASE_FEE_USDC, 6)} | Plan fee: $${formatUnits(ORCHESTRA_PLAN_FEE_USDC, 6)} | Markup: ${markup}%\n`);
});

app.post('/v1/chat/completions', async (req, res) => {
  const model    = (req.body.model as string) ?? 'orchestra/auto';
  const messages = (req.body.messages as Array<{ role: string; content: string }>) ?? [];
  const isStream = req.body.stream === true;

  if (!['orchestra/auto', 'orchestra/plan', 'orchestra/pipeline'].includes(model))
    return res.status(400).json({ error: { message: `Unknown model: ${model}` } });

  const lastUser = messages.filter(m => m.role === 'user').pop();
  if (!lastUser?.content?.trim()) return res.status(400).json({ error: { message: 'Send OrchestraRequest JSON as user message.' } });

  let orchRequest: OrchestraRequest;
  try { orchRequest = JSON.parse(lastUser.content); }
  catch { return res.status(400).json({ error: { message: 'User message must be valid JSON. See GET /v1/docs.' } }); }

  if (model === 'orchestra/plan')     orchRequest.mode = 'plan';
  if (model === 'orchestra/pipeline') orchRequest.mode = 'pipeline';
  if (model === 'orchestra/auto')     orchRequest.mode = 'auto';
  if (!orchRequest.goal) return res.status(400).json({ error: { message: '"goal" is required.' } });

  const maxPerStep  = Math.max(...Object.values(PROVIDER_COST_ESTIMATES).map(Number));
  const preAuthCost = orchRequest.mode === 'plan'
    ? ORCHESTRA_PLAN_FEE_USDC
    : ORCHESTRA_BASE_FEE_USDC + BigInt(config.maxPlanSteps) * BigInt(maxPerStep);

  const payment = await requirePayment(req, res, preAuthCost);
  if (!payment) return;
  const { voucher, channel } = payment;

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-DRAIN-Channel', voucher.channelId);
    const sendEvent = (event: OrchestraStreamEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const result = await orchestrate(orchRequest, config, sendEvent);
      const totalCostWei = ORCHESTRA_BASE_FEE_USDC + BigInt(Math.ceil(result.total_cost_usd * 1_000_000 * config.markupMultiplier));
      drainService.storeVoucher(voucher, channel, totalCostWei);
      res.write(`data: [DONE]\n\n`); res.end();
    } catch (err: any) { sendEvent({ event: 'error', data: { message: err?.message }, timestamp: Date.now() }); res.end(); }
    return;
  }

  try {
    const result = await orchestrate(orchRequest, config);
    const totalCostWei = ORCHESTRA_BASE_FEE_USDC + BigInt(Math.ceil(result.total_cost_usd * 1_000_000 * config.markupMultiplier));
    drainService.storeVoucher(voucher, channel, totalCostWei);
    const remaining = BigInt(channel.deposit) - BigInt(channel.totalCharged) - totalCostWei;
    res.set({ 'X-DRAIN-Cost': totalCostWei.toString(), 'X-DRAIN-Total': (channel.totalCharged + totalCostWei).toString(), 'X-DRAIN-Remaining': remaining.toString(), 'X-DRAIN-Channel': voucher.channelId });
    res.json({
      id: `orchestra-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result, null, 2) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: Math.ceil(JSON.stringify(result).length / 4), total_tokens: Math.ceil(JSON.stringify(result).length / 4) },
      orchestra: { synthesis: result.synthesis, providers_used: result.providers_used, steps_completed: result.steps.filter(s => s.status === 'done').length, steps_failed: result.steps.filter(s => s.status === 'failed').length, total_duration_ms: result.total_duration_ms, total_cost_usd: result.total_cost_usd },
    });
  } catch (err: any) {
    console.error('[orchestra] Error:', err?.message);
    res.status(500).json({ error: { message: err?.message ?? 'Orchestration error', code: 'orchestra_error' } });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  try { const tx = await drainService.claimPayments(req.query.force === 'true'); res.json({ claimed: tx.length, transactions: tx }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({ provider: drainService.getProviderAddress(), providerName: config.providerName, ...stats, totalEarned: formatUnits(stats.totalEarned, 6) + ' USDC' });
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    const result = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: result.finalAmount.toString(), signature: result.signature });
  } catch (err: any) { res.status(500).json({ error: err?.message ?? 'internal_error' }); }
});

async function main() {
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);
  app.listen(config.port, config.host, () => {
    console.log(`[orchestra] Listening on ${config.host}:${config.port}`);
    console.log(`[orchestra] Provider: ${drainService.getProviderAddress()}`);
    console.log(`[orchestra] Chain: ${chainId === 137 ? 'Polygon Mainnet' : 'Polygon Amoy'}`);
  });
}

main().catch(err => { console.error('[orchestra] Fatal:', err); process.exit(1); });
