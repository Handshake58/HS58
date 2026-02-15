/**
 * Voucher Storage
 * 
 * Simple JSON file storage for vouchers.
 * This is a reference implementation - production providers
 * should use a proper database.
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

/**
 * Simple file-based storage for vouchers
 */
export class VoucherStorage {
  private filePath: string;
  private data: StorageData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  /**
   * Load data from file
   */
  private load(): StorageData {
    if (!existsSync(this.filePath)) {
      return {
        vouchers: [],
        channels: {},
        totalEarned: '0',
        totalClaimed: '0',
      };
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      
      // Convert string amounts back to bigint in vouchers
      parsed.vouchers = parsed.vouchers.map((v: any) => ({
        ...v,
        amount: BigInt(v.amount),
        nonce: BigInt(v.nonce),
      }));
      
      // Convert string amounts back to bigint in channels
      for (const channelId in parsed.channels) {
        const channel = parsed.channels[channelId];
        channel.deposit = BigInt(channel.deposit);
        channel.totalCharged = BigInt(channel.totalCharged);
        if (channel.lastVoucher) {
          channel.lastVoucher.amount = BigInt(channel.lastVoucher.amount);
          channel.lastVoucher.nonce = BigInt(channel.lastVoucher.nonce);
        }
      }
      
      return parsed;
    } catch (error) {
      console.error('Error loading storage, starting fresh:', error);
      return {
        vouchers: [],
        channels: {},
        totalEarned: '0',
        totalClaimed: '0',
      };
    }
  }

  /**
   * Save data to file
   */
  private save(): void {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Convert bigint to string for JSON serialization
    const serializable = {
      ...this.data,
      vouchers: this.data.vouchers.map(v => ({
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
            lastVoucher: channel.lastVoucher ? {
              ...channel.lastVoucher,
              amount: channel.lastVoucher.amount.toString(),
              nonce: channel.lastVoucher.nonce.toString(),
            } : undefined,
          },
        ])
      ),
    };

    writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
  }

  /**
   * Store a new voucher
   */
  storeVoucher(voucher: StoredVoucher): void {
    this.data.vouchers.push(voucher);
    this.save();
  }

  /**
   * Get or create channel state
   */
  getChannel(channelId: Hash): ChannelState | null {
    return this.data.channels[channelId] ?? null;
  }

  /**
   * Update channel state
   */
  updateChannel(channelId: Hash, state: ChannelState): void {
    this.data.channels[channelId] = state;
    this.save();
  }

  /**
   * Get all unclaimed vouchers
   */
  getUnclaimedVouchers(): StoredVoucher[] {
    return this.data.vouchers.filter(v => !v.claimed);
  }

  /**
   * Get the highest voucher per channel (for claiming)
   */
  getHighestVoucherPerChannel(): Map<Hash, StoredVoucher> {
    const highest = new Map<Hash, StoredVoucher>();
    
    for (const voucher of this.data.vouchers) {
      if (voucher.claimed) continue;
      
      const existing = highest.get(voucher.channelId);
      if (!existing || voucher.amount > existing.amount) {
        highest.set(voucher.channelId, voucher);
      }
    }
    
    return highest;
  }

  /**
   * Mark a voucher as claimed
   */
  markClaimed(channelId: Hash, txHash: Hash): void {
    for (const voucher of this.data.vouchers) {
      if (voucher.channelId === channelId && !voucher.claimed) {
        voucher.claimed = true;
        voucher.claimedAt = Date.now();
        voucher.claimTxHash = txHash;
      }
    }
    this.save();
  }

  /**
   * Get total earned (unclaimed)
   */
  getTotalUnclaimed(): bigint {
    let total = 0n;
    const highest = this.getHighestVoucherPerChannel();
    
    for (const voucher of highest.values()) {
      total += voucher.amount;
    }
    
    return total;
  }

  /**
   * Get stats
   */
  getStats(): {
    totalVouchers: number;
    unclaimedVouchers: number;
    activeChannels: number;
    totalEarned: bigint;
  } {
    return {
      totalVouchers: this.data.vouchers.length,
      unclaimedVouchers: this.data.vouchers.filter(v => !v.claimed).length,
      activeChannels: Object.keys(this.data.channels).length,
      totalEarned: BigInt(this.data.totalEarned),
    };
  }
}
