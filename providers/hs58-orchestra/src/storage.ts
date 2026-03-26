import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Hash } from 'viem';
import type { StoredVoucher, ChannelState } from './types.js';

export class VoucherStorage {
  private vouchers: Map<string, StoredVoucher> = new Map();
  private channels: Map<string, ChannelState>  = new Map();
  private path: string;
  private dirty = false;

  constructor(storagePath: string) {
    this.path = storagePath;
    this.load();
    setInterval(() => this.flush(), 30_000);
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      if (raw.vouchers) {
        for (const [k, v] of Object.entries(raw.vouchers as any)) {
          const vv = v as any;
          this.vouchers.set(k, { ...vv, amount: BigInt(vv.amount), nonce: BigInt(vv.nonce) });
        }
      }
      if (raw.channels) {
        for (const [k, c] of Object.entries(raw.channels as any)) {
          const cc = c as any;
          const channel: ChannelState = { ...cc, deposit: BigInt(cc.deposit), totalCharged: BigInt(cc.totalCharged) };
          if (cc.lastVoucher) channel.lastVoucher = { ...cc.lastVoucher, amount: BigInt(cc.lastVoucher.amount), nonce: BigInt(cc.lastVoucher.nonce) };
          this.channels.set(k, channel);
        }
      }
    } catch {}
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const voucherObj: any = {};
      for (const [k, v] of this.vouchers) voucherObj[k] = { ...v, amount: v.amount.toString(), nonce: v.nonce.toString() };
      const channelObj: any = {};
      for (const [k, c] of this.channels) {
        channelObj[k] = { ...c, deposit: c.deposit.toString(), totalCharged: c.totalCharged.toString(),
          lastVoucher: c.lastVoucher ? { ...c.lastVoucher, amount: c.lastVoucher.amount.toString(), nonce: c.lastVoucher.nonce.toString() } : undefined };
      }
      writeFileSync(this.path, JSON.stringify({ vouchers: voucherObj, channels: channelObj }, null, 2));
      this.dirty = false;
    } catch (e) { console.error('[storage] flush failed:', e); }
  }

  storeVoucher(v: StoredVoucher): void { this.vouchers.set(`${v.channelId}:${v.nonce}`, v); this.dirty = true; }
  getChannel(channelId: string): ChannelState | null { return this.channels.get(channelId) ?? null; }
  updateChannel(channelId: string, state: ChannelState): void { this.channels.set(channelId, state); this.dirty = true; }

  markClaimed(channelId: string, txHash: Hash): void {
    for (const [k, v] of this.vouchers) {
      if (v.channelId === channelId && !v.claimed) { v.claimed = true; v.claimedAt = Date.now(); v.claimTxHash = txHash; this.vouchers.set(k, v); }
    }
    this.dirty = true;
  }

  getUnclaimedVouchers(): StoredVoucher[] { return [...this.vouchers.values()].filter(v => !v.claimed); }

  getHighestVoucherPerChannel(): Map<string, StoredVoucher> {
    const highest = new Map<string, StoredVoucher>();
    for (const v of this.vouchers.values()) {
      if (v.claimed) continue;
      const existing = highest.get(v.channelId);
      if (!existing || v.amount > existing.amount) highest.set(v.channelId, v);
    }
    return highest;
  }

  getStats() {
    const unclaimed = this.getUnclaimedVouchers();
    return { totalChannels: this.channels.size, totalVouchers: this.vouchers.size, unclaimedCount: unclaimed.length, totalEarned: unclaimed.reduce((s, v) => s + v.amount, 0n) };
  }
}
