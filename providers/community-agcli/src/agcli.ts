import { execFile } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
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

export function execAgcli(
  agcliPath: string,
  args: string[],
  opts: {
    walletDir?: string;
    timeout?: number;
    endpoint?: string;
    password?: string;
  } = {}
): Promise<AgcliResult> {
  const fullArgs = ['--output', 'json', '--batch', '--yes', ...args];

  if (opts.endpoint) {
    fullArgs.unshift('--endpoint', opts.endpoint);
  }
  if (opts.walletDir) {
    fullArgs.unshift('--wallet-dir', opts.walletDir);
  }

  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (opts.password) {
    env['AGCLI_PASSWORD'] = opts.password;
  }

  const timeout = opts.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = execFile(
      agcliPath,
      fullArgs,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        if (error && (error as any).killed) {
          reject(new Error(`agcli timed out after ${timeout}ms`));
          return;
        }

        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      }
    );

    child.on('error', (err) => {
      reject(new Error(`Failed to execute agcli: ${err.message}`));
    });
  });
}

export async function withTempWallet<T>(
  walletData: { coldkey: string; hotkey?: string; name?: string },
  fn: (walletDir: string, walletName: string) => Promise<T>
): Promise<T> {
  const id = randomUUID().slice(0, 8);
  const walletDir = join(tmpdir(), `agcli-${id}`);
  const walletName = walletData.name || 'agent';
  const coldkeyDir = join(walletDir, walletName, 'coldkey');
  const hotkeyDir = join(walletDir, walletName, 'hotkeys');

  try {
    mkdirSync(coldkeyDir, { recursive: true });
    writeFileSync(join(coldkeyDir, 'coldkey'), walletData.coldkey, { mode: 0o600 });

    if (walletData.hotkey) {
      mkdirSync(hotkeyDir, { recursive: true });
      writeFileSync(join(hotkeyDir, 'default'), walletData.hotkey, { mode: 0o600 });
    }

    return await fn(walletDir, walletName);
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
  walletName: string
): string[] {
  const args = [...command, '--wallet', walletName];

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
      errorMessage = parsed.error || parsed.message || errorMessage;
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
