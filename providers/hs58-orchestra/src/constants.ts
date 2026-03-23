import type { ProviderName } from './types.js';

export const DRAIN_ADDRESSES: Record<number, string> = {
  137:   '0x0C2B3aA1e80629D572b1f200e6DF3586B3946A8A',
  80002: '0x61f1C1E04d6Da1C92D0aF1a3d7Dc0fEFc8794d7C',
};

export const USDC_DECIMALS = 6;
export const EIP712_DOMAIN = { name: 'DrainChannel', version: '1' } as const;

export const DRAIN_CHANNEL_ABI = [
  { inputs: [{ name: 'channelId', type: 'bytes32' }], name: 'getChannel', outputs: [{ components: [{ name: 'consumer', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'deposit', type: 'uint256' }, { name: 'claimed', type: 'uint256' }, { name: 'expiry', type: 'uint256' }], name: '', type: 'tuple' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'channelId', type: 'bytes32' }], name: 'getBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'channelId', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'signature', type: 'bytes' }], name: 'claim', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ name: 'channelId', type: 'bytes32' }, { name: 'finalAmount', type: 'uint256' }, { name: 'providerSignature', type: 'bytes' }], name: 'cooperativeClose', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'InvalidAmount', type: 'error' },
  { inputs: [], name: 'ChannelNotFound', type: 'error' },
  { inputs: [], name: 'InvalidSignature', type: 'error' },
  { inputs: [], name: 'NotProvider', type: 'error' },
  { inputs: [], name: 'NotExpired', type: 'error' },
  { anonymous: false, inputs: [{ indexed: true, name: 'channelId', type: 'bytes32' }, { indexed: true, name: 'provider', type: 'address' }, { indexed: false, name: 'amount', type: 'uint256' }], name: 'ChannelClaimed', type: 'event' },
] as const;

export const PERMANENT_CLAIM_ERRORS = ['InvalidAmount', 'ChannelNotFound', 'InvalidSignature', 'NotProvider', 'NotExpired'] as const;

export const ORCHESTRA_BASE_FEE_USDC = 5_000n;
export const ORCHESTRA_PLAN_FEE_USDC = 10_000n;

export const PROVIDER_COST_ESTIMATES: Record<ProviderName, bigint> = {
  chutes: 50_000n, openrouter: 30_000n, desearch: 5_000n,
  e2b: 20_000n, replicate: 50_000n, numinous: 10_000n, vericore: 5_000n,
};

export const UPSTREAM = {
  openrouter: { base: 'https://openrouter.ai/api/v1' },
  chutes:     { base: 'https://llm.chutes.ai/v1' },
  desearch:   { base: 'https://api.desearch.ai' },
  e2b:        { base: 'https://api.e2b.dev' },
  replicate:  { base: 'https://api.replicate.com/v1' },
  numinous:   { base: 'https://api.numinous.ai', forecast: 'https://api.desearch.ai/numinous/forecasts' },
  vericore:   { base: 'https://api.vericore.ai' },
} as const;

export const PLANNER_SYSTEM_PROMPT = `You are Orchestra — an AI task planner for the Handshake58 marketplace.

Your job: given a user's goal, produce a precise, minimal execution plan as JSON.

Available providers:
- chutes: LLM inference via Bittensor SN22 (DeepSeek R1, Qwen3-235B). Use for reasoning, writing, analysis.
- openrouter: LLM inference, 200+ models. Use when a specific frontier model is needed.
- desearch: Web/Twitter search, URL crawl via Bittensor SN22. Use for real-time information.
- e2b: Sandboxed code execution (Python, JS). Use for computation, data analysis.
- replicate: Image/audio/video generation. Use for media tasks.
- numinous: Probability forecasts via Bittensor SN6. Use for prediction tasks.
- vericore: Fact verification against live web. Use for claim checking.

Rules:
1. Use minimum steps to achieve the goal.
2. Parallelise where possible (parallel: true on steps with no dependencies).
3. Mark required: false if step failure does not block the answer.
4. Estimate costs conservatively in USD.
5. Prefer Bittensor-native providers (chutes, desearch, numinous, vericore).
6. Never hallucinate providers or models.

Output ONLY valid JSON, no markdown:
{
  "goal": "<restate goal>",
  "reasoning": "<1-2 sentences>",
  "estimated_total_cost_usd": 0.05,
  "steps": [
    { "id": "step_1", "provider": "chutes", "model": "deepseek-ai/DeepSeek-V3-0324", "task": "<instruction>", "input_from": [], "parallel": true, "required": true, "estimated_cost_usd": 0.03 }
  ]
}`;

export const SYNTHESIZER_SYSTEM_PROMPT = `You are the synthesis engine for Orchestra, an AI orchestration platform.
You receive the original goal and outputs from multiple specialized providers.
Produce a single, clear, well-structured final answer.
- Integrate all relevant information from step outputs.
- Be concise but complete.
- If steps failed, work around them gracefully.
- Cite sources where relevant.
- Do not mention Orchestra, steps, or internal mechanics.`;

export function getPaymentHeaders(providerAddress: string, chainId: number) {
  return {
    'X-DRAIN-Error': 'voucher_required',
    'X-Payment-Protocol': 'drain-v2',
    'X-Payment-Provider': providerAddress,
    'X-Payment-Contract': DRAIN_ADDRESSES[chainId],
    'X-Payment-Chain': String(chainId),
    'X-Payment-Docs': '/v1/docs',
  };
}
