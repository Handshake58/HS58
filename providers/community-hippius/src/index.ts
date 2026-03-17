/**
 * Community-Hippius Provider
 *
 * DRAIN payment gateway for Hippius decentralized storage (Bittensor Subnet 75).
 * S3-compatible object storage + IPFS pinning, paid via USDC micropayments.
 *
 * All agent data is isolated using channel-ID bucket prefixes.
 */

import express from 'express';
import cors from 'cors';
import { loadConfig, getModelPricing, isModelSupported, getSupportedModels, getModelMap } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import {
  initS3Client,
  namespaceBucket,
  ensureBucket,
  putObject,
  getObject,
  listObjects,
  createBucket,
  deleteObject,
  ipfsPin,
} from './hippius.js';
import type {
  HippiusOperation,
  UploadInput,
  DownloadInput,
  ListInput,
  CreateBucketInput,
  DeleteInput,
  IpfsPinInput,
} from './types.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

initS3Client(config.hippius);

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' }));

// --- Rate Limiter (per channel, sliding window) ---

const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string): boolean {
  const now = Date.now();
  const hits = rateLimitMap.get(channelId) ?? [];
  const recent = hits.filter(t => now - t < 60_000);
  if (recent.length >= config.rateLimitPerMinute) return false;
  recent.push(now);
  rateLimitMap.set(channelId, recent);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, hits] of rateLimitMap) {
    const active = hits.filter(t => t > cutoff);
    if (active.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, active);
  }
}, 5 * 60_000);

// --- Admin Auth ---

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <ADMIN_PASSWORD>' });
    return false;
  }
  return true;
}

// --- Cost Calculation ---

function calculateCost(model: HippiusOperation, dataSizeBytes?: number): bigint {
  const mb = dataSizeBytes ? Math.max(1, Math.ceil(dataSizeBytes / (1024 * 1024))) : 1;

  switch (model) {
    case 'hippius/upload':
      return config.pricePerMbUpload * BigInt(mb);
    case 'hippius/download':
      return config.pricePerMbDownload * BigInt(mb);
    case 'hippius/list':
      return config.pricePerList;
    case 'hippius/create-bucket':
      return config.pricePerCreateBucket;
    case 'hippius/delete':
      return config.pricePerDelete;
    case 'hippius/ipfs-pin':
      return config.pricePerMbIpfsPin * BigInt(mb);
    default:
      return config.pricePerList;
  }
}

function parseUserMessage(messages: Array<{ role: string; content: string }>): any {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) throw new Error('No user message found');

  try {
    return JSON.parse(lastUserMsg.content);
  } catch {
    throw new Error('User message must be valid JSON. See GET /v1/docs for format.');
  }
}

// ============================================================
// Routes
// ============================================================

app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, any> = {};
  for (const [id, pricing] of getModelMap()) {
    models[id] = {
      inputPer1kTokens: formatUnits(pricing.inputPer1k, 6),
      outputPer1kTokens: formatUnits(pricing.outputPer1k, 6),
    };
  }
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'storage',
    models,
  });
});

app.get('/v1/models', (_req, res) => {
  const descriptions: Record<string, string> = {
    'hippius/upload': 'Upload a file to S3-compatible decentralized storage',
    'hippius/download': 'Download a file from storage',
    'hippius/list': 'List objects in a bucket',
    'hippius/create-bucket': 'Create a new storage bucket',
    'hippius/delete': 'Delete an object from storage',
    'hippius/ipfs-pin': 'Pin content to IPFS for permanent decentralized storage',
  };

  res.json({
    object: 'list',
    data: getSupportedModels().map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'hippius',
      description: descriptions[id] || id,
    })),
  });
});

app.get('/v1/docs', (_req, res) => {
  const pUpload = formatUnits(config.pricePerMbUpload, 6);
  const pDownload = formatUnits(config.pricePerMbDownload, 6);
  const pList = formatUnits(config.pricePerList, 6);
  const pBucket = formatUnits(config.pricePerCreateBucket, 6);
  const pDelete = formatUnits(config.pricePerDelete, 6);
  const pIpfs = formatUnits(config.pricePerMbIpfsPin, 6);

  res.type('text/plain').send(`# Community-Hippius — Agent Instructions

Decentralized cloud storage via DRAIN micropayments.
S3-compatible object storage + IPFS pinning, powered by Bittensor Subnet 75.
This is NOT a chat/LLM provider. It is a storage service.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: one of the operations below
   - messages: ONE user message containing a JSON object (see Input Format)

## Available Operations

| Model ID             | Description                    | Price             |
|----------------------|--------------------------------|-------------------|
| hippius/upload       | Upload file to S3 storage      | $${pUpload}/MB    |
| hippius/download     | Download file from storage     | $${pDownload}/MB  |
| hippius/list         | List objects in a bucket       | $${pList}/req     |
| hippius/create-bucket| Create a new bucket            | $${pBucket}/req   |
| hippius/delete       | Delete an object               | $${pDelete}/req   |
| hippius/ipfs-pin     | Pin content to IPFS            | $${pIpfs}/MB      |

## Input Format (user message JSON)

### hippius/upload
{ "bucket": "my-bucket", "key": "path/to/file.pdf", "content": "<base64>", "contentType": "application/pdf" }

### hippius/download
{ "bucket": "my-bucket", "key": "path/to/file.pdf" }

### hippius/list
{ "bucket": "my-bucket", "prefix": "path/" }

### hippius/create-bucket
{ "bucket": "new-bucket-name" }

### hippius/delete
{ "bucket": "my-bucket", "key": "path/to/file.pdf" }

### hippius/ipfs-pin
{ "content": "<base64>", "filename": "document.pdf", "contentType": "application/pdf" }

## Response

The assistant message contains a JSON object with operation results:
- upload: { "etag": "...", "sizeBytes": 1234, "bucket": "...", "key": "..." }
- download: { "content": "<base64>", "contentType": "...", "sizeBytes": 1234 }
- list: { "objects": [{ "key": "...", "size": 1234, "lastModified": "..." }] }
- create-bucket: { "bucket": "..." }
- delete: { "deleted": true }
- ipfs-pin: { "cid": "...", "sizeBytes": 1234 }

## Notes
- Buckets are namespaced per payment channel — your data is isolated
- No egress fees — downloads are priced per-MB but very cheap
- Storage is persistent and decentralized (not temporary)
- Max file size: ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB
- Rate limit: ${config.rateLimitPerMinute} requests/min per channel
- Pricing: check /v1/pricing for current USDC rates
`);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string;
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
  const model = req.body.model as HippiusOperation;
  if (!isModelSupported(model)) {
    return res.status(400).json({ error: { message: `Model not supported: ${model}. Use GET /v1/models for available operations.` } });
  }

  // 4. Parse input from user message
  let input: any;
  try {
    input = parseUserMessage(req.body.messages || []);
  } catch (err: any) {
    return res.status(400).json({ error: { message: err.message } });
  }

  // 5. Estimate cost (pre-auth)
  let estimatedSizeBytes: number | undefined;
  if (model === 'hippius/upload' || model === 'hippius/ipfs-pin') {
    if (!input.content) {
      return res.status(400).json({ error: { message: 'Missing "content" field (base64-encoded file data)' } });
    }
    estimatedSizeBytes = Math.ceil(input.content.length * 3 / 4);
    if (estimatedSizeBytes > config.maxFileSizeBytes) {
      return res.status(413).json({ error: { message: `File too large: ${Math.ceil(estimatedSizeBytes / (1024 * 1024))} MB exceeds limit of ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB` } });
    }
  }

  const cost = calculateCost(model, estimatedSizeBytes);

  // 6. Validate voucher against cost
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

  // 7. Rate limit
  if (!checkRateLimit(voucher.channelId)) {
    return res.status(429).json({ error: { message: `Rate limit exceeded: max ${config.rateLimitPerMinute} requests/min per channel` } });
  }

  // 8. Execute the storage operation
  let resultContent: string;
  try {
    resultContent = await executeOperation(model, input, voucher.channelId);
  } catch (err: any) {
    console.error(`[hippius] Operation ${model} failed:`, err.message);
    return res.status(502).json({ error: { message: `Storage operation failed: ${err.message}` } });
  }

  // 9. Store voucher + respond
  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;

  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `hippius-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: resultContent }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
});

async function executeOperation(model: HippiusOperation, input: any, channelId: string): Promise<string> {
  switch (model) {
    case 'hippius/upload': {
      const { bucket, key, content, contentType } = input as UploadInput;
      if (!bucket || !key || !content) throw new Error('Missing required fields: bucket, key, content');
      const nsBucket = namespaceBucket(channelId, bucket);
      await ensureBucket(nsBucket);
      const body = Buffer.from(content, 'base64');
      const result = await putObject(nsBucket, key, body, contentType || 'application/octet-stream');
      return JSON.stringify({ ...result, bucket, key });
    }

    case 'hippius/download': {
      const { bucket, key } = input as DownloadInput;
      if (!bucket || !key) throw new Error('Missing required fields: bucket, key');
      const nsBucket = namespaceBucket(channelId, bucket);
      const result = await getObject(nsBucket, key);
      return JSON.stringify(result);
    }

    case 'hippius/list': {
      const { bucket, prefix } = input as ListInput;
      if (!bucket) throw new Error('Missing required field: bucket');
      const nsBucket = namespaceBucket(channelId, bucket);
      const result = await listObjects(nsBucket, prefix);
      return JSON.stringify(result);
    }

    case 'hippius/create-bucket': {
      const { bucket } = input as CreateBucketInput;
      if (!bucket) throw new Error('Missing required field: bucket');
      const nsBucket = namespaceBucket(channelId, bucket);
      const result = await createBucket(nsBucket);
      return JSON.stringify({ bucket: result.bucket });
    }

    case 'hippius/delete': {
      const { bucket, key } = input as DeleteInput;
      if (!bucket || !key) throw new Error('Missing required fields: bucket, key');
      const nsBucket = namespaceBucket(channelId, bucket);
      const result = await deleteObject(nsBucket, key);
      return JSON.stringify(result);
    }

    case 'hippius/ipfs-pin': {
      const { content, filename, contentType } = input as IpfsPinInput;
      if (!content || !filename) throw new Error('Missing required fields: content, filename');
      const body = Buffer.from(content, 'base64');
      const result = await ipfsPin(config.hippius.ipfsBucket, filename, body, contentType || 'application/octet-stream');
      return JSON.stringify(result);
    }

    default:
      throw new Error(`Unknown operation: ${model}`);
  }
}

app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { finalAmount, signature } = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: finalAmount.toString(), signature });
  } catch (error: any) {
    console.error('[close-channel] Error:', error.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    totalUnclaimed: storage.getTotalUnclaimed().toString(),
  });
});

app.get('/v1/admin/vouchers', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const unclaimed = storage.getUnclaimedVouchers();
  res.json({
    count: unclaimed.length,
    vouchers: unclaimed.map(v => ({
      ...v,
      amount: v.amount.toString(),
      nonce: v.nonce.toString(),
    })),
  });
});

// ============================================================
// Start
// ============================================================

async function start() {
  console.log(`\n=== ${config.providerName} ===`);
  console.log(`Provider: ${drainService.getProviderAddress()}`);
  console.log(`Chain: ${config.chainId}`);
  console.log(`Hippius endpoint: ${config.hippius.endpoint}`);
  console.log(`Max file size: ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB`);
  console.log(`Rate limit: ${config.rateLimitPerMinute}/min per channel\n`);

  drainService.startAutoClaim(
    config.autoClaimIntervalMinutes,
    config.autoClaimBufferSeconds,
  );

  app.listen(config.port, config.host, () => {
    console.log(`Listening on ${config.host}:${config.port}`);
    console.log(`Health: http://localhost:${config.port}/health`);
    console.log(`Pricing: http://localhost:${config.port}/v1/pricing`);
    console.log(`Docs: http://localhost:${config.port}/v1/docs\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
