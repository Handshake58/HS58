/**
 * Community-Targon Provider
 *
 * GPU Compute Management via Targon (api.targon.com/tha/v2).
 * Agents can browse GPU inventory, deploy serverless workloads and rentals,
 * check status, and delete workloads — all via DRAIN micropayments.
 */

import express from 'express';
import cors from 'cors';
import {
  loadConfig,
  getModelPricing,
  isModelSupported,
  getSupportedModels,
  MODELS,
} from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import type { ProviderConfig } from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json());

// --- Targon API helper ---

async function targonFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${config.targonApiUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.targonApiKey}`,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 204) return { success: true };

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Targon API ${res.status}: ${body}`);
  }
  return JSON.parse(body);
}

// --- Auth helper ---

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  if (req.headers.authorization !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// --- DRAIN endpoints ---

app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, { inputPer1kTokens: string; outputPer1kTokens: string }> = {};
  for (const [id, p] of MODELS) {
    models[id] = {
      inputPer1kTokens: formatUnits(p.inputPer1k, 6),
      outputPer1kTokens: formatUnits(p.outputPer1k, 6),
    };
  }
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    totalModels: MODELS.size,
    models,
  });
});

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: getSupportedModels().map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'targon',
    })),
    total: MODELS.size,
  });
});

app.get('/v1/docs', (_req, res) => {
  const pricing = (id: string) => {
    const p = getModelPricing(id);
    return p ? `$${formatUnits(p.inputPer1k, 6)} flat` : '—';
  };

  res.type('text/plain').send(`# ${config.providerName} — Agent Instructions

GPU Compute Management via Targon (Bittensor Subnet 4 infrastructure).
Deploy serverless inference endpoints or dedicated GPU rentals. Pay per operation with DRAIN.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the operation IDs below
   - messages: ONE user message containing a JSON payload

## Available Operations

| Model                    | Description                              | Price             |
|--------------------------|------------------------------------------|-------------------|
| targon/inventory         | Browse GPU availability and pricing      | ${pricing('targon/inventory')} |
| targon/workloads         | List your deployed workloads             | ${pricing('targon/workloads')} |
| targon/workload-status   | Get status + URL of a workload           | ${pricing('targon/workload-status')} |
| targon/create-serverless | Deploy a serverless GPU workload         | ${pricing('targon/create-serverless')} |
| targon/create-rental     | Deploy a dedicated GPU rental            | ${pricing('targon/create-rental')} |
| targon/delete-workload   | Delete a workload                        | ${pricing('targon/delete-workload')} |

## Input Formats

### targon/inventory
\`\`\`json
{"type": "serverless"}
\`\`\`
Optional: type ("rental"|"serverless"|"storage"), gpu (true/false). Empty {} returns all.

### targon/workloads
\`\`\`json
{"type": "SERVERLESS", "limit": 10}
\`\`\`
Optional: type ("RENTAL"|"SERVERLESS"), limit (int).

### targon/workload-status
\`\`\`json
{"uid": "wrk-abc123def456"}
\`\`\`

### targon/create-serverless
\`\`\`json
{
  "name": "my-vllm-api",
  "image": "vllm/vllm-openai:v0.6.0",
  "resource_name": "h200-small",
  "envs": [{"name": "MODEL", "value": "meta-llama/Llama-3.1-8B-Instruct"}],
  "ports": [{"port": 8000, "protocol": "TCP", "routing": "PROXIED"}],
  "serverless_config": {
    "min_replicas": 0, "max_replicas": 2,
    "timeout_seconds": 120,
    "readiness_probe": {"path": "/health", "port": 8000}
  }
}
\`\`\`

### targon/create-rental
\`\`\`json
{
  "name": "my-gpu-server",
  "image": "pytorch/pytorch:latest",
  "resource_name": "h200-small",
  "envs": [{"name": "KEY", "value": "val"}]
}
\`\`\`
Optional: ssh_keys (array of SSH key UIDs), volumes, ports.

### targon/delete-workload
\`\`\`json
{"uid": "wrk-abc123def456"}
\`\`\`

## GPU Inventory (example)

Fetch GET /v1/pricing or use targon/inventory to see current availability.
H200 Small: ~$2.49/hr, 1x H200, 12 vCPU, 115 GB RAM.
All workloads get a public URL at https://wrk-{uid}.caas.targon.com once running.

## Notes

- Workload URLs are available in status.urls after deployment (status: RUNNING)
- Serverless workloads scale to zero when idle (save costs)
- Rental workloads run 24/7 until explicitly deleted
- create-serverless and create-rental both register AND deploy in one call
- Check pricing: GET /v1/pricing
`);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    operations: getSupportedModels().length,
  });
});

// --- Core: POST /v1/chat/completions ---

app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  if (!voucherHeader) {
    return res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    return res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
  }

  // 3. Validate model
  const model = req.body.model as string;
  if (!isModelSupported(model)) {
    return res.status(400).json({
      error: {
        message: `Model '${model}' not supported. Use GET /v1/models to see available operations.`,
        code: 'model_not_supported',
      },
    });
  }

  // 4. Flat-rate cost validation
  const pricing = getModelPricing(model)!;
  const cost = pricing.inputPer1k; // flat price = inputPer1k directly

  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    const headers: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = cost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    return res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
  }

  const channelState = validation.channel!;

  // 5. Parse input JSON from last user message
  const lastMessage = req.body.messages?.findLast?.((m: { role: string }) => m.role === 'user')
    ?? req.body.messages?.[req.body.messages.length - 1];
  const rawContent: string = typeof lastMessage?.content === 'string' ? lastMessage.content : '{}';

  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(rawContent);
  } catch {
    // allow empty / non-JSON input for read ops
  }

  // 6. Execute Targon operation
  let result: unknown;
  try {
    switch (model) {
      case 'targon/inventory': {
        const qs = new URLSearchParams();
        if (input.type) qs.set('type', String(input.type));
        if (input.gpu !== undefined) qs.set('gpu', String(input.gpu));
        // Inventory is public — no auth needed, but we still use our key for consistency
        result = await targonFetch(`/inventory${qs.size ? `?${qs}` : ''}`);
        break;
      }

      case 'targon/workloads': {
        const qs = new URLSearchParams();
        if (input.type) qs.set('type', String(input.type));
        if (input.limit) qs.set('limit', String(input.limit));
        if (input.cursor) qs.set('cursor', String(input.cursor));
        result = await targonFetch(`/workloads${qs.size ? `?${qs}` : ''}`);
        break;
      }

      case 'targon/workload-status': {
        if (!input.uid) throw new Error('uid is required');
        result = await targonFetch(`/workloads/${input.uid}/state`);
        break;
      }

      case 'targon/create-serverless': {
        if (!input.name) throw new Error('name is required');
        if (!input.image) throw new Error('image is required');
        if (!input.resource_name) throw new Error('resource_name is required (e.g. "h200-small")');
        const body = { ...input, type: 'SERVERLESS' };
        const workload = await targonFetch('/workloads', { method: 'POST', body: JSON.stringify(body) }) as { uid: string };
        await targonFetch(`/workloads/${workload.uid}/deploy`, { method: 'POST' });
        result = { ...workload, _note: 'Workload registered and deployment triggered. Use targon/workload-status to check progress.' };
        break;
      }

      case 'targon/create-rental': {
        if (!input.name) throw new Error('name is required');
        if (!input.image) throw new Error('image is required');
        if (!input.resource_name) throw new Error('resource_name is required (e.g. "h200-small")');
        const body = { ...input, type: 'RENTAL' };
        const workload = await targonFetch('/workloads', { method: 'POST', body: JSON.stringify(body) }) as { uid: string };
        await targonFetch(`/workloads/${workload.uid}/deploy`, { method: 'POST' });
        result = { ...workload, _note: 'Rental registered and deployment triggered. Use targon/workload-status to check progress.' };
        break;
      }

      case 'targon/delete-workload': {
        if (!input.uid) throw new Error('uid is required');
        await targonFetch(`/workloads/${input.uid}`, { method: 'DELETE' });
        result = { deleted: true, uid: input.uid };
        break;
      }

      default:
        throw new Error(`Unknown model: ${model}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Targon API error';
    return res.status(502).json({
      error: { message, type: 'api_error', code: 'targon_error' },
    });
  }

  // 7. Store voucher + respond
  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;

  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `targon-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(result, null, 2),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
});

app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { finalAmount, signature } = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: finalAmount.toString(), signature });
  } catch (error: unknown) {
    console.error('[close-channel] Error:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'claim error' });
  }
});

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    ...stats,
    totalEarned: formatUnits(stats.totalEarned, 6) + ' USDC',
    operations: getSupportedModels().length,
  });
});

async function main() {
  console.log(`Starting ${config.providerName}...`);
  console.log(`  Targon API: ${config.targonApiUrl}`);
  console.log(`  Operations: ${getSupportedModels().join(', ')}`);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} listening on ${config.host}:${config.port}`);
    console.log(`  Provider: ${drainService.getProviderAddress()}`);
    console.log(`  Chain:    ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
    console.log(`  Operations: ${getSupportedModels().length}`);
  });
}

main().catch(console.error);
