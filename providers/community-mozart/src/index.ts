/**
 * Mozart Provider
 *
 * The only AI orchestration layer on Handshake58.
 *
 * Every other provider does one thing. Orchestra does all of them —
 * intelligently. Send a goal in plain English. Orchestra plans it,
 * fans out to the right providers in parallel, and returns one
 * synthesized answer. Pay once, get everything.
 *
 * Modes:
 *   auto     — Planner decides which providers to use and in what order
 *   plan     — Dry-run: returns the execution plan without running it
 *   pipeline — You define explicit steps (full control, DAG execution)
 *
 * Bittensor-native providers get priority: Chutes (SN22), Desearch (SN22),
 * Numinous (SN6), Vericore. Falls back to OpenRouter only when needed.
 *
 * model IDs:
 *   orchestra/auto       — Full auto-orchestration
 *   orchestra/plan       — Plan-only dry run
 *   orchestra/pipeline   — User-defined pipeline
 *
 * Input format: JSON in last user message matching MozartRequest schema.
 * See GET /v1/docs for full reference.
 */

import express from 'express';
import cors from 'cors';
import { config as dotenv } from 'dotenv';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { orchestrate } from './planner.js';
import {
  MOZART_BASE_FEE_USDC,
  MOZART_PLAN_FEE_USDC,
  DRAIN_ADDRESSES,
  PROVIDER_COST_ESTIMATES,
} from './constants.js';
import type { ProviderConfig, MozartRequest, MozartStreamEvent, ChannelState, VoucherHeader } from './types.js';

dotenv();

// ─── Config ───────────────────────────────────────────────────────────────────

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) { console.error(`[config] Missing required env: ${k}`); return `MISSING_${k}`; }
  return v;
}
function optEnv(k: string, d: string): string { return process.env[k] ?? d; }

const chainId = (parseInt(optEnv('CHAIN_ID', '137'))) as 137 | 80002;

const config: ProviderConfig = {
  port:                     parseInt(optEnv('PORT', '3000')),
  host:                     optEnv('HOST', '0.0.0.0'),
  chainId,
  providerPrivateKey:       requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
  polygonRpcUrl:            process.env.POLYGON_RPC_URL,
  claimThreshold:           BigInt(optEnv('CLAIM_THRESHOLD', '10000000')),
  storagePath:              optEnv('STORAGE_PATH', '/app/data/vouchers.json'),
  providerName:             optEnv('PROVIDER_NAME', 'Mozart'),
  autoClaimIntervalMinutes: parseInt(optEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
  autoClaimBufferSeconds:   parseInt(optEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  // Upstream keys
  openrouterApiKey:   optEnv('OPENROUTER_API_KEY', ''),
  desearchApiKey:     requireEnv('DESEARCH_API_KEY'),
  chutesApiKey:       requireEnv('CHUTES_API_KEY'),
  e2bApiKey:          process.env.E2B_API_KEY,
  replicateApiToken:  process.env.REPLICATE_API_TOKEN,
  // Orchestra
  markupMultiplier:   1 + parseInt(optEnv('MARKUP_PERCENT', '30')) / 100,
  maxPlanSteps:       parseInt(optEnv('MAX_PLAN_STEPS', '6')),
  plannerModel:       optEnv('PLANNER_MODEL',     'deepseek-ai/DeepSeek-R1'),
  synthesizerModel:   optEnv('SYNTHESIZER_MODEL', 'deepseek-ai/DeepSeek-V3-0324'),
};

// ─── Services ────────────────────────────────────────────────────────────────

const storage     = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

// ─── Payment middleware ───────────────────────────────────────────────────────

function paymentHeaders() {
  return {
    'X-Payment-Protocol': 'drain-v2',
    'X-Payment-Provider': drainService.getProviderAddress(),
    'X-Payment-Contract': DRAIN_ADDRESSES[chainId],
    'X-Payment-Chain':    String(chainId),
    'X-Payment-Docs':     '/v1/docs',
  };
}

async function requirePayment(
  req: express.Request,
  res: express.Response,
  minCost: bigint
): Promise<{ voucher: VoucherHeader; channel: ChannelState | undefined } | null> {
  const header = req.headers['x-drain-voucher'] as string | undefined;
  if (!header) {
    res.status(402).set({ ...paymentHeaders(), 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', code: 'voucher_required' },
    });
    return null;
  }

  const voucher = drainService.parseVoucherHeader(header);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format', code: 'invalid_voucher' } });
    return null;
  }

  const validation = await drainService.validateVoucher(voucher, minCost);
  if (!validation.valid) {
    res.status(402).set({
      'X-DRAIN-Error':    validation.error!,
      'X-DRAIN-Required': minCost.toString(),
    }).json({ error: { message: `Payment error: ${validation.error}`, code: validation.error } });
    return null;
  }

  return { voucher, channel: validation.channel };
}

// ─── GET /health ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    provider:    drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId:     config.chainId,
    models:      3,
    modes:       ['auto', 'plan', 'pipeline'],
    bittensor_native: ['chutes', 'desearch', 'numinous', 'vericore'],
    bittensor_native_providers: ['chutes', 'desearch', 'numinous', 'vericore'],
    available_providers: ['chutes', 'openrouter', 'desearch', 'e2b', 'numinous', 'vericore', 'replicate'],
  });
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id:             'orchestra/auto',
        object:         'model',
        created:        1742000000,
        owned_by:       'mozart',
        context_length: 128000,
        description:    'Full auto-orchestration. Send a goal, Orchestra plans and executes it using the optimal mix of providers.',
        modes:          ['auto'],
      },
      {
        id:             'orchestra/plan',
        object:         'model',
        created:        1742000000,
        owned_by:       'mozart',
        context_length: 128000,
        description:    'Dry-run planning only. Returns the execution plan without running it. Use to preview costs and steps.',
        modes:          ['plan'],
      },
      {
        id:             'orchestra/pipeline',
        object:         'model',
        created:        1742000000,
        owned_by:       'mozart',
        context_length: 128000,
        description:    'User-defined pipeline. You specify exact steps and provider routing. Orchestra executes with DAG scheduling.',
        modes:          ['pipeline'],
      },
    ],
  });
});

// ─── GET /v1/pricing ──────────────────────────────────────────────────────────

app.get('/v1/pricing', (_req, res) => {
  const markup = Math.round((config.markupMultiplier - 1) * 100);
  res.json({
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId:      config.chainId,
    currency:     'USDC',
    markup:       `${markup}%`,
    models: {
      'orchestra/auto':     { inputCostPer1k: '0.005', outputCostPer1k: '0.005' },
      'orchestra/plan':     { inputCostPer1k: '0.010', outputCostPer1k: '0.010' },
      'orchestra/pipeline': { inputCostPer1k: '0.005', outputCostPer1k: '0.005' },
    },
    fees: {
      base_coordination: `$${formatUnits(MOZART_BASE_FEE_USDC, 6)} per orchestration`,
      plan_only:         `$${formatUnits(MOZART_PLAN_FEE_USDC, 6)} per plan`,
    },
    provider_cost_estimates: Object.fromEntries(
      Object.entries(PROVIDER_COST_ESTIMATES).map(([k, v]) => [k, `$${formatUnits(v, 6)}`])
    ),
    note: 'Total cost = base fee + sum of executed step costs. Use mode:"plan" to preview before running.',
  });
});

// ─── GET /v1/docs ─────────────────────────────────────────────────────────────

app.get('/v1/docs', (_req, res) => {
  const markup = Math.round((config.markupMultiplier - 1) * 100);
  res.type('text/plain').send(`# ${config.providerName} — Agent Instructions

The only AI orchestration layer on Handshake58.

Send one goal. Orchestra plans it, runs it across multiple providers in parallel,
and returns one synthesized answer. You pay once for the whole workflow.

Bittensor-native providers are prioritised: Chutes (SN22), Desearch (SN22), Numinous (SN6), Vericore.

════════════════════════════════════════

## How to call via DRAIN

model: "orchestra/auto" | "orchestra/plan" | "orchestra/pipeline"
messages: [{ "role": "user", "content": "<JSON request body>" }]

## Request schema

{
  "mode": "auto" | "plan" | "pipeline",
  "goal": "<what you want accomplished, in plain English>",
  "context": "<optional background context>",
  "budget_usd": 0.10,           // optional spend cap (default 0.10)
  "providers": ["chutes","desearch"],  // optional whitelist
  "stream": false,              // set true to get SSE progress events
  "steps": [...]                // required for mode:"pipeline" only
}

## Modes

### mode: "auto" (recommended)
The planner (DeepSeek R1) reads your goal and decides:
  - which providers to use
  - what to ask each one
  - which steps can run in parallel
  - how to feed outputs between steps
Then the synthesizer (DeepSeek V3) merges all outputs into one answer.

### mode: "plan"
Returns the execution plan WITHOUT running it. Zero cost beyond plan fee.
Use this to preview what Orchestra would do before committing budget.

### mode: "pipeline"
You define the steps explicitly. Full control over provider routing.
Steps run in topological order — outputs flow between steps via input_from.

Pipeline step schema:
{
  "id": "step_1",
  "provider": "chutes" | "openrouter" | "desearch" | "e2b" | "numinous" | "vericore" | "replicate",
  "model": "<provider-specific model id>",
  "task": "<what to do — plain english or code>",
  "input_from": ["step_1"],   // pipe outputs from prior steps
  "parallel": true,
  "required": true,
  "estimated_cost_usd": 0.01
}

════════════════════════════════════════

## Examples

### Research + analysis
{
  "mode": "auto",
  "goal": "Find the latest news on Bittensor dTAO, then write a concise briefing with probability estimate of TAO price doubling in 6 months",
  "budget_usd": 0.15
}

### Fact-check a claim
{
  "mode": "auto",
  "goal": "Verify: 'Bittensor has over 100 active subnets as of 2026'",
  "providers": ["desearch", "vericore"]
}

### Compute + summarize
{
  "mode": "pipeline",
  "goal": "Fibonacci benchmark",
  "steps": [
    {
      "id": "step_1", "provider": "e2b", "model": "python",
      "task": "import time; s=time.time(); fib=lambda n: n if n<2 else fib(n-1)+fib(n-2); print(fib(35)); print(f'Time: {time.time()-s:.2f}s')",
      "input_from": [], "parallel": true, "required": true, "estimated_cost_usd": 0.02
    },
    {
      "id": "step_2", "provider": "chutes", "model": "deepseek-ai/DeepSeek-V3-0324",
      "task": "Interpret this benchmark result and explain what it tells us about the environment.",
      "input_from": ["step_1"], "parallel": false, "required": true, "estimated_cost_usd": 0.01
    }
  ]
}

════════════════════════════════════════

## Pricing

Base coordination fee: $${formatUnits(MOZART_BASE_FEE_USDC, 6)} USDC
Plan-only fee:         $${formatUnits(MOZART_PLAN_FEE_USDC, 6)} USDC
Provider markup:       ${markup}%
Use GET /v1/pricing for per-provider cost estimates.

## Available providers

| Provider   | Type                | Bittensor native |
|------------|---------------------|------------------|
| chutes     | LLM inference       | ✓ SN22           |
| desearch   | Web + Twitter search| ✓ SN22           |
| numinous   | Probability forecast| ✓ SN6            |
| vericore   | Claim verification  | ✓                |
| openrouter | LLM inference       | ✗                |
| e2b        | Code execution      | ✗                |
| replicate  | Image/video/audio   | ✗                |
`);
});

// ─── POST /v1/chat/completions ────────────────────────────────────────────────

app.post('/v1/chat/completions', async (req, res) => {
  // Parse request
  const model    = req.body.model as string ?? 'orchestra/auto';
  const messages = req.body.messages as Array<{ role: string; content: string }> ?? [];
  const isStream = req.body.stream === true;

  if (!['orchestra/auto', 'orchestra/plan', 'orchestra/pipeline'].includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Use orchestra/auto, orchestra/plan, or orchestra/pipeline.` } });
  }

  const lastUser = messages.filter(m => m.role === 'user').pop();
  if (!lastUser?.content?.trim()) {
    return res.status(400).json({ error: { message: 'Send MozartRequest JSON as the user message. See /v1/docs.' } });
  }

  let orchRequest: MozartRequest;
  try {
    orchRequest = JSON.parse(lastUser.content);
  } catch {
    return res.status(400).json({ error: { message: 'User message must be valid JSON. See GET /v1/docs.' } });
  }

  // Force mode from model ID
  if (model === 'orchestra/plan')     orchRequest.mode = 'plan';
  if (model === 'orchestra/pipeline') orchRequest.mode = 'pipeline';
  if (model === 'orchestra/auto')     orchRequest.mode = 'auto';

  if (!orchRequest.goal) {
    return res.status(400).json({ error: { message: '"goal" is required in the request.' } });
  }

  // Estimate pre-auth cost: base fee + max possible step costs
  const maxSteps   = config.maxPlanSteps;
  const maxPerStep = Math.max(...Object.values(PROVIDER_COST_ESTIMATES).map(Number));
  const preAuthCost = orchRequest.mode === 'plan'
    ? MOZART_PLAN_FEE_USDC
    : MOZART_BASE_FEE_USDC + BigInt(maxSteps) * BigInt(maxPerStep);

  const payment = await requirePayment(req, res, preAuthCost);
  if (!payment) return;

  const { voucher, channel } = payment;

  // ── Streaming mode ──────────────────────────────────────────────────────────
  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-DRAIN-Channel', voucher.channelId);

    const sendEvent = (event: MozartStreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await orchestrate(orchRequest, config, sendEvent);

      const totalCostWei = MOZART_BASE_FEE_USDC +
        BigInt(Math.ceil(result.total_cost_usd * 1_000_000 * config.markupMultiplier));

      drainService.storeVoucher(voucher, channel!, totalCostWei);
      const remaining = channel!.deposit - channel!.totalCharged - totalCostWei;

      res.write(`: X-DRAIN-Cost: ${totalCostWei.toString()}\n`);
      res.write(`: X-DRAIN-Remaining: ${remaining.toString()}\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err: any) {
      sendEvent({ event: 'error', data: { message: err?.message }, timestamp: Date.now() });
      res.end();
    }
    return;
  }

  // ── Non-streaming mode ──────────────────────────────────────────────────────
  try {
    const result = await orchestrate(orchRequest, config);

    const totalCostWei = MOZART_BASE_FEE_USDC +
      BigInt(Math.ceil(result.total_cost_usd * 1_000_000 * config.markupMultiplier));

    drainService.storeVoucher(voucher, channel!, totalCostWei);
    const remaining = channel!.deposit - channel!.totalCharged - totalCostWei;

    res.set({
      'X-DRAIN-Cost':      totalCostWei.toString(),
      'X-DRAIN-Total':     (channel!.totalCharged + totalCostWei).toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel':   voucher.channelId,
    });

    // OpenAI chat completion envelope
    res.json({
      id:      `orchestra-${Date.now()}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index:         0,
        message:       { role: 'assistant', content: JSON.stringify(result, null, 2) },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens:     0,
        completion_tokens: Math.ceil(JSON.stringify(result).length / 4),
        total_tokens:      Math.ceil(JSON.stringify(result).length / 4),
      },
      // Surface key fields at top level for agent convenience
      orchestra: {
        synthesis:         result.synthesis,
        providers_used:    result.providers_used,
        steps_completed:   result.steps.filter(s => s.status === 'done').length,
        steps_failed:      result.steps.filter(s => s.status === 'failed').length,
        total_duration_ms: result.total_duration_ms,
        total_cost_usd:    result.total_cost_usd,
      },
    });
  } catch (err: any) {
    console.error('[orchestra] Error:', err?.message);
    res.status(500).json({ error: { message: err?.message ?? 'Orchestration error', code: 'orchestra_error' } });
  }
});

// ─── POST /v1/admin/claim ─────────────────────────────────────────────────────

app.post('/v1/admin/claim', async (req, res) => {
  try {
    const txHashes = await drainService.claimPayments(req.query.force === 'true');
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /v1/admin/stats ──────────────────────────────────────────────────────

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    provider:     drainService.getProviderAddress(),
    providerName: config.providerName,
    ...stats,
    totalEarned:  formatUnits(stats.totalEarned, 6) + ' USDC',
  });
});

// ─── POST /v1/close-channel ───────────────────────────────────────────────────

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });
    const result = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: result.finalAmount.toString(), signature: result.signature });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'internal_error' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    const markup = Math.round((config.markupMultiplier - 1) * 100);
    console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    Mozart                                     ║
║         The AI Orchestration Layer for Handshake58                   ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Server:    http://${config.host}:${config.port}                                 ║
║  Provider:  ${drainService.getProviderAddress()}          ║
║  Chain:     ${config.chainId === 137 ? 'Polygon Mainnet' : 'Polygon Amoy'}                                    ║
║  Planner:   ${config.plannerModel.padEnd(40)}║
║  Markup:    ${markup}%                                                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Bittensor-native: chutes (SN22) · desearch (SN22) · numinous (SN6) ║
║  Also available:   openrouter · e2b · replicate · vericore           ║
╚═══════════════════════════════════════════════════════════════════════╝
`);
  });
}

main().catch(err => {
  console.error('[orchestra] Fatal:', err);
  process.exit(1);
});
