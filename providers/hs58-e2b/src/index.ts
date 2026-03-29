/**
 * HS58-E2B Provider
 *
 * DRAIN payment gateway for E2B code sandboxes.
 * Agents pay to execute code in isolated containers on e2b.dev.
 *
 * Supported languages (= "models"):
 *   e2b/python      — Python 3 (numpy, pandas, matplotlib pre-installed)
 *   e2b/javascript  — JavaScript (Node.js)
 *   e2b/typescript  — TypeScript (top-level await, ESM imports)
 *   e2b/bash        — Bash shell (full Linux, internet access)
 *   e2b/r           — R statistical computing
 *   e2b/java        — Java (JDK pre-installed)
 *
 * Input: The code to execute as plain text in the last user message.
 * Output: stdout, stderr, results, error info.
 *
 * Each request gets a fresh isolated sandbox that is killed after execution.
 */

import express from 'express';
import cors from 'cors';
import { Sandbox } from '@e2b/code-interpreter';
import {
  loadConfig,
  getModelPricing,
  isModelSupported,
  getSupportedModels,
  MODEL_DESCRIPTIONS,
  MODEL_BASE_PRICES_USD,
} from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { MODEL_TO_LANGUAGE } from './types.js';
import type { ExecutionResult } from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// GET /v1/pricing
// ---------------------------------------------------------------------------

app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const model of getSupportedModels()) {
    const p = getModelPricing(model)!;
    const priceUsd = (Number(p.inputPer1k) / 1_000_000).toFixed(4);
    pricing[model] = {
      pricePerExecution: priceUsd,
      inputPer1kTokens: priceUsd,
      outputPer1kTokens: '0',
      description: MODEL_DESCRIPTIONS[model] ?? '',
    };
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'code-sandbox',
    note: 'Flat rate per code execution. Each request spins up a fresh isolated sandbox on e2b.dev.',
    models: pricing,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

app.get('/v1/models', (_req, res) => {
  const models = getSupportedModels().map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'e2b.dev',
    description: MODEL_DESCRIPTIONS[model] ?? '',
    pricing_model: 'flat_per_execution',
  }));

  res.json({ object: 'list', data: models });
});

// ---------------------------------------------------------------------------
// GET /v1/docs
// ---------------------------------------------------------------------------

app.get('/v1/docs', (_req, res) => {
  const markupPct = Math.round((config.markupMultiplier - 1) * 100);

  res.type('text/plain').send(`# HS58-E2B Provider — Agent Instructions

This provider executes code in isolated E2B sandboxes.
Each sandbox has internet access, a full Linux environment, and is destroyed after execution.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the language IDs below
   - messages: ONE user message containing the CODE to execute (plain text, not JSON)

## Supported Languages

| Model              | Language   | Price (base) | Pre-installed |
|--------------------|------------|--------------|---------------|
| e2b/python         | Python 3   | $${MODEL_BASE_PRICES_USD['e2b/python']}  | numpy, pandas, matplotlib, scipy, scikit-learn, requests, beautifulsoup4 |
| e2b/javascript     | Node.js JS | $${MODEL_BASE_PRICES_USD['e2b/javascript']}  | Built-in Node modules |
| e2b/typescript     | TypeScript | $${MODEL_BASE_PRICES_USD['e2b/typescript']}  | Top-level await, ESM imports |
| e2b/bash           | Bash       | $${MODEL_BASE_PRICES_USD['e2b/bash']}  | Full Linux (Ubuntu), curl, wget, git, python3, node |
| e2b/r              | R          | $${MODEL_BASE_PRICES_USD['e2b/r']}  | Base R + common packages |
| e2b/java           | Java       | $${MODEL_BASE_PRICES_USD['e2b/java']}  | JDK 17 |

Prices shown are base; ${markupPct}% markup applied. Check /v1/pricing for exact USDC amounts.

## Examples

### Python — data analysis
model: "e2b/python"
message: |
  import pandas as pd
  import numpy as np
  data = {'x': [1,2,3,4,5], 'y': [2,4,6,8,10]}
  df = pd.DataFrame(data)
  print(df.describe())
  print(f"Correlation: {df.corr().iloc[0,1]:.3f}")

### JavaScript — fetch API
model: "e2b/javascript"
message: |
  const res = await fetch('https://api.github.com');
  const data = await res.json();
  console.log('GitHub API:', data.current_user_url);

### Bash — system commands
model: "e2b/bash"
message: |
  echo "System info:"
  uname -a
  python3 --version
  node --version
  curl -s https://api.ipify.org

### TypeScript — with imports
model: "e2b/typescript"
message: |
  const nums: number[] = [1, 2, 3, 4, 5];
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  console.log(\`Sum: \${sum}, Mean: \${mean}\`);

## Response Format
The result is returned as a JSON assistant message with:
  - stdout: captured standard output
  - stderr: captured standard error  
  - results: expression results (Python: last expression, charts as base64)
  - error: null or { name, value, traceback }
  - executionTimeMs: how long the code ran

## Notes
- Each execution gets a fresh, isolated sandbox (no state between requests)
- Sandboxes have internet access
- Max execution time: ${config.sandboxTimeoutMs / 1000}s (configurable via SANDBOX_TIMEOUT_MS)
- Installing packages: use pip/npm/apt inside bash or within the code
`);
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions  — Main paid endpoint
// ---------------------------------------------------------------------------

app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({
      error: { message: 'Payment required. Include X-DRAIN-Voucher header.' },
    });
    return;
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format.' } });
    return;
  }

  // 3. Resolve model / language
  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({
      error: {
        message: `Unknown model "${modelId}". Available: ${getSupportedModels().join(', ')}`,
      },
    });
    return;
  }

  const language = MODEL_TO_LANGUAGE[modelId];
  const pricing = getModelPricing(modelId)!;
  const cost = pricing.inputPer1k; // flat rate per execution

  // 4. Validate voucher covers cost
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${validation.error}` },
      ...(validation.error === 'insufficient_funds' && {
        required: cost.toString(),
      }),
    });
    return;
  }

  // 5. Extract code from last user message
  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content?.trim()) {
    res.status(400).json({
      error: { message: 'No code provided. Send the code to execute as the user message.' },
    });
    return;
  }

  const code = lastUserMsg.content;

  // 6. Execute code in E2B sandbox
  const startTime = Date.now();
  let sandbox: InstanceType<typeof Sandbox> | null = null;

  try {
    // Create a fresh isolated sandbox
    sandbox = await Sandbox.create({
      apiKey: config.e2bApiKey,
      timeoutMs: config.sandboxTimeoutMs,
    });

    // Execute the code
    const execution = await sandbox.runCode(code, { language });

    const executionTimeMs = Date.now() - startTime;

    // Build structured result
    const result: ExecutionResult = {
      language,
      stdout: execution.logs.stdout.join(''),
      stderr: execution.logs.stderr.join(''),
      results: execution.results.map((r: any) => {
        // Extract serializable representation of each result
        if (r.png) return { type: 'image/png', data: r.png };
        if (r.jpeg) return { type: 'image/jpeg', data: r.jpeg };
        if (r.svg) return { type: 'image/svg+xml', data: r.svg };
        if (r.html) return { type: 'text/html', data: r.html };
        if (r.text) return { type: 'text/plain', data: r.text };
        if (r.json) return { type: 'application/json', data: r.json };
        return { type: 'unknown', data: String(r) };
      }),
      error: execution.error
        ? {
            name: execution.error.name ?? 'Error',
            value: execution.error.value ?? String(execution.error),
            traceback: execution.error.traceback ?? '',
          }
        : null,
      executionTimeMs,
    };

    // 7. Store voucher
    drainService.storeVoucher(voucher, validation.channel!, cost);
    const totalCharged = validation.channel!.totalCharged;
    const remaining = validation.channel!.deposit - totalCharged;

    // 8. Respond in OpenAI format
    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `e2b-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(result, null, 2),
        },
        finish_reason: execution.error ? 'error' : 'stop',
      }],
      usage: {
        prompt_tokens: Math.ceil(code.length / 4),
        completion_tokens: Math.ceil(result.stdout.length / 4),
        total_tokens: Math.ceil((code.length + result.stdout.length) / 4),
      },
    });

  } catch (error: any) {
    const msg = error?.message ?? String(error);
    console.error(`[e2b] Execution failed for ${modelId}:`, msg);
    res.status(502).json({
      error: { message: `Sandbox execution failed: ${msg.slice(0, 300)}` },
    });
  } finally {
    // Always kill the sandbox to stop E2B billing
    if (sandbox) {
      sandbox.kill().catch((e: any) =>
        console.error('[e2b] Failed to kill sandbox:', e?.message)
      );
    }
  }
});

// ---------------------------------------------------------------------------
// POST /v1/admin/claim
// ---------------------------------------------------------------------------

app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/admin/stats
// ---------------------------------------------------------------------------

app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    sandboxTimeoutMs: config.sandboxTimeoutMs,
    modelsSupported: getSupportedModels(),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/vouchers
// ---------------------------------------------------------------------------

app.get('/v1/admin/vouchers', (_req, res) => {
  const unclaimed = storage.getUnclaimedVouchers();
  res.json({
    count: unclaimed.length,
    vouchers: unclaimed.map(v => ({
      channelId: v.channelId,
      amount: v.amount.toString(),
      nonce: v.nonce.toString(),
      consumer: v.consumer,
      receivedAt: new Date(v.receivedAt).toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/close-channel
// ---------------------------------------------------------------------------

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const result = await drainService.signCloseAuthorization(channelId);
    res.json({
      channelId,
      finalAmount: result.finalAmount.toString(),
      signature: result.signature,
    });
  } catch (error: any) {
    console.error('[close-channel] Error:', error?.message || error);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    modelsSupported: getSupportedModels(),
    sandboxTimeoutMs: config.sandboxTimeoutMs,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Quick connectivity check: spin up a minimal sandbox and kill it immediately
  try {
    const testSbx = await Sandbox.create({
      apiKey: config.e2bApiKey,
      timeoutMs: 10_000,
    });
    await testSbx.kill();
    console.log('[startup] E2B API connection verified.');
  } catch (error: any) {
    console.warn(`[startup] WARNING: E2B API check failed: ${error.message}`);
    console.warn('[startup] Continuing anyway — check E2B_API_KEY if requests fail.');
  }

  // Start auto-claiming expiring DRAIN channels
  drainService.startAutoClaim(
    config.autoClaimIntervalMinutes,
    config.autoClaimBufferSeconds,
  );

  app.listen(config.port, config.host, () => {
    const markup = Math.round((config.markupMultiplier - 1) * 100);
    console.log(`\nHS58-E2B Provider running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
    console.log(`Markup: ${markup}%`);
    console.log(`Sandbox timeout: ${config.sandboxTimeoutMs / 1000}s`);
    console.log(`\nPricing:`);
    for (const model of getSupportedModels()) {
      const p = getModelPricing(model)!;
      const usd = (Number(p.inputPer1k) / 1_000_000).toFixed(4);
      console.log(`  ${model}: $${usd}/execution`);
    }
    console.log();
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
