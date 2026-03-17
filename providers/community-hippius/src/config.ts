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

export function loadModels(markup: number): void {
  activeModels = new Map();

  const models: Array<{ id: string; envKey: string; defaultUsd: number; perMb: boolean }> = [
    { id: 'hippius/upload',        envKey: 'PRICE_PER_MB_UPLOAD',    defaultUsd: 0.005, perMb: true },
    { id: 'hippius/download',      envKey: 'PRICE_PER_MB_DOWNLOAD',  defaultUsd: 0.001, perMb: true },
    { id: 'hippius/list',          envKey: 'PRICE_PER_LIST',         defaultUsd: 0.001, perMb: false },
    { id: 'hippius/create-bucket', envKey: 'PRICE_PER_CREATE_BUCKET', defaultUsd: 0.01,  perMb: false },
    { id: 'hippius/delete',        envKey: 'PRICE_PER_DELETE',       defaultUsd: 0.001, perMb: false },
    { id: 'hippius/ipfs-pin',      envKey: 'PRICE_PER_MB_IPFS_PIN',  defaultUsd: 0.005, perMb: true },
  ];

  for (const m of models) {
    const priceUsd = parseFloat(optionalEnv(m.envKey, m.defaultUsd.toString()));
    const priceUsdc = BigInt(Math.ceil(priceUsd * markup * 1_000_000));
    activeModels.set(m.id, { inputPer1k: priceUsdc, outputPer1k: 0n });
    const label = m.perMb ? '/MB' : '/req';
    console.log(`  ${m.id}: $${(Number(priceUsdc) / 1_000_000).toFixed(4)}${label}`);
  }

  console.log(`Loaded ${activeModels.size} models with ${(markup - 1) * 100}% markup`);
}

export const getModelPricing = (model: string): ModelPricing | null =>
  activeModels.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  activeModels.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(activeModels.keys());

export const getModelMap = (): Map<string, ModelPricing> => activeModels;

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) throw new Error(`Invalid CHAIN_ID: ${chainId}`);

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markup = 1 + (markupPercent / 100);

  loadModels(markup);

  const priceFn = (envKey: string, defaultUsd: number) =>
    BigInt(Math.ceil(parseFloat(optionalEnv(envKey, defaultUsd.toString())) * markup * 1_000_000));

  const maxFileMb = parseInt(optionalEnv('MAX_FILE_SIZE_MB', '100'));

  return {
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing: activeModels,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    markup,
    providerName: optionalEnv('PROVIDER_NAME', 'Community-Hippius'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
    rateLimitPerMinute: parseInt(optionalEnv('RATE_LIMIT_PER_MINUTE', '30')),
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    maxFileSizeBytes: maxFileMb * 1024 * 1024,

    hippius: {
      accessKey: requireEnv('HIPPIUS_ACCESS_KEY'),
      secretKey: requireEnv('HIPPIUS_SECRET_KEY'),
      endpoint: optionalEnv('HIPPIUS_ENDPOINT', 'https://s3.hippius.com'),
      region: optionalEnv('HIPPIUS_REGION', 'us-east-1'),
      ipfsBucket: optionalEnv('HIPPIUS_IPFS_BUCKET', 'ipfs-pins'),
    },

    pricePerMbUpload: priceFn('PRICE_PER_MB_UPLOAD', 0.005),
    pricePerMbDownload: priceFn('PRICE_PER_MB_DOWNLOAD', 0.001),
    pricePerList: priceFn('PRICE_PER_LIST', 0.001),
    pricePerCreateBucket: priceFn('PRICE_PER_CREATE_BUCKET', 0.01),
    pricePerDelete: priceFn('PRICE_PER_DELETE', 0.001),
    pricePerMbIpfsPin: priceFn('PRICE_PER_MB_IPFS_PIN', 0.005),
  };
}
