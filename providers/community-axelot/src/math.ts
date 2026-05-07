export const RAO_PER_TAO = 1_000_000_000n;
export const FIXED_EXTRINSIC_FEE_TAO = 0.00135;
export const FRICTION_SAFETY_BUFFER_TAO = 0.00015;

export function taoToRao(tao: number): bigint {
  if (!Number.isFinite(tao) || tao < 0) throw new Error('TAO amount must be a non-negative finite number');
  return BigInt(Math.round(tao * 1e9));
}

export function raoToTao(rao: bigint): number {
  return Number(rao) / 1e9;
}

function poolImpactTao(amountTao: number, poolReserveTao: number, multiplier = 1): number {
  if (!Number.isFinite(amountTao) || amountTao <= 0) return 0;
  if (!Number.isFinite(poolReserveTao) || poolReserveTao <= 0) return amountTao * 0.05 * multiplier;
  return amountTao * (amountTao / (2 * poolReserveTao)) * multiplier;
}

export function estimateOneWayFriction(input: { amountTao: number; poolReserveTao: number; action?: 'stake' | 'unstake' | 'move' | 'swap' }): number {
  const poolMultiplier = input.action === 'move' || input.action === 'swap' ? 2 : 1;
  return FIXED_EXTRINSIC_FEE_TAO + FRICTION_SAFETY_BUFFER_TAO + poolImpactTao(input.amountTao, input.poolReserveTao, poolMultiplier);
}

export function estimateRoundTripBreakEven(input: { amountTao: number; poolReserveTao: number }): number {
  return (
    estimateOneWayFriction({ ...input, action: 'stake' }) +
    estimateOneWayFriction({ ...input, action: 'unstake' })
  );
}

export function orderImpactPct(amountTao: number, poolReserveTao: number): number | null {
  if (!Number.isFinite(amountTao) || amountTao <= 0 || !Number.isFinite(poolReserveTao) || poolReserveTao <= 0) return null;
  return (amountTao / (2 * poolReserveTao)) * 100;
}

export function computeAlphaRaoForTaoExit(input: {
  amountTao: number;
  taoReserveRao: bigint;
  alphaInRao: bigint;
  fullBalanceAlphaRao?: bigint;
}): { alphaRao: bigint; clamped: boolean } {
  if (input.amountTao <= 0) return { alphaRao: 0n, clamped: false };
  const dTaoRao = taoToRao(input.amountTao);
  let desired: bigint;

  if (input.taoReserveRao > 0n && input.alphaInRao > 0n && dTaoRao < input.taoReserveRao) {
    desired = (input.alphaInRao * dTaoRao) / (input.taoReserveRao - dTaoRao);
  } else {
    desired = input.fullBalanceAlphaRao ?? 0n;
  }

  if (input.fullBalanceAlphaRao && desired >= input.fullBalanceAlphaRao) {
    return { alphaRao: (input.fullBalanceAlphaRao * 995n) / 1000n, clamped: true };
  }

  return { alphaRao: desired, clamped: false };
}

export function makeIntentId(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url').slice(0, 24);
  return `axelot_${Date.now().toString(36)}_${encoded}`;
}
