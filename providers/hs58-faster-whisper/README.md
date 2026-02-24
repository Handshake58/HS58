# HS58-Faster-Whisper

Speech-to-Text provider for the DRAIN Protocol, powered by [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) via [speaches](https://github.com/speaches-ai/speaches).

## Architecture

Two Railway services work together:

1. **This provider** (TypeScript/Express) — handles DRAIN payments, voucher validation, and billing
2. **Speaches server** (Docker) — runs faster-whisper for actual transcription

```
Client → [Audio + DRAIN Voucher] → HS58 Provider → [Audio] → Speaches Server
                                        ↓                          ↓
                                   Polygon Chain            faster-whisper
                                   (validation)            (transcription)
```

## Pricing

Billed per second of audio duration. Prices include configured markup (default 50%).

| Model | Base Price/sec | With 50% Markup | Per Minute |
|-------|---------------|-----------------|------------|
| tiny | $0.00004 | $0.00006 | $0.0036 |
| base (default) | $0.00006 | $0.00009 | $0.0054 |
| small | $0.00008 | $0.00012 | $0.0072 |
| medium | $0.00012 | $0.00018 | $0.0108 |

## Quick Start

### 1. Deploy Speaches on Railway

Use the [Railway Faster-Whisper template](https://railway.com/deploy/faster-whisper) or deploy the Docker image manually:

```
Image: ghcr.io/speaches-ai/speaches:0.9.0-rc.3-cpu
Volume: /home/ubuntu/.cache/huggingface/hub
```

### 2. Deploy This Provider

```bash
npm install
cp env.example .env
# Edit .env with your settings
npm run dev
```

### 3. Register with Marketplace

The provider registers with `category: "audio"` at the DRAIN marketplace.

## API

### POST /v1/audio/transcriptions

OpenAI-compatible audio transcription endpoint.

```bash
curl -X POST http://localhost:3000/v1/audio/transcriptions \
  -H "X-DRAIN-Voucher: {channelId, amount, nonce, signature}" \
  -F file=@audio.mp3 \
  -F model=Systran/faster-whisper-base \
  -F language=en \
  -F response_format=json
```

**Parameters:**
- `file` (required) — Audio file (mp3, mp4, m4a, wav, webm, flac, ogg)
- `model` — Whisper model (default: `Systran/faster-whisper-base`)
- `language` — ISO 639-1 code (optional, auto-detected if omitted)
- `response_format` — `json`, `text`, `verbose_json`, `srt`, `vtt` (default: `json`)
- `temperature` — Sampling temperature (optional)
- `prompt` — Context hint for the model (optional)

**Response Headers:**
- `X-DRAIN-Cost` — Cost of this transcription (USDC wei)
- `X-DRAIN-Total` — Total charged in this channel
- `X-DRAIN-Remaining` — Remaining channel balance
- `X-DRAIN-Channel` — Channel ID
- `X-DRAIN-Duration` — Audio duration in seconds

### GET /v1/pricing

Returns pricing for all available models.

### GET /v1/models

Lists available Whisper models.

### GET /health

Health check — also verifies speaches server connectivity.

### Admin Endpoints

- `POST /v1/admin/claim` — Trigger payment claims
- `GET /v1/admin/stats` — Provider statistics
- `GET /v1/admin/vouchers` — Pending vouchers

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVIDER_PRIVATE_KEY` | Yes | — | Polygon wallet private key |
| `WHISPER_SERVER_URL` | No | `http://localhost:8100` | Speaches server URL |
| `WHISPER_API_KEY` | No | — | Speaches API key |
| `DEFAULT_MODEL` | No | `Systran/faster-whisper-base` | Default transcription model |
| `POLYGON_RPC_URL` | Recommended | Public RPC | Reliable Polygon RPC |
| `PORT` | No | `3000` | Server port |
| `CHAIN_ID` | No | `137` | Polygon (137) or Amoy testnet (80002) |
| `MARKUP_PERCENT` | No | `50` | Price markup percentage |
| `CLAIM_THRESHOLD` | No | `1000000` | Min USDC-wei to trigger claim |
| `STORAGE_PATH` | No | `./data/vouchers.json` | Voucher storage path |

## Supported Audio Formats

mp3, mp4, mpeg, mpga, m4a, wav, webm, flac, ogg

Max file size: 25 MB
