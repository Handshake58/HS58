/**
 * DRAIN Integration
 * 
 * Handles voucher validation and payment claims.
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
  private publicClient;
  private walletClient;
  private account;
  private contractAddress: Address;

  constructor(config: ProviderConfig, storage: VoucherStorage) {
    this.config = config;
    this.storage = storage;

    const chain = config.chainId === 137 ? polygon : polygonAmoy;
    const rpcUrl = config.polygonRpcUrl;
    
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    this.account = privateKeyToAccount(config.providerPrivateKey);
    
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(rpcUrl),
    });

    if (rpcUrl) {
      console.log(`[drain] Using custom RPC: ${rpcUrl.replace(/\/[^/]{8,}$/, '/***')}`);
    } else {
      console.warn('[drain] WARNING: No POLYGON_RPC_URL set, using public RPC (rate-limited). Set POLYGON_RPC_URL for reliable claiming.');
    }

    this.contractAddress = DRAIN_ADDRESSES[config.chainId] as Address;
  }

  parseVoucherHeader(header: string): VoucherHeader | null {
    try {
      const parsed = JSON.parse(header);
      if (!parsed.channelId || !parsed.amount || !parsed.nonce || !parsed.signature) {
        return null;
      }
      return {
        channelId: parsed.channelId as Hash,
        amount: parsed.amount,
        nonce: parsed.nonce,
        signature: parsed.signature as Hex,
      };
    } catch {
      return null;
    }
  }

  async validateVoucher(
    voucher: VoucherHeader,
    requiredAmount: bigint
  ): Promise<{
    valid: boolean;
    error?: string;
    channel?: ChannelState;
    newTotal?: bigint;
  }> {
    try {
      const amount = BigInt(voucher.amount);
      const nonce = BigInt(voucher.nonce);

      const channelData = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DRAIN_CHANNEL_ABI,
        functionName: 'getChannel',
        args: [voucher.channelId],
      }) as any;

      if (channelData.consumer === '0x0000000000000000000000000000000000000000') {
        return { valid: false, error: 'channel_not_found' };
      }

      if (channelData.provider.toLowerCase() !== this.account.address.toLowerCase()) {
        return { valid: false, error: 'wrong_provider' };
      }

      let channelState = this.storage.getChannel(voucher.channelId);
      
      if (!channelState) {
        channelState = {
          channelId: voucher.channelId,
          consumer: channelData.consumer,
          deposit: channelData.deposit,
          totalCharged: 0n,
          expiry: Number(channelData.expiry),
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        };
      } else if (!channelState.expiry) {
        channelState.expiry = Number(channelData.expiry);
      }

      const previousTotal = channelState.totalCharged;
      const expectedTotal = previousTotal + requiredAmount;
      
      if (amount < expectedTotal) {
        return { valid: false, error: 'insufficient_funds', channel: channelState };
      }

      if (amount > channelData.deposit) {
        return { valid: false, error: 'exceeds_deposit', channel: channelState };
      }

      if (channelState.lastVoucher && nonce <= channelState.lastVoucher.nonce) {
        return { valid: false, error: 'invalid_nonce', channel: channelState };
      }

      const isValid = await verifyTypedData({
        address: channelData.consumer,
        domain: {
          name: EIP712_DOMAIN.name,
          version: EIP712_DOMAIN.version,
          chainId: this.config.chainId,
          verifyingContract: this.contractAddress,
        },
        types: {
          Voucher: [
            { name: 'channelId', type: 'bytes32' },
            { name: 'amount', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        primaryType: 'Voucher',
        message: {
          channelId: voucher.channelId,
          amount,
          nonce,
        },
        signature: voucher.signature,
      });

      if (!isValid) {
        return { valid: false, error: 'invalid_signature' };
      }

      return { valid: true, channel: channelState, newTotal: amount };
    } catch (error) {
      console.error('Voucher validation error:', error);
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'validation_error',
      };
    }
  }

  storeVoucher(voucher: VoucherHeader, channelState: ChannelState, cost: bigint): void {
    const storedVoucher: StoredVoucher = {
      channelId: voucher.channelId,
      amount: BigInt(voucher.amount),
      nonce: BigInt(voucher.nonce),
      signature: voucher.signature,
      consumer: channelState.consumer,
      receivedAt: Date.now(),
      claimed: false,
    };

    channelState.totalCharged += cost;
    channelState.lastVoucher = storedVoucher;
    channelState.lastActivityAt = Date.now();

    this.storage.storeVoucher(storedVoucher);
    this.storage.updateChannel(voucher.channelId, channelState);
  }

  async claimPayments(forceAll: boolean = false): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    const highest = this.storage.getHighestVoucherPerChannel();

    for (const [channelId, voucher] of highest) {
      if (!forceAll && voucher.amount < this.config.claimThreshold) continue;

      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) {
          this.storage.markClaimed(channelId, '0x0' as Hash);
          continue;
        }
      } catch { /* proceed with claim */ }

      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress,
          abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim',
          args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        txHashes.push(hash);
        console.log(`Claimed ${voucher.amount} from channel ${channelId}: ${hash}`);
      } catch (error: any) {
        this.handleClaimError('claim', channelId, error);
      }
    }
    return txHashes;
  }

  getProviderAddress(): Address {
    return this.account.address;
  }

  async getChannelBalance(channelId: Hash): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: DRAIN_CHANNEL_ABI,
      functionName: 'getBalance',
      args: [channelId],
    }) as bigint;
  }

  async claimExpiring(bufferSeconds: number = 3600): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    const highest = this.storage.getHighestVoucherPerChannel();
    const now = Math.floor(Date.now() / 1000);

    for (const [channelId, voucher] of highest) {
      const channel = this.storage.getChannel(channelId);
      if (!channel || !channel.expiry) continue;
      const timeLeft = channel.expiry - now;
      if (timeLeft > bufferSeconds) continue;
      if (voucher.amount <= 0n) continue;

      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) {
          this.storage.markClaimed(channelId, '0x0' as Hash);
          continue;
        }
      } catch { /* proceed */ }

      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress,
          abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim',
          args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        txHashes.push(hash);
        console.log(`[auto-claim] Claimed ${voucher.amount} from ${channelId}: ${hash}`);
      } catch (error: any) {
        this.handleClaimError('auto-claim', channelId, error);
      }
    }
    return txHashes;
  }

  private autoClaimInterval: ReturnType<typeof setInterval> | null = null;

  startAutoClaim(intervalMinutes: number = 10, bufferSeconds: number = 3600): void {
    if (this.autoClaimInterval) return;
    console.log(`[auto-claim] Started: checking every ${intervalMinutes}min, claiming channels expiring within ${bufferSeconds / 60}min`);
    this.autoClaimInterval = setInterval(async () => {
      try {
        const claimed = await this.claimExpiring(bufferSeconds);
        if (claimed.length > 0) console.log(`[auto-claim] Claimed ${claimed.length} expiring channel(s)`);
      } catch (error) {
        console.error('[auto-claim] Error:', error);
      }
    }, intervalMinutes * 60 * 1000);
    this.claimExpiring(bufferSeconds).catch(console.error);
  }

  private handleClaimError(context: string, channelId: string, error: any): void {
    const errorName = error?.cause?.data?.errorName || error?.cause?.reason || undefined;
    if (errorName && PERMANENT_CLAIM_ERRORS.includes(errorName as any)) {
      console.error(`[${context}] ${channelId}: ${errorName} (permanent, marking failed)`);
      this.storage.markClaimed(channelId as Hash, '0x0' as Hash);
    } else {
      const shortMsg = error?.shortMessage || error?.message || 'unknown error';
      console.error(`[${context}] ${channelId}: ${shortMsg} (will retry)`);
    }
  }

  stopAutoClaim(): void {
    if (this.autoClaimInterval) {
      clearInterval(this.autoClaimInterval);
      this.autoClaimInterval = null;
    }
  }
}
