import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing } from './types.js';
import type { Hex } from 'viem';

config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

let activeModels: Map<string, ModelPricing> = new Map();

function usd(price: number): bigint {
  return BigInt(Math.ceil(price * 1_000_000));
}

export function loadModels(): void {
  activeModels = new Map();

  const readModels: [string, number][] = [
    ['agcli/balance',          0.005],
    ['agcli/subnet-list',      0.005],
    ['agcli/subnet-metagraph', 0.01],
    ['agcli/subnet-health',    0.01],
    ['agcli/subnet-emissions', 0.01],
    ['agcli/view-portfolio',   0.015],
    ['agcli/view-validators',  0.01],
    ['agcli/view-history',     0.015],
    ['agcli/delegate-list',    0.005],
    ['agcli/diff-subnet',      0.02],
    ['agcli/audit',            0.02],
    ['agcli/doctor',           0.005],
    ['agcli/explain',          0.005],
    ['agcli/block-info',       0.01],
  ];

  const writeModels: [string, number][] = [
    ['agcli/stake-add',             0.05],
    ['agcli/stake-remove',          0.05],
    ['agcli/weights-set',           0.05],
    ['agcli/weights-commit-reveal', 0.05],
    ['agcli/register',              0.03],
  ];

  for (const [id, price] of [...readModels, ...writeModels]) {
    activeModels.set(id, { inputPer1k: usd(price), outputPer1k: 0n });
  }

  console.log(`Loaded ${activeModels.size} models (${readModels.length} read + ${writeModels.length} write)`);
}

export const getModelPricing = (model: string): ModelPricing | null =>
  activeModels.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  activeModels.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(activeModels.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  loadModels();

  return {
    readRateLimitPerMinute: parseInt(optionalEnv('READ_RATE_LIMIT_PER_MINUTE', '20')),
    writeRateLimitPerMinute: parseInt(optionalEnv('WRITE_RATE_LIMIT_PER_MINUTE', '5')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'Community-agcli'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    agcliPath: optionalEnv('AGCLI_PATH', 'agcli'),
    subtensorEndpoint: optionalEnv('SUBTENSOR_ENDPOINT', 'wss://entrypoint-finney.opentensor.ai:443'),
    agcliTimeoutRead: parseInt(optionalEnv('AGCLI_TIMEOUT_READ', '30')) * 1000,
    agcliTimeoutWrite: parseInt(optionalEnv('AGCLI_TIMEOUT_WRITE', '120')) * 1000,
  };
}
