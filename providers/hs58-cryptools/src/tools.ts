import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { getAddress } from 'viem';
import QRCode from 'qrcode';
import { evaluate } from 'mathjs';
import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';
import type { ToolHandler } from './types.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function parseInput(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw.trim(); }
}

// 1. Hash
const hash: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const data = typeof input === 'string' ? input : input.data;
  const algorithm = (typeof input === 'object' && input.algorithm) || 'sha256';
  if (!data && data !== '') return JSON.stringify({ error: 'data required' });

  const supported = ['sha256', 'sha512', 'md5', 'sha1'];
  if (!supported.includes(algorithm)) {
    return JSON.stringify({ error: `Unsupported algorithm. Supported: ${supported.join(', ')}` });
  }

  const result = crypto.createHash(algorithm).update(data).digest('hex');
  return JSON.stringify({ algorithm, hash: result });
};

// 2. Hash Verify
const hashVerify: ToolHandler = (raw) => {
  const input = parseInput(raw);
  if (typeof input !== 'object') return JSON.stringify({ error: 'JSON input required: {"data","hash","algorithm"}' });

  const { data, hash: expected, algorithm = 'sha256' } = input;
  if (data === undefined || !expected) return JSON.stringify({ error: 'data and hash required' });

  const actual = crypto.createHash(algorithm).update(data).digest('hex');
  return JSON.stringify({ match: actual === expected.toLowerCase() });
};

// 3. HMAC
const hmac: ToolHandler = (raw) => {
  const input = parseInput(raw);
  if (typeof input !== 'object') return JSON.stringify({ error: 'JSON input required: {"data","key","algorithm"}' });

  const { data, key, algorithm = 'sha256' } = input;
  if (data === undefined || !key) return JSON.stringify({ error: 'data and key required' });

  const result = crypto.createHmac(algorithm, key).update(data).digest('hex');
  return JSON.stringify({ algorithm, hmac: result });
};

// 4. UUID
const uuid: ToolHandler = () => {
  return JSON.stringify({ uuid: crypto.randomUUID() });
};

// 5. Random Bytes
const randomBytes: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const length = (typeof input === 'object' && input.length) || 32;
  const encoding: 'hex' | 'base64' = (typeof input === 'object' && input.encoding) || 'hex';

  if (length < 1 || length > 1024) return JSON.stringify({ error: 'length must be 1-1024' });

  const bytes = crypto.randomBytes(length);
  return JSON.stringify({
    bytes: encoding === 'base64' ? bytes.toString('base64') : bytes.toString('hex'),
    encoding,
    length,
  });
};

// 6. Password Generator
const password: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const length = Math.min(Math.max((typeof input === 'object' && input.length) || 16, 4), 128);
  const useUpper = (typeof input === 'object' && input.uppercase !== undefined) ? input.uppercase : true;
  const useLower = (typeof input === 'object' && input.lowercase !== undefined) ? input.lowercase : true;
  const useNumbers = (typeof input === 'object' && input.numbers !== undefined) ? input.numbers : true;
  const useSymbols = (typeof input === 'object' && input.symbols !== undefined) ? input.symbols : true;

  let charset = '';
  if (useUpper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (useLower) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (useNumbers) charset += '0123456789';
  if (useSymbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }

  return JSON.stringify({ password: result });
};

// 7. ETH Checksum
const ethChecksum: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const addr = typeof input === 'string' ? input : input.address;
  if (!addr) return JSON.stringify({ error: 'address required' });

  try {
    const checksummed = getAddress(addr);
    return JSON.stringify({ address: checksummed, valid: true });
  } catch (e: any) {
    return JSON.stringify({ address: addr, valid: false, error: e.message });
  }
};

// 8. JWT Decode
const jwtDecode: ToolHandler = (raw) => {
  const input = parseInput(raw);
  const token = typeof input === 'string' ? input : input.token || input.jwt;
  if (!token) return JSON.stringify({ error: 'JWT string required' });

  const parts = token.split('.');
  if (parts.length < 2) return JSON.stringify({ error: 'Invalid JWT format (expected header.payload.signature)' });

  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return JSON.stringify({ header, payload });
  } catch (e: any) {
    return JSON.stringify({ error: `Failed to decode JWT: ${e.message}` });
  }
};

// 9. QR Code
const qrcode: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const data = typeof input === 'string' ? input : input.data;
  if (!data) return JSON.stringify({ error: 'data required' });
  if (data.length > 2048) return JSON.stringify({ error: 'data too long (max 2048 chars)' });

  try {
    const svg = await QRCode.toString(data, { type: 'svg' });
    return JSON.stringify({ svg });
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
};

// 10. Gzip compress/decompress
const gzipTool: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  if (typeof input !== 'object') return JSON.stringify({ error: 'JSON input required: {"data","action":"compress|decompress"}' });

  const { data, action } = input;
  if (!data && data !== '') return JSON.stringify({ error: 'data required' });
  if (!action || !['compress', 'decompress'].includes(action)) {
    return JSON.stringify({ error: 'action must be "compress" or "decompress"' });
  }

  try {
    if (action === 'compress') {
      const compressed = await gzip(Buffer.from(data, 'utf-8'));
      return JSON.stringify({
        data: compressed.toString('base64'),
        action: 'compressed',
        originalSize: Buffer.byteLength(data, 'utf-8'),
        compressedSize: compressed.length,
      });
    } else {
      const buf = Buffer.from(data, 'base64');
      if (buf.length > 1_000_000) return JSON.stringify({ error: 'compressed input too large (max 1MB)' });
      const decompressed = await gunzip(buf);
      if (decompressed.length > 10_000_000) return JSON.stringify({ error: 'decompressed output too large (max 10MB)' });
      return JSON.stringify({
        data: decompressed.toString('utf-8'),
        action: 'decompressed',
        decompressedSize: decompressed.length,
      });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
};

// 11. CSV <-> JSON
const csvJson: ToolHandler = (raw) => {
  const input = parseInput(raw);
  if (typeof input !== 'object') return JSON.stringify({ error: 'JSON input required: {"data","direction":"csv-to-json|json-to-csv"}' });

  const { data, direction } = input;
  if (!data) return JSON.stringify({ error: 'data required' });
  if (!direction || !['csv-to-json', 'json-to-csv'].includes(direction)) {
    return JSON.stringify({ error: 'direction must be "csv-to-json" or "json-to-csv"' });
  }

  try {
    if (direction === 'csv-to-json') {
      const records = csvParse(data, { columns: true, skip_empty_lines: true });
      return JSON.stringify({ data: records, rows: records.length });
    } else {
      const arr = Array.isArray(data) ? data : [data];
      const csv = csvStringify(arr, { header: true });
      return JSON.stringify({ data: csv, rows: arr.length });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
};

// 12. Math Eval (sandboxed: input length limit + execution timeout)
const mathEval: ToolHandler = async (raw) => {
  const input = parseInput(raw);
  const expression = typeof input === 'string' ? input : input.expression;
  if (!expression) return JSON.stringify({ error: 'expression required' });
  if (expression.length > 500) return JSON.stringify({ error: 'expression too long (max 500 chars)' });

  const blocked = ['import', 'createUnit', 'evaluate', 'parse', 'compile', 'chain', 'reviver'];
  const lower = expression.toLowerCase();
  for (const word of blocked) {
    if (lower.includes(word)) return JSON.stringify({ error: `forbidden function: ${word}` });
  }

  try {
    const result = await Promise.race([
      Promise.resolve(evaluate(expression)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluation timed out (2s)')), 2000)),
    ]);
    return JSON.stringify({ expression, result: typeof result === 'object' ? String(result) : result });
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }
};

export const toolRegistry = new Map<string, ToolHandler>([
  ['cryptools/hash', hash],
  ['cryptools/hash-verify', hashVerify],
  ['cryptools/hmac', hmac],
  ['cryptools/uuid', uuid],
  ['cryptools/random-bytes', randomBytes],
  ['cryptools/password', password],
  ['cryptools/eth-checksum', ethChecksum],
  ['cryptools/jwt-decode', jwtDecode],
  ['cryptools/qrcode', qrcode],
  ['cryptools/gzip', gzipTool],
  ['cryptools/csv-json', csvJson],
  ['cryptools/math-eval', mathEval],
]);
