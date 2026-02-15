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

/**
 * DRAIN service for the provider
 */
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
    const rpcUrl = config.polygonRpcUrl; // undefined = viem default (public RPC)
    
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

  /**
   * Parse voucher from header
   */
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

  /**
   * Validate a voucher
   */
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

      // 1. Get channel from contract
      const channelData = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DRAIN_CHANNEL_ABI,
        functionName: 'getChannel',
        args: [voucher.channelId],
      }) as any;

      // 2. Check channel exists
      if (channelData.consumer === '0x0000000000000000000000000000000000000000') {
        return { valid: false, error: 'channel_not_found' };
      }

      // 3. Check we are the provider
      if (channelData.provider.toLowerCase() !== this.account.address.toLowerCase()) {
        return { valid: false, error: 'wrong_provider' };
      }

      // 4. Get or create local channel state
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
        // Backfill expiry for channels created before this update
        channelState.expiry = Number(channelData.expiry);
      }

      // 5. Check voucher amount covers required
      const previousTotal = channelState.totalCharged;
      const expectedTotal = previousTotal + requiredAmount;
      
      if (amount < expectedTotal) {
        return {
          valid: false,
          error: 'insufficient_funds',
          channel: channelState,
        };
      }

      // 6. Check amount doesn't exceed deposit
      if (amount > channelData.deposit) {
        return {
          valid: false,
          error: 'exceeds_deposit',
          channel: channelState,
        };
      }

      // 7. Check nonce is higher than last seen
      if (channelState.lastVoucher && nonce <= channelState.lastVoucher.nonce) {
        return {
          valid: false,
          error: 'invalid_nonce',
          channel: channelState,
        };
      }

      // 8. Verify signature
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

      return {
        valid: true,
        channel: channelState,
        newTotal: amount,
      };
    } catch (error) {
      console.error('Voucher validation error:', error);
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'validation_error',
      };
    }
  }

  /**
   * Store a valid voucher and update channel state
   */
  storeVoucher(
    voucher: VoucherHeader,
    channelState: ChannelState,
    cost: bigint
  ): void {
    const storedVoucher: StoredVoucher = {
      channelId: voucher.channelId,
      amount: BigInt(voucher.amount),
      nonce: BigInt(voucher.nonce),
      signature: voucher.signature,
      consumer: channelState.consumer,
      receivedAt: Date.now(),
      claimed: false,
    };

    // Update channel state
    channelState.totalCharged += cost;
    channelState.lastVoucher = storedVoucher;
    channelState.lastActivityAt = Date.now();

    // Store
    this.storage.storeVoucher(storedVoucher);
    this.storage.updateChannel(voucher.channelId, channelState);
  }

  /**
   * Claim payments for all channels above threshold
   */
  async claimPayments(forceAll: boolean = false): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    const highest = this.storage.getHighestVoucherPerChannel();

    for (const [channelId, voucher] of highest) {
      // Skip if below threshold (unless force)
      if (!forceAll && voucher.amount < this.config.claimThreshold) {
        console.log(`Skipping channel ${channelId}: amount ${voucher.amount} below threshold ${this.config.claimThreshold}`);
        continue;
      }

      // Pre-check: verify on-chain balance before spending gas
      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) {
          console.log(`Channel ${channelId}: on-chain balance is 0, marking as claimed`);
          this.storage.markClaimed(channelId, '0x0' as Hash);
          continue;
        }
      } catch {
        // Balance check failed (RPC issue) -- proceed with claim attempt
      }

      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress,
          abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim',
          args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });

        // Mark as claimed
        this.storage.markClaimed(channelId, hash);
        txHashes.push(hash);

        console.log(`Claimed ${voucher.amount} from channel ${channelId}: ${hash}`);
      } catch (error: any) {
        this.handleClaimError('claim', channelId, error);
      }
    }

    return txHashes;
  }

  /**
   * Get provider address
   */
  getProviderAddress(): Address {
    return this.account.address;
  }

  /**
   * Get channel balance from contract
   */
  async getChannelBalance(channelId: Hash): Promise<bigint> {
    const balance = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: DRAIN_CHANNEL_ABI,
      functionName: 'getBalance',
      args: [channelId],
    });
    return balance as bigint;
  }

  /**
   * Auto-claim channels that are expiring soon.
   * 
   * Claims ANY unclaimed channel where:
   * - Expiry is within `bufferSeconds` from now (default: 1 hour)
   * - There is at least one unclaimed voucher (regardless of threshold)
   * 
   * This protects the provider from losing earned funds when channels expire.
   */
  async claimExpiring(bufferSeconds: number = 3600): Promise<Hash[]> {
    const txHashes: Hash[] = [];
    const highest = this.storage.getHighestVoucherPerChannel();
    const now = Math.floor(Date.now() / 1000);

    for (const [channelId, voucher] of highest) {
      const channel = this.storage.getChannel(channelId);
      if (!channel || !channel.expiry) continue;

      const timeLeft = channel.expiry - now;

      // Skip channels that are not expiring soon
      if (timeLeft > bufferSeconds) continue;

      // Skip zero-value vouchers
      if (voucher.amount <= 0n) continue;

      // Pre-check: verify on-chain balance before spending gas
      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) {
          console.log(`[auto-claim] Channel ${channelId}: on-chain balance is 0, already claimed`);
          this.storage.markClaimed(channelId, '0x0' as Hash);
          continue;
        }
      } catch {
        // Balance check failed (RPC issue) -- proceed with claim attempt
      }

      const status = timeLeft <= 0 ? 'EXPIRED' : `expiring in ${Math.floor(timeLeft / 60)}min`;
      console.log(`[auto-claim] Channel ${channelId} ${status}, claiming ${voucher.amount}...`);

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

  /**
   * Start automatic expiry-based claiming.
   * 
   * Checks every `intervalMinutes` for channels approaching expiry
   * and claims them before the agent can reclaim the funds.
   * 
   * Default: check every 10 minutes, claim if expiring within 1 hour.
   */
  startAutoClaim(intervalMinutes: number = 10, bufferSeconds: number = 3600): void {
    if (this.autoClaimInterval) return;

    console.log(
      `[auto-claim] Started: checking every ${intervalMinutes}min, ` +
      `claiming channels expiring within ${bufferSeconds / 60}min`
    );

    this.autoClaimInterval = setInterval(async () => {
      try {
        const claimed = await this.claimExpiring(bufferSeconds);
        if (claimed.length > 0) {
          console.log(`[auto-claim] Claimed ${claimed.length} expiring channel(s)`);
        }
      } catch (error) {
        console.error('[auto-claim] Error during auto-claim check:', error);
      }
    }, intervalMinutes * 60 * 1000);

    // Also run immediately on start
    this.claimExpiring(bufferSeconds).catch(console.error);
  }

  /**
   * Handle claim errors: decode contract revert reason,
   * mark permanent failures to prevent infinite retries.
   */
  private handleClaimError(context: string, channelId: string, error: any): void {
    // Extract error name from viem's ContractFunctionRevertedError
    const errorName =
      error?.cause?.data?.errorName ||  // viem decoded error
      error?.cause?.reason ||            // older viem format
      undefined;

    if (errorName && PERMANENT_CLAIM_ERRORS.includes(errorName as any)) {
      console.error(`[${context}] ${channelId}: ${errorName} (permanent failure, marking as failed)`);
      this.storage.markClaimed(channelId as Hash, '0x0' as Hash);
    } else {
      // Transient error (RPC timeout, nonce issue, gas) -- will retry next interval
      const shortMsg = error?.shortMessage || error?.message || 'unknown error';
      console.error(`[${context}] ${channelId}: ${shortMsg} (will retry)`);
    }
  }

  /**
   * Stop automatic claiming.
   */
  stopAutoClaim(): void {
    if (this.autoClaimInterval) {
      clearInterval(this.autoClaimInterval);
      this.autoClaimInterval = null;
      console.log('[auto-claim] Stopped');
    }
  }
}
