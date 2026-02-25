/**
 * HS58-Faster-Whisper Provider
 * DRAIN payment proxy for Faster-Whisper speech-to-text via speaches server.
 */

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import FormData from 'form-data';
import { loadConfig, calculateCost, getModelPricing, isModelSupported, getSupportedModels, loadModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import type { TranscriptionResult } from './types.js';

const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/wav',
  'audio/webm', 'audio/flac', 'audio/ogg', 'audio/x-flac',
  'video/mp4', 'video/webm', 'application/octet-stream',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.flac', '.ogg',
]);

const config = loadConfig();
const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max (OpenAI limit)
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ALLOWED_AUDIO_TYPES.has(file.mimetype) || (ext && ALLOWED_EXTENSIONS.has(ext))) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype}`));
    }
  },
});

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, { pricePerSecond: string; pricePerMinute: string }> = {};

  for (const model of getSupportedModels()) {
    const modelPricing = getModelPricing(model);
    if (modelPricing) {
      const perSec = modelPricing.pricePerSecond;
      pricing[model] = {
        pricePerSecond: formatUnits(perSec, 6),
        pricePerMinute: formatUnits(perSec * 60n, 6),
      };
    }
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    billingUnit: 'second',
    markup: `${(config.markup - 1) * 100}%`,
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
    owned_by: 'systran',
    type: 'speech-to-text',
  }));

  res.json({ object: 'list', data: models });
});

/**
 * GET /v1/docs
 * Agent instructions for this non-standard provider.
 */
app.get('/v1/docs', (_req, res) => {
  const models = getSupportedModels();
  const pricingLines = models.map(m => {
    const p = getModelPricing(m);
    if (!p) return '';
    const perMin = formatUnits(p.pricePerSecond * 60n, 6);
    return `| ${m} | $${formatUnits(p.pricePerSecond, 6)}/sec | $${perMin}/min |`;
  }).join('\n');

  res.type('text/markdown').send(`# HS58-Faster-Whisper — Agent Instructions

This is a NON-STANDARD provider. It provides speech-to-text transcription, not LLM chat. Read these docs carefully.

## How to Use

Use the standard \`/v1/chat/completions\` endpoint via \`drain_chat\`. The last user message must contain a JSON object (NOT natural language).

1. Open a payment channel: \`drain_open_channel\` to this provider
2. Call \`drain_chat\` with:
   - model: one of the available models (see below)
   - messages: ONE user message containing a JSON object with the audio URL

## Available Models

${models.map(m => `- ${m}`).join('\n')}

Default: \`${config.defaultModel}\`

## Input Parameters (JSON in user message content)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| url | string | YES | Public URL to an audio file (mp3, wav, m4a, flac, ogg, webm, mp4) |
| language | string | no | ISO 639-1 code: "en", "de", "fr", "es", "ja", etc. Auto-detected if omitted |
| response_format | string | no | "text" (default), "verbose", "srt", "vtt" |

## Request Examples

### Transcribe an audio file (simplest)

drain_chat parameters:
  channelId: (your channel)
  model: "Systran/faster-whisper-base"
  messages: [{"role": "user", "content": "{\\"url\\": \\"https://example.com/audio.mp3\\"}"}]

### Transcribe with language hint

drain_chat parameters:
  channelId: (your channel)
  model: "Systran/faster-whisper-base"
  messages: [{"role": "user", "content": "{\\"url\\": \\"https://example.com/meeting.wav\\", \\"language\\": \\"de\\"}"}]

### Get subtitles (SRT format)

drain_chat parameters:
  channelId: (your channel)
  model: "Systran/faster-whisper-base"
  messages: [{"role": "user", "content": "{\\"url\\": \\"https://example.com/video.mp4\\", \\"response_format\\": \\"srt\\"}"}]

## Response Format

The assistant message content is a JSON object:

### Default (response_format: "text")
\`\`\`json
{"text": "Hello, this is a transcription of the audio.", "duration": 42.5, "language": "en"}
\`\`\`

### Verbose (response_format: "verbose")
\`\`\`json
{"text": "Hello...", "duration": 42.5, "language": "en", "segments": [{"id": 0, "start": 0.0, "end": 2.5, "text": "Hello..."}]}
\`\`\`

### SRT/VTT (response_format: "srt" or "vtt")
\`\`\`json
{"text": "1\\n00:00:00,000 --> 00:00:02,500\\nHello...\\n", "duration": 42.5, "language": "en"}
\`\`\`

**Instructions:** The \`text\` field contains the transcription or subtitle content. The \`duration\` field is the audio length in seconds.

## Pricing

Billed per second of audio duration.

| Model | Per Second | Per Minute |
|-------|-----------|------------|
${pricingLines}

## Supported Audio Formats

mp3, mp4, mpeg, mpga, m4a, wav, webm, flac, ogg — Max file size: 25 MB

## Important Notes

- Audio is downloaded from the provided URL, transcribed privately, and never stored.
- Cost is calculated after transcription based on actual audio duration.
- 100+ languages supported with auto-detection.
- Use smaller models (tiny) for speed, larger models (medium) for accuracy.
`);
});

/**
 * POST /v1/chat/completions
 * DRAIN-compatible wrapper: agent sends audio URL in chat message,
 * provider downloads, transcribes, and returns text as assistant message.
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;

  if (!voucherHeader) {
    res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: {
        message: 'X-DRAIN-Voucher header required',
        type: 'payment_required',
        code: 'voucher_required',
      },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: {
        message: 'Invalid X-DRAIN-Voucher format',
        type: 'payment_required',
        code: 'invalid_voucher_format',
      },
    });
    return;
  }

  // Parse user message as JSON input
  const messages = req.body.messages as Array<{ role: string; content: string }> | undefined;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: {
        message: 'Missing user message. Send a JSON object with "url" field: {"url": "https://example.com/audio.mp3"}',
        type: 'invalid_request_error',
        code: 'missing_input',
      },
    });
    return;
  }

  let input: { url?: string; language?: string; response_format?: string };
  try {
    input = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be a JSON object: {"url": "https://example.com/audio.mp3", "language": "en"}',
        type: 'invalid_request_error',
        code: 'invalid_json',
      },
    });
    return;
  }

  if (!input.url) {
    res.status(400).json({
      error: {
        message: 'Missing "url" field. Provide a public URL to an audio file: {"url": "https://example.com/audio.mp3"}',
        type: 'invalid_request_error',
        code: 'missing_url',
      },
    });
    return;
  }

  const model = (req.body.model as string) || config.defaultModel;
  if (!isModelSupported(model)) {
    res.status(400).json({
      error: {
        message: `Model '${model}' not supported. Available: ${getSupportedModels().join(', ')}`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
      },
    });
    return;
  }

  const pricing = getModelPricing(model)!;
  const estimatedMinCost = calculateCost(pricing, 5);

  const validation = await drainService.validateVoucher(voucher, estimatedMinCost);
  if (!validation.valid) {
    const errorHeaders: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      errorHeaders['X-DRAIN-Required'] = estimatedMinCost.toString();
      errorHeaders['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    res.status(402).set(errorHeaders).json({
      error: {
        message: `Payment validation failed: ${validation.error}`,
        type: 'payment_required',
        code: validation.error,
      },
    });
    return;
  }

  const channelState = validation.channel!;

  try {
    // 1. Download audio from URL
    const audioResponse = await fetch(input.url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'HS58-Faster-Whisper/1.0' },
    });

    if (!audioResponse.ok) {
      res.status(400).json({
        error: {
          message: `Failed to download audio from URL: HTTP ${audioResponse.status}`,
          type: 'invalid_request_error',
          code: 'download_failed',
        },
      });
      return;
    }

    const contentLength = parseInt(audioResponse.headers.get('content-length') || '0');
    if (contentLength > 25 * 1024 * 1024) {
      res.status(400).json({
        error: {
          message: 'Audio file too large. Maximum size: 25 MB.',
          type: 'invalid_request_error',
          code: 'file_too_large',
        },
      });
      return;
    }

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const contentType = audioResponse.headers.get('content-type') || 'application/octet-stream';
    const urlPath = new URL(input.url).pathname;
    const filename = urlPath.split('/').pop() || 'audio.mp3';

    // 2. Forward to speaches
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType });
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');

    if (input.language) {
      formData.append('language', input.language);
    }

    const whisperHeaders: Record<string, string> = { ...formData.getHeaders() };
    if (config.whisperApiKey) {
      whisperHeaders['Authorization'] = `Bearer ${config.whisperApiKey}`;
    }

    const whisperResponse = await fetch(`${config.whisperServerUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: whisperHeaders,
      body: formData.getBuffer(),
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      console.error('Speaches API error:', whisperResponse.status, errorText);
      res.status(502).json({
        error: {
          message: `Transcription service error: ${whisperResponse.status}`,
          type: 'api_error',
          code: 'whisper_error',
        },
      });
      return;
    }

    const verboseResult = await whisperResponse.json() as TranscriptionResult;
    const durationSeconds = verboseResult.duration || 0;

    // 3. Calculate cost
    const actualCost = calculateCost(pricing, durationSeconds);
    drainService.storeVoucher(voucher, channelState, actualCost);
    const remaining = channelState.deposit - channelState.totalCharged - actualCost;

    // 4. Format output based on requested format
    const fmt = input.response_format || 'text';
    let outputContent: Record<string, unknown>;

    switch (fmt) {
      case 'verbose':
        outputContent = {
          text: verboseResult.text,
          duration: durationSeconds,
          language: verboseResult.language,
          segments: verboseResult.segments,
        };
        break;
      case 'srt':
        outputContent = {
          text: segmentsToSrt(verboseResult),
          duration: durationSeconds,
          language: verboseResult.language,
        };
        break;
      case 'vtt':
        outputContent = {
          text: segmentsToVtt(verboseResult),
          duration: durationSeconds,
          language: verboseResult.language,
        };
        break;
      default:
        outputContent = {
          text: verboseResult.text,
          duration: durationSeconds,
          language: verboseResult.language,
        };
        break;
    }

    // 5. Return OpenAI chat completion format
    res.set({
      'X-DRAIN-Cost': actualCost.toString(),
      'X-DRAIN-Total': (channelState.totalCharged + actualCost).toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    }).json({
      id: `whisper-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(outputContent),
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    console.error('Transcription error:', error);
    const message = error instanceof Error ? error.message : 'Transcription failed';
    res.status(500).json({
      error: {
        message,
        type: 'api_error',
        code: 'transcription_error',
      },
    });
  }
});

/**
 * POST /v1/audio/transcriptions
 * OpenAI-compatible audio transcription with DRAIN payments.
 */
app.post('/v1/audio/transcriptions', upload.single('file'), async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string | undefined;

  if (!voucherHeader) {
    res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: {
        message: 'X-DRAIN-Voucher header required',
        type: 'payment_required',
        code: 'voucher_required',
      },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: {
        message: 'Invalid X-DRAIN-Voucher format',
        type: 'payment_required',
        code: 'invalid_voucher_format',
      },
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({
      error: {
        message: 'No audio file provided. Send as multipart/form-data with field name "file".',
        type: 'invalid_request_error',
        code: 'missing_file',
      },
    });
    return;
  }

  const model = (req.body.model as string) || config.defaultModel;
  if (!isModelSupported(model)) {
    res.status(400).json({
      error: {
        message: `Model '${model}' not supported. Available: ${getSupportedModels().join(', ')}`,
        type: 'invalid_request_error',
        code: 'model_not_supported',
      },
    });
    return;
  }

  const pricing = getModelPricing(model)!;
  const requestedFormat = (req.body.response_format as string) || 'json';

  // Estimate minimum cost: assume at least 5 seconds of audio
  const estimatedMinCost = calculateCost(pricing, 5);

  const validation = await drainService.validateVoucher(voucher, estimatedMinCost);

  if (!validation.valid) {
    const errorHeaders: Record<string, string> = {
      'X-DRAIN-Error': validation.error!,
    };

    if (validation.error === 'insufficient_funds' && validation.channel) {
      errorHeaders['X-DRAIN-Required'] = estimatedMinCost.toString();
      errorHeaders['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }

    res.status(402).set(errorHeaders).json({
      error: {
        message: `Payment validation failed: ${validation.error}`,
        type: 'payment_required',
        code: validation.error,
      },
    });
    return;
  }

  const channelState = validation.channel!;

  try {
    // Always request verbose_json from speaches to get duration for billing
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    formData.append('model', model);
    formData.append('response_format', 'verbose_json');

    if (req.body.language) {
      formData.append('language', req.body.language);
    }
    if (req.body.temperature) {
      formData.append('temperature', req.body.temperature);
    }
    if (req.body.prompt) {
      formData.append('prompt', req.body.prompt);
    }

    const headers: Record<string, string> = {
      ...formData.getHeaders(),
    };
    if (config.whisperApiKey) {
      headers['Authorization'] = `Bearer ${config.whisperApiKey}`;
    }

    const whisperResponse = await fetch(`${config.whisperServerUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: formData.getBuffer(),
    });

    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      console.error('Speaches API error:', whisperResponse.status, errorText);
      res.status(502).json({
        error: {
          message: `Transcription service error: ${whisperResponse.status}`,
          type: 'api_error',
          code: 'whisper_error',
        },
      });
      return;
    }

    const verboseResult = await whisperResponse.json() as TranscriptionResult;
    const durationSeconds = verboseResult.duration || 0;

    // Calculate actual cost based on real audio duration
    const actualCost = calculateCost(pricing, durationSeconds);

    drainService.storeVoucher(voucher, channelState, actualCost);

    const remaining = channelState.deposit - channelState.totalCharged - actualCost;

    const drainHeaders = {
      'X-DRAIN-Cost': actualCost.toString(),
      'X-DRAIN-Total': (channelState.totalCharged + actualCost).toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
      'X-DRAIN-Duration': durationSeconds.toFixed(2),
    };

    // Format response based on requested format
    switch (requestedFormat) {
      case 'text':
        res.set(drainHeaders).type('text/plain').send(verboseResult.text);
        break;

      case 'verbose_json':
        res.set(drainHeaders).json(verboseResult);
        break;

      case 'srt':
        res.set(drainHeaders).type('text/plain').send(segmentsToSrt(verboseResult));
        break;

      case 'vtt':
        res.set(drainHeaders).type('text/vtt').send(segmentsToVtt(verboseResult));
        break;

      case 'json':
      default:
        res.set(drainHeaders).json({ text: verboseResult.text });
        break;
    }
  } catch (error) {
    console.error('Transcription error:', error);
    const message = error instanceof Error ? error.message : 'Transcription failed';
    res.status(500).json({
      error: {
        message,
        type: 'api_error',
        code: 'transcription_error',
      },
    });
  }
});

/**
 * POST /v1/admin/claim
 */
app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.query.force === 'true';
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({
      success: true,
      claimed: txHashes.length,
      transactions: txHashes,
      forced: forceAll,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Claim failed',
    });
  }
});

/**
 * GET /v1/admin/stats
 */
app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    ...stats,
    totalEarned: formatUnits(stats.totalEarned, 6) + ' USDC',
    claimThreshold: formatUnits(config.claimThreshold, 6) + ' USDC',
  });
});

/**
 * GET /v1/admin/vouchers
 */
app.get('/v1/admin/vouchers', (_req, res) => {
  const unclaimed = storage.getUnclaimedVouchers();
  const highest = storage.getHighestVoucherPerChannel();

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    unclaimedCount: unclaimed.length,
    channels: Array.from(highest.entries()).map(([channelId, v]) => ({
      channelId,
      amount: formatUnits(v.amount, 6) + ' USDC',
      amountRaw: v.amount.toString(),
      nonce: v.nonce.toString(),
      consumer: v.consumer,
      claimed: v.claimed,
      receivedAt: new Date(v.receivedAt).toISOString(),
    })),
  });
});

/**
 * GET /health
 */
app.get('/health', async (_req, res) => {
  let whisperOk = false;
  try {
    const headers: Record<string, string> = {};
    if (config.whisperApiKey) headers['Authorization'] = `Bearer ${config.whisperApiKey}`;
    const check = await fetch(`${config.whisperServerUrl}/health`, { headers, signal: AbortSignal.timeout(5000) });
    whisperOk = check.ok;
  } catch { /* speaches server unreachable */ }

  res.status(whisperOk ? 200 : 503).json({
    status: whisperOk ? 'ok' : 'degraded',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    whisperServer: whisperOk ? 'connected' : 'unreachable',
  });
});

// === Subtitle formatters ===

function formatTimestamp(seconds: number, useDot = false): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  const sep = useDot ? '.' : ',';
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${String(ms).padStart(3, '0')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function segmentsToSrt(result: TranscriptionResult): string {
  if (!result.segments?.length) {
    return `1\n00:00:00,000 --> 00:00:01,000\n${result.text}\n`;
  }
  return result.segments.map((seg, i) =>
    `${i + 1}\n${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}\n${seg.text.trim()}\n`
  ).join('\n');
}

function segmentsToVtt(result: TranscriptionResult): string {
  if (!result.segments?.length) {
    return `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${result.text}\n`;
  }
  const cues = result.segments.map(seg =>
    `${formatTimestamp(seg.start, true)} --> ${formatTimestamp(seg.end, true)}\n${seg.text.trim()}`
  ).join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

// === Start server ===

async function start() {
  await loadModels(config.whisperServerUrl, config.whisperApiKey, config.markup);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`${config.providerName} | ${getSupportedModels().length} models | ${(config.markup - 1) * 100}% markup | http://${config.host}:${config.port}`);
    console.log(`Whisper server: ${config.whisperServerUrl}`);
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min, buffer ${config.autoClaimBufferSeconds}s`);
  });
}

start().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
