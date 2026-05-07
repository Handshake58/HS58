import { ApiPromise, WsProvider } from '@polkadot/api';
import { stringCamelCase } from '@polkadot/util';
import type { ProviderConfig, StakePosition, SubnetSummary } from './types.js';
import { raoToTao } from './math.js';

interface PoolRaw {
  netuid: number;
  taoReserve: bigint;
  alphaIn: bigint;
  alphaOut: bigint;
  price: number;
  movingPrice: number;
  emission: bigint;
  tempo: number;
  ownerHotkey: string | null;
}

interface MarketCache {
  timestamp: number;
  blockNumber: number;
  subnets: SubnetSummary[];
}

export class BittensorClient {
  private api: ApiPromise | null = null;
  private provider: WsProvider | null = null;
  private marketCache: MarketCache | null = null;

  constructor(private readonly config: ProviderConfig) {}

  async connect(): Promise<void> {
    if (this.api?.isConnected) return;
    this.provider = new WsProvider(this.config.subtensorEndpoint);
    this.api = await ApiPromise.create({ provider: this.provider });
    console.log(`[bittensor] connected to ${this.config.subtensorEndpoint}`);
  }

  async disconnect(): Promise<void> {
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
    if (this.provider) {
      await this.provider.disconnect();
      this.provider = null;
    }
  }

  get connected(): boolean {
    return Boolean(this.api?.isConnected);
  }

  async getBlockNumber(): Promise<number> {
    const api = await this.requireApi();
    const header = await api.rpc.chain.getHeader();
    return header.number.toNumber();
  }

  async getSubnetList(): Promise<number[]> {
    const api = await this.requireApi();
    const mod = api.query[stringCamelCase('SubtensorModule')];
    const entries = await mod[stringCamelCase('NetworksAdded')].entries();
    const out: number[] = [];
    for (const [key, value] of entries) {
      const active = (value as unknown as { toPrimitive: () => boolean }).toPrimitive();
      if (!active) continue;
      const netuid = (key.args[0] as unknown as { toNumber: () => number }).toNumber();
      out.push(netuid);
      if (out.length >= this.config.maxSubnetScan) break;
    }
    return out.sort((a, b) => a - b);
  }

  async getPoolData(netuid: number): Promise<PoolRaw | null> {
    const api = await this.requireApi();
    const mod = api.query[stringCamelCase('SubtensorModule')];
    try {
      const [taoRaw, alphaInRaw, alphaOutRaw, emissionRaw, tempoRaw, movingRaw, ownerRaw] = await Promise.all([
        mod[stringCamelCase('SubnetTAO')](netuid),
        mod[stringCamelCase('SubnetAlphaIn')](netuid),
        mod[stringCamelCase('SubnetAlphaOut')](netuid),
        mod[stringCamelCase('SubnetAlphaOutEmission')](netuid).catch(() => ({ toString: () => '0' })),
        mod[stringCamelCase('Tempo')](netuid).catch(() => ({ toString: () => '360' })),
        mod[stringCamelCase('SubnetMovingPrice')](netuid).catch(() => null),
        mod[stringCamelCase('SubnetOwnerHotkey')](netuid).catch(() => null),
      ]);

      const taoReserve = BigInt((taoRaw as { toString: () => string }).toString());
      const alphaIn = BigInt((alphaInRaw as { toString: () => string }).toString());
      const alphaOut = BigInt((alphaOutRaw as { toString: () => string }).toString());
      const price = alphaIn > 0n ? Number((taoReserve * 1_000_000_000n) / alphaIn) / 1e9 : 0;
      const movingRawString = movingRaw ? (movingRaw as { toString: () => string }).toString() : '';
      const movingPrice = movingRawString ? Number(movingRawString) / 1e18 : price;
      const ownerHotkey = ownerRaw ? (ownerRaw as { toString: () => string }).toString() || null : null;

      return {
        netuid,
        taoReserve,
        alphaIn,
        alphaOut,
        price,
        movingPrice: Number.isFinite(movingPrice) && movingPrice > 0 ? movingPrice : price,
        emission: BigInt((emissionRaw as { toString: () => string }).toString()),
        tempo: Number((tempoRaw as { toString: () => string }).toString()) || 360,
        ownerHotkey,
      };
    } catch (error) {
      console.warn(`[bittensor] getPoolData(${netuid}) failed:`, error);
      return null;
    }
  }

  async getMarketSnapshot(force = false): Promise<MarketCache> {
    if (!force && this.marketCache && Date.now() - this.marketCache.timestamp < this.config.marketCacheTtlMs) {
      return this.marketCache;
    }

    const [blockNumber, netuids] = await Promise.all([this.getBlockNumber(), this.getSubnetList()]);
    const pools = await Promise.all(netuids.map((netuid) => this.getPoolData(netuid)));
    const totalEmission = pools.reduce((sum, p) => sum + (p?.emission ?? 0n), 0n);

    const subnets = pools
      .filter((p): p is PoolRaw => p !== null && p.price > 0)
      .map((pool): SubnetSummary => {
        const emissionPct = totalEmission > 0n ? (Number(pool.emission) / Number(totalEmission)) * 100 : 0;
        const trendVsMovingPct = pool.movingPrice > 0 ? ((pool.price - pool.movingPrice) / pool.movingPrice) * 100 : null;
        const taoReserve = raoToTao(pool.taoReserve);
        return {
          netuid: pool.netuid,
          taoReserve,
          alphaIn: raoToTao(pool.alphaIn),
          alphaOut: raoToTao(pool.alphaOut),
          spotPrice: pool.price,
          movingPrice: pool.movingPrice,
          emissionPerBlock: raoToTao(pool.emission),
          emissionPct,
          liquidityScore: Math.log10(Math.max(1, taoReserve)),
          trendVsMovingPct,
          tempo: pool.tempo,
          ownerHotkey: pool.ownerHotkey,
          blockNumber,
        };
      })
      .sort((a, b) => b.taoReserve - a.taoReserve);

    this.marketCache = { timestamp: Date.now(), blockNumber, subnets };
    return this.marketCache;
  }

  async getFreeBalance(address: string): Promise<bigint | null> {
    const api = await this.requireApi();
    try {
      const accountInfo = await api.query.system.account(address);
      const data = (accountInfo as unknown as { data: { free: { toString: () => string } } }).data;
      return BigInt(data.free.toString());
    } catch {
      return null;
    }
  }

  async getStakesForColdkey(coldkey: string): Promise<StakePosition[]> {
    const api = await this.requireApi();
    const callRoot = (api as unknown as { call?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> }).call;
    const runtimeApi = callRoot?.stakeInfoRuntimeApi;
    if (!runtimeApi || typeof runtimeApi.getStakeInfoForColdkey !== 'function') return [];

    const raw = await runtimeApi.getStakeInfoForColdkey(coldkey);
    const json = (raw as { toJSON?: () => unknown }).toJSON?.() ?? raw;
    if (!Array.isArray(json)) return [];

    const out: StakePosition[] = [];
    for (const item of json as Array<Record<string, unknown>>) {
      const netuid = Number(item.netuid);
      const delegateHotkey = String(item.hotkey ?? '');
      const stakeRaw = item.stake;
      if (!Number.isFinite(netuid) || !delegateHotkey || stakeRaw == null) continue;
      let alphaRao = 0n;
      try {
        alphaRao = BigInt(typeof stakeRaw === 'object' && stakeRaw !== null ? (stakeRaw as { toString: () => string }).toString() : String(stakeRaw));
      } catch {
        alphaRao = 0n;
      }
      if (alphaRao <= 0n) continue;
      const pool = await this.getPoolData(netuid);
      const spotPrice = pool?.price ?? 0;
      const alpha = raoToTao(alphaRao);
      out.push({
        netuid,
        delegateHotkey,
        alphaRao: alphaRao.toString(),
        alpha,
        taoValue: alpha * spotPrice,
        spotPrice,
      });
    }
    return out.sort((a, b) => b.taoValue - a.taoValue);
  }

  async monitorExtrinsic(txHash: string, depth = 60): Promise<{ found: boolean; blockNumber?: number; blockHash?: string; extrinsicIndex?: number; searchedBlocks: number }> {
    const api = await this.requireApi();
    const head = await api.rpc.chain.getHeader();
    const latest = head.number.toNumber();
    const normalized = txHash.toLowerCase();
    const maxDepth = Math.max(1, Math.min(depth, 500));

    for (let n = latest; n >= Math.max(0, latest - maxDepth + 1); n--) {
      const blockHash = await api.rpc.chain.getBlockHash(n);
      const signed = await api.rpc.chain.getBlock(blockHash);
      const idx = signed.block.extrinsics.findIndex((ext) => ext.hash.toHex().toLowerCase() === normalized);
      if (idx >= 0) {
        return { found: true, blockNumber: n, blockHash: blockHash.toHex(), extrinsicIndex: idx, searchedBlocks: latest - n + 1 };
      }
    }
    return { found: false, searchedBlocks: maxDepth };
  }

  private async requireApi(): Promise<ApiPromise> {
    await this.connect();
    if (!this.api) throw new Error('Subtensor API not connected');
    return this.api;
  }
}
