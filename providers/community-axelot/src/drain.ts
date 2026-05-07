import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { DRAIN_ADDRESSES, DRAIN_CHANNEL_ABI, EIP712_DOMAIN, PERMANENT_CLAIM_ERRORS } from './constants.js';
import type { ChannelState, ProviderConfig, StoredVoucher, VoucherHeader } from './types.js';
import { VoucherStorage } from './storage.js';

export class DrainService {
  private publicClient;
  private walletClient;
  private account;
  private contractAddress: Address;
  private autoClaimInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ProviderConfig,
    private readonly storage: VoucherStorage,
  ) {
    const chain = config.chainId === 137 ? polygon : polygonAmoy;
    this.publicClient = createPublicClient({ chain, transport: http(config.polygonRpcUrl) });
    this.account = privateKeyToAccount(config.providerPrivateKey);
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(config.polygonRpcUrl) });
    this.contractAddress = DRAIN_ADDRESSES[config.chainId] as Address;

    if (!config.polygonRpcUrl) {
      console.warn('[drain] POLYGON_RPC_URL not set; public RPC may be rate limited.');
    }
  }

  getProviderAddress(): Address {
    return this.account.address;
  }

  getPaymentHeaders(): Record<string, string> {
    return {
      'X-Payment-Protocol': 'drain-v2',
      'X-Payment-Provider': this.account.address,
      'X-Payment-Contract': this.contractAddress,
      'X-Payment-Chain': String(this.config.chainId),
      'X-Payment-Signing': 'https://handshake58.com/api/drain/signing',
      'X-Payment-Docs': '/v1/docs',
    };
  }

  parseVoucherHeader(header: string): VoucherHeader | null {
    try {
      const parsed = JSON.parse(header) as Partial<VoucherHeader>;
      if (!parsed.channelId || !parsed.amount || !parsed.nonce || !parsed.signature) return null;
      return {
        channelId: parsed.channelId.toLowerCase() as Hash,
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
    requiredAmount: bigint,
  ): Promise<{ valid: boolean; error?: string; channel?: ChannelState; newTotal?: bigint }> {
    try {
      const amount = BigInt(voucher.amount);
      const nonce = BigInt(voucher.nonce);
      const channelData = (await this.publicClient.readContract({
        address: this.contractAddress,
        abi: DRAIN_CHANNEL_ABI,
        functionName: 'getChannel',
        args: [voucher.channelId],
      })) as { consumer: Address; provider: Address; deposit: bigint; expiry: bigint };

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
      }

      const expectedTotal = channelState.totalCharged + requiredAmount;
      if (amount < expectedTotal) return { valid: false, error: 'insufficient_funds', channel: channelState };
      if (amount > channelData.deposit) return { valid: false, error: 'exceeds_deposit', channel: channelState };
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
        message: { channelId: voucher.channelId, amount, nonce },
        signature: voucher.signature,
      });
      if (!isValid) return { valid: false, error: 'invalid_signature' };

      return { valid: true, channel: channelState, newTotal: amount };
    } catch (error) {
      console.error('[drain] Voucher validation error:', error);
      return { valid: false, error: error instanceof Error ? error.message : 'validation_error' };
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

  async getChannelBalance(channelId: Hash): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: DRAIN_CHANNEL_ABI,
      functionName: 'getBalance',
      args: [channelId],
    })) as bigint;
  }

  async claimPayments(forceAll = false): Promise<Hash[]> {
    const hashes: Hash[] = [];
    for (const [channelId, voucher] of this.storage.getHighestVoucherPerChannel()) {
      if (!forceAll && voucher.amount < this.config.claimThreshold) continue;
      try {
        const balance = await this.getChannelBalance(voucher.channelId);
        if (balance === 0n) {
          this.storage.markClaimed(channelId, '0x0' as Hash);
          continue;
        }
      } catch {
        // Proceed with claim attempt.
      }
      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress,
          abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim',
          args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        hashes.push(hash);
      } catch (error) {
        this.handleClaimError('claim', channelId, error);
      }
    }
    return hashes;
  }

  async claimExpiring(bufferSeconds = 3600): Promise<Hash[]> {
    const hashes: Hash[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [channelId, voucher] of this.storage.getHighestVoucherPerChannel()) {
      const channel = this.storage.getChannel(channelId);
      if (!channel || channel.expiry - now > bufferSeconds || voucher.amount <= 0n) continue;
      try {
        const hash = await this.walletClient.writeContract({
          address: this.contractAddress,
          abi: DRAIN_CHANNEL_ABI,
          functionName: 'claim',
          args: [voucher.channelId, voucher.amount, voucher.nonce, voucher.signature],
        });
        this.storage.markClaimed(channelId, hash);
        hashes.push(hash);
      } catch (error) {
        this.handleClaimError('auto-claim', channelId, error);
      }
    }
    return hashes;
  }

  startAutoClaim(intervalMinutes = 10, bufferSeconds = 3600): void {
    if (this.autoClaimInterval) return;
    this.autoClaimInterval = setInterval(() => {
      this.claimExpiring(bufferSeconds).catch((error) => console.error('[auto-claim] failed:', error));
    }, intervalMinutes * 60 * 1000);
    this.claimExpiring(bufferSeconds).catch((error) => console.error('[auto-claim] startup failed:', error));
  }

  async signCloseAuthorization(channelId: Hash): Promise<{ finalAmount: bigint; signature: Hex }> {
    const normalizedId = channelId.toLowerCase() as Hash;
    const highest = this.storage.getHighestVoucherPerChannel().get(normalizedId);
    const finalAmount = highest ? highest.amount : 0n;
    const signature = await this.walletClient.signTypedData({
      domain: {
        name: EIP712_DOMAIN.name,
        version: EIP712_DOMAIN.version,
        chainId: this.config.chainId,
        verifyingContract: this.contractAddress,
      },
      types: {
        CloseAuthorization: [
          { name: 'channelId', type: 'bytes32' },
          { name: 'finalAmount', type: 'uint256' },
        ],
      },
      primaryType: 'CloseAuthorization',
      message: { channelId, finalAmount },
    });
    return { finalAmount, signature };
  }

  private handleClaimError(context: string, channelId: string, error: unknown): void {
    const e = error as { cause?: { data?: { errorName?: string }; reason?: string }; shortMessage?: string; message?: string };
    const errorName = e.cause?.data?.errorName || e.cause?.reason;
    if (errorName && PERMANENT_CLAIM_ERRORS.includes(errorName as never)) {
      console.error(`[${context}] ${channelId}: ${errorName}; marking claimed/failed`);
      this.storage.markClaimed(channelId as Hash, '0x0' as Hash);
      return;
    }
    console.error(`[${context}] ${channelId}: ${e.shortMessage || e.message || 'unknown error'}`);
  }
}
