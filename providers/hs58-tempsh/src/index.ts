/**
 * HS58-TempSh Provider
 *
 * DRAIN payment gateway for temp.sh temporary file hosting.
 * Agents pay per upload via USDC micropayments; files are proxied
 * to temp.sh (free tier) and expire after 3 days.
 *
 * Business model: temp.sh costs $0 → 100% margin on every upload.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { loadConfig, loadModels, getModelPricing, isModelSupported } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import { TEMPSH_UPLOAD_URL, TEMPSH_FILE_TTL } from './constants.js';

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// multer: store in memory, enforce max file size
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes },
  fileFilter: (_req, file, cb) => {
    if (config.allowedMimeTypes.length === 0) {
      cb(null, true);
      return;
    }
    if (config.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`MIME type "${file.mimetype}" not allowed. Allowed: ${config.allowedMimeTypes.join(', ')}`));
    }
  },
});

// --- Rate Limiter (per channel, sliding window) ---
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(channelId: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const hits = rateLimitMap.get(channelId) ?? [];
  const recent = hits.filter(t => now - t < windowMs);
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

// --- Admin Auth Middleware ---
function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminPassword) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.adminPassword}`) {
    res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <ADMIN_PASSWORD>' });
    return false;
  }
  return true;
}

/**
 * Calculates the cost for an upload based on pricing mode.
 */
function calculateCost(fileSizeBytes: number): bigint {
  if (config.pricingMode === 'flat') {
    return config.pricePerUpload;
  }
  // per-mb: ceil to next MB, minimum 1 MB
  const mb = Math.max(1, Math.ceil(fileSizeBytes / (1024 * 1024)));
  return config.pricePerMb * BigInt(mb);
}

/**
 * Uploads a file buffer to temp.sh using the native fetch API (Node 18+).
 * Returns the public URL of the uploaded file.
 */
async function uploadToTempSh(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimetype });
  formData.append('file', blob, filename);

  const response = await fetch(TEMPSH_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`temp.sh returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const url = (await response.text()).trim();
  if (!url.startsWith('https://')) {
    throw new Error(`Unexpected temp.sh response: ${url.slice(0, 200)}`);
  }

  return url;
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricePerUpload = formatUnits(config.pricePerUpload, 6);
  const pricePerMb = formatUnits(config.pricePerMb, 6);

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'file-upload',
    pricingMode: config.pricingMode,
    pricePerUpload: pricePerUpload,
    pricePerMb: pricePerMb,
    maxFileSizeMb: Math.floor(config.maxFileSizeBytes / (1024 * 1024)),
    fileTtl: TEMPSH_FILE_TTL,
    note: config.pricingMode === 'flat'
      ? `Flat rate of $${pricePerUpload} USDC per upload. Files expire after ${TEMPSH_FILE_TTL}.`
      : `$${pricePerMb} USDC per MB (min 1 MB). Files expire after ${TEMPSH_FILE_TTL}.`,
    models: {
      'tempsh/upload': {
        inputPer1kTokens: pricePerUpload,
        outputPer1kTokens: '0',
      },
    },
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'tempsh/upload',
      object: 'model',
      created: Date.now(),
      owned_by: 'tempsh',
      description: 'Upload files to temporary hosting (expires in 3 days)',
    }],
  });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const priceFlat = formatUnits(config.pricePerUpload, 6);
  const priceMb = formatUnits(config.pricePerMb, 6);

  res.type('text/plain').send(`# HS58-TempSh Provider — Agent Instructions

Upload files to temporary hosting via DRAIN micropayments.
Files are hosted on temp.sh and expire after ${TEMPSH_FILE_TTL}.

## Quick Start

1. Open a payment channel: drain_open_channel
2. Upload a file: POST /v1/files/upload (multipart/form-data)
   OR use the chat-compatible endpoint: POST /v1/chat/completions

## Native Upload: POST /v1/files/upload

Headers:
  X-DRAIN-Voucher: <signed voucher JSON>
  Content-Type: multipart/form-data

Form fields:
  file: (binary) — the file to upload

Response:
  { "url": "https://temp.sh/...", "filename": "...", "sizeBytes": 1234, "expiresIn": "${TEMPSH_FILE_TTL}" }

## Chat-Compatible: POST /v1/chat/completions

model: "tempsh/upload"
messages: [
  {
    "role": "user",
    "content": "<JSON string with base64 file>"
  }
]

User message content must be valid JSON:
  {
    "filename": "report.pdf",
    "content": "<base64-encoded file content>",
    "mimeType": "application/pdf"
  }

## Pricing

Mode: ${config.pricingMode}
${config.pricingMode === 'flat'
    ? `Flat rate: $${priceFlat} USDC per upload (regardless of file size)`
    : `Per-MB rate: $${priceMb} USDC per MB (min 1 MB billed)`}

## Limits

- Max file size: ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB
- Rate limit: ${config.rateLimitPerMinute} uploads/min per payment channel
- File TTL: ${TEMPSH_FILE_TTL} (temp.sh hard limit, no extension possible)
${config.allowedMimeTypes.length > 0 ? `- Allowed MIME types: ${config.allowedMimeTypes.join(', ')}` : '- MIME types: all accepted'}
`);
});

/**
 * POST /v1/files/upload
 *
 * Native multipart file upload with DRAIN payment.
 */
app.post('/v1/files/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: { message: `Upload error: ${err.message}` } });
      return;
    }
    if (err) {
      res.status(400).json({ error: { message: err.message } });
      return;
    }

    const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
    if (!voucherHeader) {
      res.status(402).json({ error: { message: 'Payment required. Include X-DRAIN-Voucher header.' } });
      return;
    }

    const voucher = drainService.parseVoucherHeader(voucherHeader);
    if (!voucher) {
      res.status(402).json({ error: { message: 'Invalid voucher format.' } });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: { message: 'No file provided. Use multipart/form-data with a "file" field.' } });
      return;
    }

    if (!checkRateLimit(voucher.channelId)) {
      res.status(429).json({ error: { message: `Rate limit exceeded. Max ${config.rateLimitPerMinute} uploads/min per channel.` } });
      return;
    }

    const cost = calculateCost(req.file.size);

    const voucherValidation = await drainService.validateVoucher(voucher, cost);
    if (!voucherValidation.valid) {
      res.status(402).json({
        error: { message: `Voucher error: ${voucherValidation.error}` },
        ...(voucherValidation.error === 'insufficient_funds' && { required: cost.toString() }),
      });
      return;
    }

    try {
      const url = await uploadToTempSh(req.file.buffer, req.file.originalname, req.file.mimetype);

      drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

      const totalCharged = voucherValidation.channel!.totalCharged;
      const remaining = voucherValidation.channel!.deposit - totalCharged;

      res.set({
        'X-DRAIN-Cost': cost.toString(),
        'X-DRAIN-Total': totalCharged.toString(),
        'X-DRAIN-Remaining': remaining.toString(),
        'X-DRAIN-Channel': voucher.channelId,
      });

      res.json({
        url,
        filename: req.file.originalname,
        sizeBytes: req.file.size,
        expiresIn: TEMPSH_FILE_TTL,
      });
    } catch (error: any) {
      console.error('[tempsh] Upload error:', error.message);
      res.status(502).json({ error: { message: `Upload failed: ${error.message?.slice(0, 200)}` } });
    }
  });
});

/**
 * POST /v1/chat/completions
 *
 * Chat-compatible wrapper for file uploads.
 * The last user message must be a JSON string:
 *   { "filename": "...", "content": "<base64>", "mimeType": "..." }
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;
  if (!voucherHeader) {
    res.status(402).json({ error: { message: 'Payment required. Include X-DRAIN-Voucher header.' } });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format.' } });
    return;
  }

  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({ error: { message: `Model "${modelId}" not available. Use: tempsh/upload` } });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }> | undefined;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({ error: { message: 'No user message found. Provide file as JSON in the user message.' } });
    return;
  }

  let fileInput: { filename: string; content: string; mimeType?: string };
  try {
    fileInput = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON: {"filename": "...", "content": "<base64>", "mimeType": "..."}',
      },
    });
    return;
  }

  if (!fileInput.filename || typeof fileInput.filename !== 'string') {
    res.status(400).json({ error: { message: '"filename" is required (string)' } });
    return;
  }
  if (!fileInput.content || typeof fileInput.content !== 'string') {
    res.status(400).json({ error: { message: '"content" is required (base64-encoded string)' } });
    return;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(fileInput.content, 'base64');
  } catch {
    res.status(400).json({ error: { message: '"content" must be a valid base64 string' } });
    return;
  }

  if (fileBuffer.length > config.maxFileSizeBytes) {
    res.status(400).json({
      error: {
        message: `File too large (${fileBuffer.length} bytes). Max: ${config.maxFileSizeBytes} bytes`,
      },
    });
    return;
  }

  const mimeType = fileInput.mimeType || 'application/octet-stream';

  if (config.allowedMimeTypes.length > 0 && !config.allowedMimeTypes.includes(mimeType)) {
    res.status(400).json({
      error: { message: `MIME type "${mimeType}" not allowed. Allowed: ${config.allowedMimeTypes.join(', ')}` },
    });
    return;
  }

  if (!checkRateLimit(voucher.channelId)) {
    res.status(429).json({ error: { message: `Rate limit exceeded. Max ${config.rateLimitPerMinute} uploads/min per channel.` } });
    return;
  }

  const cost = calculateCost(fileBuffer.length);

  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  try {
    const url = await uploadToTempSh(fileBuffer, fileInput.filename, mimeType);

    drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

    const totalCharged = voucherValidation.channel!.totalCharged;
    const remaining = voucherValidation.channel!.deposit - totalCharged;

    const resultContent = JSON.stringify({
      url,
      filename: fileInput.filename,
      sizeBytes: fileBuffer.length,
      expiresIn: TEMPSH_FILE_TTL,
    }, null, 2);

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `tempsh-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: resultContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    });
  } catch (error: any) {
    console.error('[tempsh] Upload error:', error.message);
    res.status(502).json({ error: { message: `Upload failed: ${error.message?.slice(0, 200)}` } });
  }
});

/**
 * POST /v1/close-channel
 */
app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) {
      res.status(400).json({ error: 'channelId required' });
      return;
    }
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

/**
 * POST /v1/admin/claim
 */
app.post('/v1/admin/claim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/admin/stats
 */
app.get('/v1/admin/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    pricingMode: config.pricingMode,
    pricePerUpload: formatUnits(config.pricePerUpload, 6),
    pricePerMb: formatUnits(config.pricePerMb, 6),
  });
});

/**
 * GET /v1/admin/vouchers
 */
app.get('/v1/admin/vouchers', (req, res) => {
  if (!requireAdmin(req, res)) return;
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

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    pricingMode: config.pricingMode,
    maxFileSizeMb: Math.floor(config.maxFileSizeBytes / (1024 * 1024)),
  });
});

async function start() {
  loadModels(config.markup, config.pricingMode);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Pricing mode: ${config.pricingMode}`);
    if (config.pricingMode === 'flat') {
      console.log(`Price per upload: $${formatUnits(config.pricePerUpload, 6)} USDC`);
    } else {
      console.log(`Price per MB: $${formatUnits(config.pricePerMb, 6)} USDC`);
    }
    console.log(`Max file size: ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB`);
    console.log(`File TTL on temp.sh: ${TEMPSH_FILE_TTL}`);
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
