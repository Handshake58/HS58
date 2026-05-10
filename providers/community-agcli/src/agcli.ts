import { execFile } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import type { AgcliResult } from './types.js';

const SAFE_ARG_PATTERN = /^[a-zA-Z0-9_\-.:,/=@ ]+$/;

function sanitizeArg(arg: string): string {
  if (!SAFE_ARG_PATTERN.test(arg)) {
    throw new Error(`Unsafe argument rejected: ${arg.slice(0, 50)}`);
  }
  return arg;
}

function execFilePromise(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string>; maxBuffer?: number } = {}
): Promise<AgcliResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout: opts.timeout ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      env: opts.env,
    }, (error, stdout, stderr) => {
      if (error && (error as any).killed) {
        reject(new Error(`agcli timed out after ${opts.timeout ?? 30_000}ms`));
        return;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to execute agcli: ${err.message}`));
    });
  });
}

// Fallback endpoints used when the primary endpoint refuses connections (exit code 10).
// Order: try Archive (onfinality, more permissive rate limits) before secondary mirrors.
const FALLBACK_ENDPOINTS = [
  'wss://bittensor-finney.api.onfinality.io/public-ws',
  'wss://entrypoint-finney.opentensor.ai:443',
];

function isConnectionError(result: AgcliResult): boolean {
  if (result.exitCode === 10) return true;
  const stderr = result.stderr || '';
  return /Failed to connect to subtensor node|connection refused|connection reset/i.test(stderr);
}

export async function execAgcli(
  agcliPath: string,
  args: string[],
  opts: {
    walletDir?: string;
    walletName?: string;
    timeout?: number;
    endpoint?: string;
    password?: string;
  } = {}
): Promise<AgcliResult> {
  const buildFullArgs = (endpoint?: string) => {
    const fullArgs = ['--output', 'json', '--batch', '--yes', ...args];
    if (endpoint) fullArgs.unshift('--endpoint', endpoint);
    if (opts.walletName) fullArgs.unshift('-w', opts.walletName);
    if (opts.walletDir) fullArgs.unshift('--wallet-dir', opts.walletDir);
    return fullArgs;
  };

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (opts.password) env['AGCLI_PASSWORD'] = opts.password;
  env['AGCLI_HOTKEY'] = 'default';

  // Build endpoint fallback chain: primary first, then any others.
  const primary = opts.endpoint;
  const candidates = primary
    ? [primary, ...FALLBACK_ENDPOINTS.filter(e => e !== primary)]
    : [undefined as string | undefined];

  let lastResult: AgcliResult | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const endpoint = candidates[i];
    const result = await execFilePromise(agcliPath, buildFullArgs(endpoint), {
      timeout: opts.timeout ?? 30_000,
      env,
    });

    // Success or non-connection error => return immediately. Only retry on connection failures.
    if (result.exitCode === 0 || !isConnectionError(result)) {
      return result;
    }

    lastResult = result;
    if (i < candidates.length - 1) {
      console.warn(`[agcli] endpoint ${endpoint} unreachable (exit ${result.exitCode}), trying fallback ${candidates[i + 1]}`);
    }
  }

  return lastResult!;
}

export async function withTempWallet<T>(
  walletData: { coldkeyMnemonic: string; hotkeyMnemonic?: string; name?: string },
  agcliPath: string,
  fn: (walletDir: string, walletName: string, password: string) => Promise<T>
): Promise<T> {
  const id = randomUUID().slice(0, 8);
  const walletDir = join(tmpdir(), `agcli-${id}`);
  const walletName = walletData.name || 'default';
  const tmpPassword = `tmp_${id}`;

  try {
    mkdirSync(walletDir, { recursive: true });

    const importResult = await execFilePromise(agcliPath, [
      '--wallet-dir', walletDir, '--yes',
      'wallet', 'import',
      '--name', walletName,
      '--mnemonic', walletData.coldkeyMnemonic,
      '--password', tmpPassword,
    ], { timeout: 15_000 });

    if (importResult.exitCode !== 0) {
      throw new Error(`wallet import failed: ${importResult.stderr.trim() || `exit ${importResult.exitCode}`}`);
    }

    if (walletData.hotkeyMnemonic) {
      const regenResult = await execFilePromise(agcliPath, [
        '--wallet-dir', walletDir, '-w', walletName, '--yes',
        'wallet', 'regen-hotkey',
        '--name', 'default',
        '--mnemonic', walletData.hotkeyMnemonic,
      ], { timeout: 15_000 });

      if (regenResult.exitCode !== 0) {
        throw new Error(`hotkey regen failed: ${regenResult.stderr.trim() || `exit ${regenResult.exitCode}`}`);
      }
    }

    return await fn(walletDir, walletName, tmpPassword);
  } finally {
    if (existsSync(walletDir)) {
      rmSync(walletDir, { recursive: true, force: true });
    }
  }
}

export function buildReadArgs(command: string[], input: Record<string, any>): string[] {
  const args = [...command];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (key === 'wallet' || key === 'password') continue;

    const flag = `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    const strValue = String(value);
    sanitizeArg(strValue);
    args.push(flag, strValue);
  }

  return args;
}

export function buildWriteArgs(
  command: string[],
  input: Record<string, any>,
): string[] {
  const args = [...command];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (['wallet', 'password', 'walletName'].includes(key)) continue;

    const flag = `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    const strValue = String(value);
    sanitizeArg(strValue);
    args.push(flag, strValue);
  }

  return args;
}

export function parseAgcliOutput(result: AgcliResult): any {
  if (result.exitCode !== 0) {
    let errorMessage = result.stderr.trim() || `agcli exited with code ${result.exitCode}`;
    try {
      const parsed = JSON.parse(result.stderr);
      errorMessage = parsed.message || parsed.hint || errorMessage;
      if (parsed.code) errorMessage = `[code ${parsed.code}] ${errorMessage}`;
    } catch {
      // stderr was not JSON
    }
    throw new Error(errorMessage);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return { success: true };
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return { output: stdout };
  }
}
