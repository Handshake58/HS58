/**
 * Voucher Storage — JSON file storage for vouchers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { StoredVoucher, ChannelState } from './types.js';
import type { Hash } from 'viem';

interface StorageData {
  vouchers: StoredVoucher[];
  channels: Record<string, ChannelState>;
  totalEarned: string;
  totalClaimed: string;
}

export class VoucherStorage {
  private filePath: string;
  private data: StorageData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StorageData {
    if (!existsSync(this.filePath)) {
      return { vouchers: [], channels: {}, totalEarned: '0', totalClaimed: '0' };
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      parsed.vouchers = parsed.vouchers.map((v: any) => ({
        ...v, amount: BigInt(v.amount), nonce: BigInt(v.nonce),
      }));
      for (const channelId in parsed.channels) {
        const ch = parsed.channels[channelId];
        ch.deposit = BigInt(ch.deposit);
        ch.totalCharged = BigInt(ch.totalCharged);
        if (ch.lastVoucher) {
          ch.lastVoucher.amount = BigInt(ch.lastVoucher.amount);
          ch.lastVoucher.nonce = BigInt(ch.lastVoucher.nonce);
        }
      }
      return parsed;
    } catch (error) {
      console.error('Error loading storage, starting fresh:', error);
      return { vouchers: [], channels: {}, totalEarned: '0', totalClaimed: '0' };
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const serializable = {
      ...this.data,
      vouchers: this.data.vouchers.map(v => ({ ...v, amount: v.amount.toString(), nonce: v.nonce.toString() })),
      channels: Object.fromEntries(
        Object.entries(this.data.channels).map(([id, ch]) => [id, {
          ...ch,
          deposit: ch.deposit.toString(),
          totalCharged: ch.totalCharged.toString(),
          lastVoucher: ch.lastVoucher ? { ...ch.lastVoucher, amount: ch.lastVoucher.amount.toString(), nonce: ch.lastVoucher.nonce.toString() } : undefined,
        }])
      ),
    };
    writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
  }

  storeVoucher(voucher: StoredVoucher): void { this.data.vouchers.push(voucher); this.save(); }

  getChannel(channelId: Hash): ChannelState | null { return this.data.channels[channelId] ?? null; }

  updateChannel(channelId: Hash, state: ChannelState): void { this.data.channels[channelId] = state; this.save(); }

  getUnclaimedVouchers(): StoredVoucher[] { return this.data.vouchers.filter(v => !v.claimed); }

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
    for (const v of this.data.vouchers) {
      if (v.channelId === channelId && !v.claimed) {
        v.claimed = true; v.claimedAt = Date.now(); v.claimTxHash = txHash;
      }
    }
    this.save();
  }

  getTotalUnclaimed(): bigint {
    let total = 0n;
    for (const v of this.getHighestVoucherPerChannel().values()) total += v.amount;
    return total;
  }

  getStats() {
    return {
      totalVouchers: this.data.vouchers.length,
      unclaimedVouchers: this.data.vouchers.filter(v => !v.claimed).length,
      activeChannels: Object.keys(this.data.channels).length,
      totalEarned: BigInt(this.data.totalEarned),
    };
  }
}
