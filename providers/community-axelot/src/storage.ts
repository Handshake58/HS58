import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { Hash } from 'viem';
import type { ChannelState, StoredVoucher } from './types.js';

interface StorageData {
  vouchers: StoredVoucher[];
  channels: Record<string, ChannelState>;
  totalEarned: string;
  totalClaimed: string;
}

export class VoucherStorage {
  private data: StorageData;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  private load(): StorageData {
    if (!existsSync(this.filePath)) {
      return { vouchers: [], channels: {}, totalEarned: '0', totalClaimed: '0' };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as StorageData;
      parsed.vouchers = parsed.vouchers.map((v) => ({
        ...v,
        amount: BigInt(v.amount),
        nonce: BigInt(v.nonce),
      }));
      for (const channel of Object.values(parsed.channels)) {
        channel.deposit = BigInt(channel.deposit);
        channel.totalCharged = BigInt(channel.totalCharged);
        if (channel.lastVoucher) {
          channel.lastVoucher.amount = BigInt(channel.lastVoucher.amount);
          channel.lastVoucher.nonce = BigInt(channel.lastVoucher.nonce);
        }
      }
      return parsed;
    } catch (error) {
      console.error('[storage] Failed to load voucher storage, starting fresh:', error);
      return { vouchers: [], channels: {}, totalEarned: '0', totalClaimed: '0' };
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const serializable = {
      ...this.data,
      vouchers: this.data.vouchers.map((v) => ({
        ...v,
        amount: v.amount.toString(),
        nonce: v.nonce.toString(),
      })),
      channels: Object.fromEntries(
        Object.entries(this.data.channels).map(([id, channel]) => [
          id,
          {
            ...channel,
            deposit: channel.deposit.toString(),
            totalCharged: channel.totalCharged.toString(),
            lastVoucher: channel.lastVoucher
              ? {
                  ...channel.lastVoucher,
                  amount: channel.lastVoucher.amount.toString(),
                  nonce: channel.lastVoucher.nonce.toString(),
                }
              : undefined,
          },
        ]),
      ),
    };
    writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
  }

  storeVoucher(voucher: StoredVoucher): void {
    this.data.vouchers.push(voucher);
    this.save();
  }

  getChannel(channelId: Hash): ChannelState | null {
    return this.data.channels[channelId.toLowerCase()] ?? null;
  }

  updateChannel(channelId: Hash, state: ChannelState): void {
    this.data.channels[channelId.toLowerCase()] = state;
    this.save();
  }

  getHighestVoucherPerChannel(): Map<Hash, StoredVoucher> {
    const highest = new Map<Hash, StoredVoucher>();
    for (const voucher of this.data.vouchers) {
      if (voucher.claimed) continue;
      const existing = highest.get(voucher.channelId);
      if (!existing || voucher.amount > existing.amount) highest.set(voucher.channelId, voucher);
    }
    return highest;
  }

  markClaimed(channelId: Hash, txHash: Hash): void {
    for (const voucher of this.data.vouchers) {
      if (voucher.channelId.toLowerCase() === channelId.toLowerCase() && !voucher.claimed) {
        voucher.claimed = true;
        voucher.claimedAt = Date.now();
        voucher.claimTxHash = txHash;
      }
    }
    this.save();
  }

  getStats(): { totalVouchers: number; unclaimedVouchers: number; activeChannels: number; totalEarned: bigint } {
    return {
      totalVouchers: this.data.vouchers.length,
      unclaimedVouchers: this.data.vouchers.filter((v) => !v.claimed).length,
      activeChannels: Object.keys(this.data.channels).length,
      totalEarned: BigInt(this.data.totalEarned),
    };
  }

  getUnclaimedVouchers(): StoredVoucher[] {
    return this.data.vouchers.filter((v) => !v.claimed);
  }
}
