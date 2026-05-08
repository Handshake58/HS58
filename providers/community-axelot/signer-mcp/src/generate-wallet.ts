#!/usr/bin/env node
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';
import { existsSync, writeFileSync } from 'node:fs';

const target = process.argv.includes('--stdout') ? null : '.env';

await cryptoWaitReady();

const mnemonic = mnemonicGenerate(12);
const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
const pair = keyring.addFromMnemonic(mnemonic);

const env = [
  `TAO_COLDKEY_MNEMONIC="${mnemonic}"`,
  'SUBTENSOR_ENDPOINT="wss://entrypoint-finney.opentensor.ai:443"',
  'BITTENSOR_CHAIN="bittensor-finney"',
  'MAX_TAO_PER_TRADE="0.01"',
  'MAX_TAO_PER_DAY="0.05"',
  'MAX_OPEN_EXPOSURE_TAO="0.10"',
  'MAX_SLIPPAGE_PCT="1.5"',
  'REQUIRE_CONFIRM="true"',
  'ALLOW_RECYCLE_ALPHA="false"',
  'ALLOWED_PROVIDERS="community-axelot"',
  'ALLOWED_ACTIONS="stake,unstake,full_unstake,move,swap"',
  'ALLOWED_NETUIDS=""',
].join('\n') + '\n';

if (target) {
  if (existsSync(target) && !process.argv.includes('--force')) {
    throw new Error(`${target} already exists. Pass --force to overwrite.`);
  }
  writeFileSync(target, env);
}

console.log(JSON.stringify({
  address: pair.address,
  envWritten: target,
  mnemonic: target ? '[written to .env]' : mnemonic,
}, null, 2));
