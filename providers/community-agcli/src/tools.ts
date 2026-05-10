import type { ToolDefinition } from './types.js';
import {
  execAgcli,
  withTempWallet,
  buildReadArgs,
  buildWriteArgs,
  parseAgcliOutput,
} from './agcli.js';

const SS58_PATTERN = /^5[A-Za-z0-9]{47}$/;

const ADDRESS_ALIASES = ['address', 'coldkey', 'wallet', 'wallet_address', 'coldkey_address', 'ss58', 'account'] as const;

function resolveAddress(input: any): any {
  if (input && typeof input === 'object' && !input.address) {
    for (const alias of ADDRESS_ALIASES) {
      if (typeof input[alias] === 'string') {
        input.address = input[alias];
        break;
      }
    }
  }
  return input;
}

function requireSs58(value: any, field: string): string | null {
  if (typeof value !== 'string' || !SS58_PATTERN.test(value)) {
    return `${field} must be a valid ss58 address (starts with 5, 48 chars)`;
  }
  return null;
}

function requireNetuid(value: any): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    return 'netuid must be an integer 0-65535';
  }
  return null;
}

function requireBlockNumber(value: any, field: string): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return `${field} must be a non-negative integer`;
  }
  return null;
}

function requireWallet(input: any): string | null {
  if (!input.wallet || typeof input.wallet !== 'object') {
    return 'wallet object required: { "coldkeyMnemonic": "...", "hotkeyMnemonic": "..." }';
  }
  if (typeof input.wallet.coldkeyMnemonic !== 'string' || !input.wallet.coldkeyMnemonic) {
    return 'wallet.coldkeyMnemonic is required';
  }
  return null;
}

// ============================================================================
// READ TOOLS (no wallet needed)
// ============================================================================

export const readTools: ToolDefinition[] = [
  {
    modelId: 'agcli/balance',
    description: 'Get TAO balance for an address',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['balance'], { address: input.address }),
  },
  {
    modelId: 'agcli/subnet-list',
    description: 'List all subnets',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['subnet', 'list'], {}),
  },
  {
    modelId: 'agcli/subnet-metagraph',
    description: 'Get metagraph data for a subnet',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'metagraph'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/subnet-health',
    description: 'Get subnet health diagnostics',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'health'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/subnet-emissions',
    description: 'Get emission data for a subnet',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'emissions'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/view-portfolio',
    description: 'Cross-subnet stake portfolio with P&L',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['view', 'portfolio'], { address: input.address }),
  },
  {
    modelId: 'agcli/view-validators',
    description: 'Ranked validator comparison for a subnet',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['view', 'validators'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/view-history',
    description: 'Transaction history for an address',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['view', 'history'], { address: input.address }),
  },
  {
    modelId: 'agcli/delegate-list',
    description: 'List all delegates',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['delegate', 'list'], {}),
  },
  {
    modelId: 'agcli/diff-subnet',
    description: 'Compare subnet state between two blocks',
    requiresWallet: false,
    validate: (input) => {
      const netuiderr = requireNetuid(input.netuid);
      if (netuiderr) return netuiderr;
      // accept both legacy fromBlock/toBlock and new block1/block2
      const fromVal = input.block1 ?? input.fromBlock;
      const toVal = input.block2 ?? input.toBlock;
      const fromerr = requireBlockNumber(fromVal, 'block1');
      if (fromerr) return fromerr;
      return requireBlockNumber(toVal, 'block2');
    },
    buildArgs: (input) => buildReadArgs(
      ['diff', 'subnet'],
      {
        netuid: input.netuid,
        block1: input.block1 ?? input.fromBlock,
        block2: input.block2 ?? input.toBlock,
      }
    ),
  },
  {
    modelId: 'agcli/audit',
    description: 'Security audit: proxies, delegate exposure, stake analysis',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['audit'], { address: input.address }),
  },
  {
    modelId: 'agcli/doctor',
    description: 'Connectivity, wallet health, chain version diagnostics',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['doctor'], {}),
  },
  {
    modelId: 'agcli/explain',
    description: 'Explain a Bittensor concept (31 topics)',
    requiresWallet: false,
    validate: (input) => {
      if (typeof input.topic !== 'string' || !input.topic.trim()) {
        return 'topic required (e.g. "yuma", "amm", "tempo", "commit-reveal")';
      }
      if (!/^[a-z0-9-]+$/.test(input.topic)) {
        return 'topic must be lowercase alphanumeric with hyphens';
      }
      return null;
    },
    buildArgs: (input) => buildReadArgs(['explain'], { topic: input.topic }),
  },
  {
    modelId: 'agcli/block-info',
    description: 'Get block details: extrinsics, events, timestamp',
    requiresWallet: false,
    validate: (input) => requireBlockNumber(input.number ?? input.block, 'number'),
    buildArgs: (input) => buildReadArgs(['block', 'info'], { number: input.number ?? input.block }),
  },
  {
    modelId: 'agcli/block-latest',
    description: 'Get latest block hash, number, and timestamp',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['block', 'latest'], {}),
  },
  {
    modelId: 'agcli/view-dynamic',
    description: 'Dynamic TAO pricing: subnet alpha prices, pool balances, volumes',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['view', 'dynamic'], {}),
  },
  {
    modelId: 'agcli/view-account',
    description: 'Full account explorer: balance, stakes, identity, delegate info',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['view', 'account'], { address: input.address }),
  },
  {
    modelId: 'agcli/view-network',
    description: 'Global Bittensor network overview',
    requiresWallet: false,
    validate: () => null,
    buildArgs: () => buildReadArgs(['view', 'network'], {}),
  },
  {
    modelId: 'agcli/subnet-cost',
    description: 'Registration cost and trend for a subnet',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'cost'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/subnet-liquidity',
    description: 'AMM liquidity depth and slippage estimates for a subnet',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'liquidity'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/subnet-hyperparams',
    description: 'Subnet hyperparameters: tempo, immunity period, max neurons, min stake, etc.',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['subnet', 'hyperparams'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/view-subnet-analytics',
    description: 'Subnet analytics: miner/validator stats, economics, top performers',
    requiresWallet: false,
    validate: (input) => requireNetuid(input.netuid),
    buildArgs: (input) => buildReadArgs(['view', 'subnet-analytics'], { netuid: input.netuid }),
  },
  {
    modelId: 'agcli/view-staking-analytics',
    description: 'Staking analytics: APY estimates, emission projections',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['view', 'staking-analytics'], { address: input.address }),
  },
  {
    modelId: 'agcli/view-swap-sim',
    description: 'Simulate TAO/Alpha swap with slippage and fee estimates',
    requiresWallet: false,
    validate: (input) => {
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const hasTao = input.tao !== undefined && input.tao !== null;
      const hasAlpha = input.alpha !== undefined && input.alpha !== null;
      if (!hasTao && !hasAlpha) return 'Either tao or alpha amount is required';
      if (hasTao && hasAlpha) return 'Provide either tao or alpha, not both';
      const val = Number(hasTao ? input.tao : input.alpha);
      if (!Number.isFinite(val) || val <= 0) return 'Amount must be a positive number';
      return null;
    },
    buildArgs: (input) => {
      const params: Record<string, any> = { netuid: input.netuid };
      if (input.tao !== undefined && input.tao !== null) params.tao = input.tao;
      if (input.alpha !== undefined && input.alpha !== null) params.alpha = input.alpha;
      return buildReadArgs(['view', 'swap-sim'], params);
    },
  },
  {
    modelId: 'agcli/view-nominations',
    description: 'View who nominates/delegates to a hotkey',
    requiresWallet: false,
    validate: (input) => requireSs58(input.hotkey, 'hotkey'),
    buildArgs: (input) => buildReadArgs(['view', 'nominations'], { hotkey: input.hotkey }),
  },
  {
    modelId: 'agcli/identity-show',
    description: 'Query on-chain identity for an address',
    requiresWallet: false,
    validate: (input) => { resolveAddress(input); return requireSs58(input.address, 'address'); },
    buildArgs: (input) => buildReadArgs(['identity', 'show'], { address: input.address }),
  },
];

// ============================================================================
// WRITE TOOLS (wallet required)
// ============================================================================

export const writeTools: ToolDefinition[] = [
  {
    modelId: 'agcli/stake-add',
    description: 'Add stake to a subnet. If hotkey is omitted, uses the wallet hotkey (must be registered on-chain).',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      if (input.hotkey !== undefined) {
        const hkErr = requireSs58(input.hotkey, 'hotkey');
        if (hkErr) return hkErr;
      }
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'add'],
      { netuid: input.netuid, amount: input.amount, hotkey: input.hotkey }
    ),
  },
  {
    modelId: 'agcli/stake-remove',
    description: 'Remove stake from a subnet. If hotkey is omitted, uses the wallet hotkey.',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      if (input.hotkey !== undefined) {
        const hkErr = requireSs58(input.hotkey, 'hotkey');
        if (hkErr) return hkErr;
      }
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'remove'],
      { netuid: input.netuid, amount: input.amount, hotkey: input.hotkey }
    ),
  },
  {
    modelId: 'agcli/weights-set',
    description: 'Set weights on a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      if (typeof input.weights !== 'string' || !input.weights) {
        return 'weights required as string (e.g. "0:100,1:200")';
      }
      if (!/^(\d+:\d+)(,\d+:\d+)*$/.test(input.weights)) {
        return 'weights format: "uid:weight,uid:weight" (e.g. "0:100,1:200")';
      }
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['weights', 'set'],
      { netuid: input.netuid, weights: input.weights }
    ),
  },
  {
    modelId: 'agcli/weights-commit-reveal',
    description: 'Atomic commit + wait + reveal weights',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      if (typeof input.weights !== 'string' || !input.weights) {
        return 'weights required as string (e.g. "0:100,1:200")';
      }
      return null;
    },
    buildArgs: (input) => {
      const args = buildWriteArgs(
        ['weights', 'commit-reveal'],
        { netuid: input.netuid, weights: input.weights }
      );
      args.push('--wait');
      return args;
    },
  },
  {
    modelId: 'agcli/register',
    description: 'Register a neuron on a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      return requireNetuid(input.netuid);
    },
    buildArgs: (input) => buildWriteArgs(
      ['subnet', 'register-neuron'],
      { netuid: input.netuid }
    ),
  },
  {
    modelId: 'agcli/transfer',
    description: 'Transfer TAO to another address',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const destErr = requireSs58(input.destination, 'destination');
      if (destErr) return destErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['transfer'],
      { dest: input.destination, amount: input.amount }
    ),
  },
  {
    modelId: 'agcli/transfer-all',
    description: 'Transfer entire TAO balance minus fees',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      return requireSs58(input.destination, 'destination');
    },
    buildArgs: (input) => {
      const args = buildWriteArgs(
        ['transfer-all'],
        { dest: input.destination }
      );
      args.push('--keep-alive');
      return args;
    },
  },
  {
    modelId: 'agcli/serve-axon',
    description: 'Set axon endpoint for a miner/validator so validators can reach it',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      if (typeof input.ip !== 'string' || !input.ip) return 'ip is required (e.g. "1.2.3.4")';
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1-65535';
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['serve', 'axon'],
      { netuid: input.netuid, ip: input.ip, port: input.port, protocol: input.protocol }
    ),
  },
  {
    modelId: 'agcli/stake-recycle-alpha',
    description: 'Convert subnet alpha tokens back to TAO',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      if (input.hotkey !== undefined) {
        const hkErr = requireSs58(input.hotkey, 'hotkey');
        if (hkErr) return hkErr;
      }
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'recycle-alpha'],
      { netuid: input.netuid, amount: input.amount, hotkey: input.hotkey }
    ),
  },
  {
    modelId: 'agcli/stake-unstake-all',
    description: 'Unstake all alpha across all subnets',
    requiresWallet: true,
    validate: (input) => requireWallet(input),
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'unstake-all-alpha'],
      { hotkey: input.hotkey }
    ),
  },
  {
    modelId: 'agcli/stake-burn-alpha',
    description: 'Burn alpha tokens permanently on a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      if (input.hotkey !== undefined) {
        const hkErr = requireSs58(input.hotkey, 'hotkey');
        if (hkErr) return hkErr;
      }
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'burn-alpha'],
      { netuid: input.netuid, amount: input.amount, hotkey: input.hotkey }
    ),
  },
  {
    modelId: 'agcli/stake-move',
    description: 'Move stake between subnets. Without price: market swap. With price: limit order.',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const fromErr = requireNetuid(input.from);
      if (fromErr) return `from: ${fromErr}`;
      const toErr = requireNetuid(input.to);
      if (toErr) return `to: ${toErr}`;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      if (input.price !== undefined) {
        const price = Number(input.price);
        if (!Number.isFinite(price) || price <= 0) return 'price must be a positive number';
      }
      if (input.hotkey !== undefined) {
        const hkErr = requireSs58(input.hotkey, 'hotkey');
        if (hkErr) return hkErr;
      }
      return null;
    },
    buildArgs: (input) => {
      if (input.price !== undefined) {
        const args = buildWriteArgs(
          ['stake', 'swap-limit'],
          { from: input.from, to: input.to, amount: input.amount, price: input.price, hotkey: input.hotkey }
        );
        args.push('--partial');
        return args;
      }
      return buildWriteArgs(
        ['stake', 'move'],
        { from: input.from, to: input.to, amount: input.amount, hotkey: input.hotkey }
      );
    },
  },
  {
    modelId: 'agcli/weights-reveal',
    description: 'Reveal previously committed weights on a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      return requireNetuid(input.netuid);
    },
    buildArgs: (input) => buildWriteArgs(
      ['weights', 'reveal'],
      { netuid: input.netuid }
    ),
  },
  {
    modelId: 'agcli/subnet-create',
    description: 'Create a new subnet (locks significant TAO — check cost first)',
    requiresWallet: true,
    validate: (input) => requireWallet(input),
    buildArgs: () => buildWriteArgs(
      ['subnet', 'register'],
      {}
    ),
  },
  {
    modelId: 'agcli/subnet-dissolve',
    description: 'Dissolve a subnet (owner only — returns locked TAO)',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      return requireNetuid(input.netuid);
    },
    buildArgs: (input) => buildWriteArgs(
      ['subnet', 'dissolve'],
      { netuid: input.netuid }
    ),
  },
];

// ============================================================================
// TOOL REGISTRY + EXECUTION
// ============================================================================

const allTools = [...readTools, ...writeTools];
const toolMap = new Map<string, ToolDefinition>(allTools.map(t => [t.modelId, t]));

export function getToolDefinition(modelId: string): ToolDefinition | null {
  return toolMap.get(modelId) ?? null;
}

export function getAllModelIds(): string[] {
  return allTools.map(t => t.modelId);
}

export function isWriteTool(modelId: string): boolean {
  return toolMap.get(modelId)?.requiresWallet === true;
}

const MAX_CONCURRENT_WRITES = 3;
let activeWrites = 0;
const writeQueue: Array<{ resolve: () => void }> = [];

function acquireWriteSlot(): Promise<void> {
  if (activeWrites < MAX_CONCURRENT_WRITES) {
    activeWrites++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    writeQueue.push({ resolve });
  });
}

function releaseWriteSlot(): void {
  const next = writeQueue.shift();
  if (next) {
    next.resolve();
  } else {
    activeWrites--;
  }
}

export async function executeTool(
  modelId: string,
  rawInput: string,
  agcliPath: string,
  endpoint: string,
  timeoutRead: number,
  timeoutWrite: number,
): Promise<string> {
  const tool = toolMap.get(modelId);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${modelId}` });
  }

  let input: any;
  try {
    input = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch {
    return JSON.stringify({ error: 'Invalid JSON input' });
  }

  const validationError = tool.validate(input);
  if (validationError) {
    return JSON.stringify({ error: validationError });
  }

  try {
    if (tool.requiresWallet) {
      await acquireWriteSlot();
      try {
        const walletData = input.wallet;

        return await withTempWallet(walletData, agcliPath, async (walletDir, walletName, password) => {
          const args = tool.buildArgs(input);
          console.log(`[agcli] ${modelId} WRITE executing: args=${JSON.stringify(args)}`);
          const result = await execAgcli(agcliPath, args, {
            walletDir,
            walletName,
            timeout: timeoutWrite,
            endpoint,
            password,
          });
          console.log(`[agcli] ${modelId} WRITE result: exit=${result.exitCode} stdout=${result.stdout.slice(0, 1000)} stderr=${result.stderr.slice(0, 500)}`);
          const parsed = parseAgcliOutput(result);
          if (parsed && typeof parsed === 'object' && parsed.error) {
            console.error(`[agcli] ${modelId} WRITE chain error: ${JSON.stringify(parsed.error).slice(0, 500)}`);
          }
          return JSON.stringify(parsed);
        });
      } finally {
        releaseWriteSlot();
      }
    } else {
      const args = tool.buildArgs(input);
      const result = await execAgcli(agcliPath, args, {
        timeout: timeoutRead,
        endpoint,
      });
      if (result.exitCode !== 0) {
        console.error(`[agcli] ${modelId} READ failed (exit ${result.exitCode}): stderr=${result.stderr.slice(0, 500)}`);
      }
      const parsed = parseAgcliOutput(result);
      return JSON.stringify(parsed);
    }
  } catch (err: any) {
    return JSON.stringify({ error: err.message?.slice(0, 500) || 'execution failed' });
  }
}
