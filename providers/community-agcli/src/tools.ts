import type { ToolDefinition } from './types.js';
import {
  execAgcli,
  withTempWallet,
  buildReadArgs,
  buildWriteArgs,
  parseAgcliOutput,
} from './agcli.js';

const SS58_PATTERN = /^5[A-Za-z0-9]{47}$/;

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
    return 'wallet object required: { "coldkey": "...", "hotkey": "..." }';
  }
  if (typeof input.wallet.coldkey !== 'string' || !input.wallet.coldkey) {
    return 'wallet.coldkey is required';
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
    validate: (input) => requireSs58(input.address, 'address'),
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
    validate: (input) => requireSs58(input.address, 'address'),
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
    validate: (input) => requireSs58(input.address, 'address'),
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
      const fromerr = requireBlockNumber(input.fromBlock, 'fromBlock');
      if (fromerr) return fromerr;
      return requireBlockNumber(input.toBlock, 'toBlock');
    },
    buildArgs: (input) => buildReadArgs(
      ['diff', 'subnet'],
      { netuid: input.netuid, 'from-block': input.fromBlock, 'to-block': input.toBlock }
    ),
  },
  {
    modelId: 'agcli/audit',
    description: 'Security audit: proxies, delegate exposure, stake analysis',
    requiresWallet: false,
    validate: (input) => requireSs58(input.address, 'address'),
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
    buildArgs: (input) => ['explain', input.topic],
  },
  {
    modelId: 'agcli/block-info',
    description: 'Get block details: extrinsics, events, timestamp',
    requiresWallet: false,
    validate: (input) => requireBlockNumber(input.block, 'block'),
    buildArgs: (input) => buildReadArgs(['block', 'info'], { block: input.block }),
  },
];

// ============================================================================
// WRITE TOOLS (wallet required)
// ============================================================================

export const writeTools: ToolDefinition[] = [
  {
    modelId: 'agcli/stake-add',
    description: 'Add stake to a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'add'],
      { netuid: input.netuid, amount: input.amount },
      input.wallet.name || 'agent'
    ),
  },
  {
    modelId: 'agcli/stake-remove',
    description: 'Remove stake from a subnet',
    requiresWallet: true,
    validate: (input) => {
      const walletErr = requireWallet(input);
      if (walletErr) return walletErr;
      const netuidErr = requireNetuid(input.netuid);
      if (netuidErr) return netuidErr;
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return 'amount must be a positive number';
      return null;
    },
    buildArgs: (input) => buildWriteArgs(
      ['stake', 'remove'],
      { netuid: input.netuid, amount: input.amount },
      input.wallet.name || 'agent'
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
      { netuid: input.netuid, weights: input.weights },
      input.wallet.name || 'agent'
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
    buildArgs: (input) => buildWriteArgs(
      ['weights', 'commit-reveal'],
      { netuid: input.netuid, weights: input.weights, wait: '' },
      input.wallet.name || 'agent'
    ),
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
      ['subnet', 'register'],
      { netuid: input.netuid },
      input.wallet.name || 'agent'
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
      const walletData = input.wallet;
      const password = input.password;

      return await withTempWallet(walletData, async (walletDir, walletName) => {
        const args = tool.buildArgs({ ...input, wallet: { ...walletData, name: walletName } });
        const result = await execAgcli(agcliPath, args, {
          walletDir,
          timeout: timeoutWrite,
          endpoint,
          password,
        });
        const parsed = parseAgcliOutput(result);
        return JSON.stringify(parsed);
      });
    } else {
      const args = tool.buildArgs(input);
      const result = await execAgcli(agcliPath, args, {
        timeout: timeoutRead,
        endpoint,
      });
      const parsed = parseAgcliOutput(result);
      return JSON.stringify(parsed);
    }
  } catch (err: any) {
    return JSON.stringify({ error: err.message?.slice(0, 500) || 'execution failed' });
  }
}
