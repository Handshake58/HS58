/**
 * HS58-Resend Provider
 *
 * DRAIN payment gateway for the Resend email API.
 * Enables AI agents to send transactional emails with crypto micropayments.
 *
 * Emails are queued and sent asynchronously (1 per 5s) to respect Resend rate limits.
 * Payment is charged immediately on acceptance; the worker handles delivery.
 */

import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';
import { loadConfig, loadModels, getModelPricing, isModelSupported, getSupportedModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import type { SendEmailParams } from './types.js';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const resend = new Resend(config.resendApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// --- Email Queue ---
interface QueuedEmail {
  params: SendEmailParams;
  retried?: boolean;
}
const emailQueue: QueuedEmail[] = [];

// --- Rate Limiter (per channel, sliding window — limits enqueues, not sends) ---
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

// --- Worker: sends 1 email per minEmailIntervalMs ---
setInterval(async () => {
  if (emailQueue.length === 0) return;
  const job = emailQueue.shift()!;
  try {
    const { error } = await resend.emails.send({
      from: job.params.from!,
      to: job.params.to as string[],
      subject: job.params.subject,
      html: job.params.html,
      text: job.params.text,
      cc: job.params.cc as string[],
      bcc: job.params.bcc as string[],
      replyTo: job.params.reply_to as string,
      tags: job.params.tags,
    });
    if (error) {
      console.error(`[worker] Resend error: ${error.message}`);
      if (!job.retried) {
        job.retried = true;
        emailQueue.push(job);
      } else {
        console.error(`[worker] Dropped after 2 attempts: ${job.params.subject} → ${job.params.to}`);
      }
    }
  } catch (err: any) {
    console.error(`[worker] Send exception: ${err.message}`);
    if (!job.retried) {
      job.retried = true;
      emailQueue.push(job);
    } else {
      console.error(`[worker] Dropped after 2 attempts: ${job.params.subject} → ${job.params.to}`);
    }
  }
}, config.minEmailIntervalMs);

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

function validateEmailParams(params: any): { valid: boolean; error?: string; parsed?: SendEmailParams } {
  if (!params.to) {
    return { valid: false, error: '"to" field is required (string or array of strings)' };
  }
  if (!params.subject || typeof params.subject !== 'string') {
    return { valid: false, error: '"subject" field is required (string)' };
  }
  if (!params.html && !params.text) {
    return { valid: false, error: 'Either "html" or "text" field is required' };
  }

  const to = Array.isArray(params.to) ? params.to : [params.to];
  const cc = params.cc ? (Array.isArray(params.cc) ? params.cc : [params.cc]) : [];
  const bcc = params.bcc ? (Array.isArray(params.bcc) ? params.bcc : [params.bcc]) : [];
  const totalRecipients = to.length + cc.length + bcc.length;

  if (totalRecipients > config.maxRecipientsPerEmail) {
    return { valid: false, error: `Too many recipients (${totalRecipients}). Max: ${config.maxRecipientsPerEmail}` };
  }

  for (const addr of [...to, ...cc, ...bcc]) {
    if (typeof addr !== 'string' || !addr.includes('@')) {
      return { valid: false, error: `Invalid email address: ${addr}` };
    }
  }

  const bodySize = (params.html?.length ?? 0) + (params.text?.length ?? 0);
  if (bodySize > config.maxBodySizeBytes) {
    return { valid: false, error: `Email body too large (${bodySize} bytes). Max: ${config.maxBodySizeBytes}` };
  }

  const from = params.from || config.defaultFrom;

  if (config.allowedDomains.length > 0) {
    const fromDomain = from.includes('@') ? from.split('@').pop()?.replace('>', '') : '';
    if (fromDomain && !config.allowedDomains.includes(fromDomain)) {
      return { valid: false, error: `From domain "${fromDomain}" is not allowed. Allowed: ${config.allowedDomains.join(', ')}` };
    }
  }

  return {
    valid: true,
    parsed: {
      from,
      to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      reply_to: params.reply_to,
      tags: params.tags,
    },
  };
}

function enqueueAndRespond(
  emailParams: SendEmailParams,
  cost: bigint,
  totalCharged: bigint,
  deposit: bigint,
  channelId: string,
) {
  emailQueue.push({ params: emailParams });
  const position = emailQueue.length;
  const estimatedSendWithinSeconds = position * (config.minEmailIntervalMs / 1000);
  const remaining = deposit - totalCharged;

  return {
    headers: {
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': channelId,
    },
    body: { queued: true, position, estimatedSendWithinSeconds },
  };
}

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const modelId of getSupportedModels()) {
    const modelPricing = getModelPricing(modelId);
    if (modelPricing) {
      pricing[modelId] = {
        pricePerEmail: formatUnits(modelPricing.inputPer1k, 6),
        inputPer1kTokens: formatUnits(modelPricing.inputPer1k, 6),
        outputPer1kTokens: '0',
      };
    }
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'email',
    note: 'Flat rate per email sent via Resend API. Emails are queued and delivered asynchronously.',
    models: pricing,
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  const models = getSupportedModels().map(id => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: 'resend',
    description: 'Send transactional emails via Resend',
  }));

  res.json({ object: 'list', data: models });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const price = getModelPricing('resend/send-email');
  const priceStr = price ? formatUnits(price.inputPer1k, 6) : '?';

  res.type('text/plain').send(`# HS58-Resend Provider — Agent Instructions

Send transactional emails via the Resend API, paid with DRAIN micropayments.
Emails are queued and delivered asynchronously (~1 every ${config.minEmailIntervalMs / 1000}s).

## Quick Start

1. Open a payment channel: drain_open_channel
2. Send an email: drain_chat with model "resend/send-email"
3. The user message must be valid JSON containing the email parameters
4. Response confirms queued status with estimated delivery time

## Email Parameters

Required fields:
- "to" (string or array) — recipient address(es)
- "subject" (string) — email subject line
- "html" or "text" (string) — email body (at least one required)

Optional fields:
- "from" (string) — sender address (default: ${config.defaultFrom})
- "cc" (string or array) — carbon copy recipients
- "bcc" (string or array) — blind carbon copy recipients
- "reply_to" (string) — reply-to address

## Example Request

model: "resend/send-email"
messages: [
  {
    "role": "user",
    "content": {
      "to": ["user@example.com"],
      "subject": "Order Confirmation",
      "html": "<h1>Thank you!</h1><p>Your order has been placed.</p>"
    }
  }
]

Note: The content field must be a JSON string, not a nested object.
Actual payload: "content": "{\\"to\\": [\\"user@example.com\\"], \\"subject\\": \\"Order Confirmation\\", \\"html\\": \\"<h1>Thank you!</h1>\\"}"

## Limits

- Max ${config.maxRecipientsPerEmail} recipients per email (to + cc + bcc combined)
- Max ${Math.round(config.maxBodySizeBytes / 1024)} KB email body size
- Max ${config.rateLimitPerMinute} emails per minute per payment channel

## Pricing

$${priceStr} USDC per email (flat rate, charged on acceptance).

## Alternative: Direct API

POST /v1/emails/send — same JSON body (not wrapped in messages), requires X-DRAIN-Voucher header.
`);
});

/**
 * POST /v1/emails/send
 *
 * Direct email sending endpoint. Validates, charges immediately, queues for async delivery.
 */
app.post('/v1/emails/send', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({ error: { message: 'Payment required. Include X-DRAIN-Voucher header.' } });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({ error: { message: 'Invalid voucher format.' } });
    return;
  }

  const validation = validateEmailParams(req.body);
  if (!validation.valid) {
    res.status(400).json({ error: { message: validation.error } });
    return;
  }

  if (!checkRateLimit(voucher.channelId)) {
    res.status(429).json({
      error: { message: `Rate limit exceeded. Max ${config.rateLimitPerMinute} emails/min per channel.` },
    });
    return;
  }

  const cost = config.pricePerEmail;
  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

  const totalCharged = voucherValidation.channel!.totalCharged + cost;
  const result = enqueueAndRespond(
    validation.parsed!, cost, totalCharged, voucherValidation.channel!.deposit, voucher.channelId,
  );

  res.set(result.headers);
  res.json(result.body);
});

/**
 * POST /v1/chat/completions
 *
 * Chat-wrapper for email sending. Validates, charges immediately, queues for async delivery.
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
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
    res.status(400).json({
      error: { message: `Model "${modelId}" not available. Use: ${getSupportedModels().join(', ')}` },
    });
    return;
  }

  if (!checkRateLimit(voucher.channelId)) {
    res.status(429).json({
      error: { message: `Rate limit exceeded. Max ${config.rateLimitPerMinute} emails/min per channel.` },
    });
    return;
  }

  const cost = config.pricePerEmail;
  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && { required: cost.toString() }),
    });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send email parameters as JSON in the user message.' },
    });
    return;
  }

  let emailInput: any;
  try {
    emailInput = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON with email parameters. ' +
          'Required: {"to": ["..."], "subject": "...", "html": "..."} or {"to": ["..."], "subject": "...", "text": "..."}',
      },
    });
    return;
  }

  const validation = validateEmailParams(emailInput);
  if (!validation.valid) {
    res.status(400).json({ error: { message: validation.error } });
    return;
  }

  drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

  const totalCharged = voucherValidation.channel!.totalCharged + cost;
  const result = enqueueAndRespond(
    validation.parsed!, cost, totalCharged, voucherValidation.channel!.deposit, voucher.channelId,
  );

  res.set(result.headers);
  res.json({
    id: `resend-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(result.body, null, 2) },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
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
    emailQueueLength: emailQueue.length,
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

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    defaultFrom: config.defaultFrom,
    emailQueueLength: emailQueue.length,
  });
});

async function start() {
  loadModels(config.markup);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Default from: ${config.defaultFrom}`);
    console.log(`Price per email: $${(Number(config.pricePerEmail) / 1_000_000).toFixed(4)} USDC`);
    console.log(`Email queue worker: 1 email per ${config.minEmailIntervalMs / 1000}s`);
    if (config.allowedDomains.length > 0) {
      console.log(`Allowed domains: ${config.allowedDomains.join(', ')}`);
    }
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
