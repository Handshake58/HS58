/**
 * DrainService — identical pattern to all HS58 providers.
 * Copy of openrouter drain.ts with Orchestra's ProviderConfig.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  type Hash,
  type Hex,
  type Address,
} from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DRAIN_ADDRESSES,
  DRAIN_CHANNEL_ABI,
  EIP712_DOMAIN,
  PERMANENT_CLAIM_ERRORS,
} from './constants.js';
import type { ProviderConfig, VoucherHeader, StoredVoucher, ChannelState } from './types.js';
import { VoucherStorage } from './storage.js';

export class DrainService {
  private config: ProviderConfig;
  private storage: VoucherStorage;
  private publicClient: any;
  private walletClient: any;
  private account: any;
  private contractAddress: Address;
  private autoClaimInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: ProviderConfig, storage: VoucherStorage) {
    this.config  = config;
    this.storage = storage;

    const chain  = config.chainId === 137 ? polygon : polygonAmoy;
    const rpcUrl = config.polygonRpcUrl;

    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.account      = privateKeyToAccount(config.providerPrivateKey);
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });

    if (rpcUrl) {
      console.log(`[drain] RPC: ${rpcUrl.replace(/\/[^/]{8,}$/, '/***')}`);
    } else {
      console.warn('[drain] No POLYGON_RPC_URL — using public RPC (rate-limited)');
    }

    this.contractAddress = DRAIN_ADDRESSES[config.chainId] as Address;
  }

  getProviderAddress(): Address { return this.account.address; }

  parseVoucherHeader(header: string): VoucherHeader | null {
    try {
      const p = JSON.parse(header);
      if (!p.channelId || !p.amount || !p.nonce || !p.signature) return null;
      return { channelId: p.channelId, amount: p.amount, nonce: p.nonce, signature: p.signature };
    } catch { return null; }
  }

  async validateVoucher(
    voucher: VoucherHeader,
    requiredAmount: bigint
  ): Promise<{ valid: boolean; error?: string; channel?: ChannelState }> {
    try {
      const amount = BigInt(voucher.amount);
      const nonce  = BigInt(voucher.nonce);

      const channelData = await this.publicClient.readContract({
        address: this.contractAddress, abi: DRAIN_CHANNEL_ABI,
        functionName: 'getChannel', args: [voucher.channelId],
      }) as any;

      if (channelData.consumer === '0x0000000000000000000000000000000000000000')
        return { valid: false, error: 'channel_not_found' };

      if (channelData.provider.toLowerCase() !== this.account.address.toLowerCase())
        return { valid: false, error: 'wrong_provider' };

      let channelState = this.storage.getChannel(voucher.channelId);
      if (!channelState) {
        channelState = {
          channelId: voucher.channelId, consumer: channelData.consumer,
          deposit: channelData.deposit, totalCharged: 0n,
          expiry: Number(channelData.expiry), createdAt: Date.now(), lastActivityAt: Date.now(),
        };
      } else if (!channelState.expiry) {
        channelState.expiry = Number(channelData.expiry);
      }

      const expectedTotal = channelState.totalCharged + requiredAmount;
      if (amount < expectedTotal) return { valid: false, error: 'insufficient_funds', channel: channelState };
      if (amount > channelData.deposit) return { valid: false, error: 'exceeds_deposit', channel: channelState };
      if (channelState.lastVoucher && nonce <= channelState.lastVoucher.nonce)
        return { valid: false, error: 'invalid_nonce', channel: channelState };

      const isValid = await verifyTypedData({
        address: channelData.consumer,
        domain: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId: this.config.chainId, verifyingContract: this.contractAddress },
        types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] },
        primaryType: 'Voucher',
        message: { channelId: voucher.channelId, amount, nonce },
        signature: voucher.signature,
      });

      if (!isValid) return { valid: false, error: 'invalid_signature' };
      return { valid: true, channel: channelState };
    } catch (e: any) {
      return { valid: false, error: e?.message ?? 'validation_error' };
    }
  }

  storeVoucher(voucher: VoucherHeader, channelState: ChannelState, cost: bigint): void {
    const stored: StoredVoucher = {
      channelId: voucher.channelId, amount: BigInt(voucher.amount), nonce: BigInt(voucher.nonce),
      signature: voucher.signature, consumer: channelState.consumer, receivedAt: Date.now(), claimed: false,
    };
    channelState.totalCharged  += cost;
    channelState.lastVoucher    = stored;
    channelState.lastActivityAt = Date.now();
    this.storage.storeVoucher(stored);
    this.storage.updateChannel(voucher.channelId, channelState);
  }

  async getChannelBalance(channelId: Hash): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.contractAddress, abi: DRAIN_CHANNEL_ABI,
      functionName: 'getBalance', args: [channelId],
    }) as bigint;
  }

  async claimPayments(forceAll = false): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    for (const [channelId, voucher] of this.storage.getHighestVoucherPerChannel()) {
      if (!forceAll && voucher.amount < this.config.claimThreshold) continue;
      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) { this.storage.markClaimed(channelId, '0x0' as Hash); continue; }
      } catch {}
      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress, abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim', args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        txHashes.push(hash);
        console.log(`[drain] Claimed ${voucher.amount} from ${channelId}: ${hash}`);
      } catch (e: any) { this.handleClaimError('claim', channelId, e); }
    }
    return txHashes;
  }

  async claimExpiring(bufferSeconds = 3600): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [channelId, voucher] of this.storage.getHighestVoucherPerChannel()) {
      const ch = this.storage.getChannel(channelId);
      if (!ch?.expiry || ch.expiry - now > bufferSeconds || voucher.amount <= 0n) continue;
      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) { this.storage.markClaimed(channelId, '0x0' as Hash); continue; }
      } catch {}
      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress, abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim', args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        txHashes.push(hash);
      } catch (e: any) { this.handleClaimError('auto-claim', channelId, e); }
    }
    return txHashes;
  }

  startAutoClaim(intervalMinutes = 10, bufferSeconds = 3600): void {
    if (this.autoClaimInterval) return;
    console.log(`[auto-claim] Every ${intervalMinutes}min, buffer ${bufferSeconds / 60}min`);
    this.autoClaimInterval = setInterval(async () => {
      try { await this.claimExpiring(bufferSeconds); } catch (e) { console.error('[auto-claim]', e); }
    }, intervalMinutes * 60_000);
    this.claimExpiring(bufferSeconds).catch(console.error);
  }

  async signCloseAuthorization(channelId: Hash): Promise<{ finalAmount: bigint; signature: Hex }> {
    const highest     = this.storage.getHighestVoucherPerChannel().get(channelId);
    const finalAmount = highest ? highest.amount : 0n;
    const signature   = await this.walletClient.signTypedData({
      domain: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version, chainId: this.config.chainId, verifyingContract: this.contractAddress },
      types: { CloseAuthorization: [{ name: 'channelId', type: 'bytes32' }, { name: 'finalAmount', type: 'uint256' }] },
      primaryType: 'CloseAuthorization',
      message: { channelId, finalAmount },
    });
    return { finalAmount, signature };
  }

  private handleClaimError(ctx: string, channelId: string, error: any): void {
    const errorName = error?.cause?.data?.errorName || error?.cause?.reason;
    if (errorName && PERMANENT_CLAIM_ERRORS.includes(errorName as any)) {
      console.error(`[${ctx}] ${channelId}: ${errorName} (permanent, marking failed)`);
      this.storage.markClaimed(channelId as Hash, '0x0' as Hash);
    } else {
      console.error(`[${ctx}] ${channelId}: ${error?.shortMessage || error?.message} (will retry)`);
    }
  }
}
