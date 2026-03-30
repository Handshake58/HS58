// ─── DRAIN protocol constants (DO NOT MODIFY) ────────────────────────────────

export const DRAIN_ADDRESSES: Record<number, string> = {
  137:   '0x0C2B3aA1e80629D572b1f200e6DF3586B3946A8A',
  80002: '0x61f1C1E04d6Da1C92D0aF1a3d7Dc0fEFc8794d7C',
};

export const USDC_DECIMALS = 6;

export const EIP712_DOMAIN = {
  name: 'DrainChannel',
  version: '1',
} as const;

export const DRAIN_CHANNEL_ABI = [
  {
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    name: 'getChannel',
    outputs: [{
      components: [
        { name: 'consumer',  type: 'address' },
        { name: 'provider',  type: 'address' },
        { name: 'deposit',   type: 'uint256' },
        { name: 'claimed',   type: 'uint256' },
        { name: 'expiry',    type: 'uint256' },
      ],
      name: '', type: 'tuple',
    }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    name: 'getBalance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'amount',    type: 'uint256' },
      { name: 'nonce',     type: 'uint256' },
      { name: 'signature', type: 'bytes'   },
    ],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'channelId',         type: 'bytes32' },
      { name: 'finalAmount',       type: 'uint256' },
      { name: 'providerSignature', type: 'bytes'   },
    ],
    name: 'cooperativeClose',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  { inputs: [], name: 'InvalidAmount',    type: 'error' },
  { inputs: [], name: 'ChannelNotFound',  type: 'error' },
  { inputs: [], name: 'InvalidSignature', type: 'error' },
  { inputs: [], name: 'NotProvider',      type: 'error' },
  { inputs: [], name: 'NotExpired',       type: 'error' },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'channelId', type: 'bytes32' },
      { indexed: true,  name: 'provider',  type: 'address' },
      { indexed: false, name: 'amount',    type: 'uint256' },
    ],
    name: 'ChannelClaimed',
    type: 'event',
  },
] as const;

export const PERMANENT_CLAIM_ERRORS = [
  'InvalidAmount',
  'ChannelNotFound',
  'InvalidSignature',
  'NotProvider',
  'NotExpired',
] as const;

// ─── Mozart pricing ───────────────────────────────────────────────────────────

export const MOZART_BASE_FEE_USDC = 5_000n;   // $0.005 per orchestration
export const MOZART_PLAN_FEE_USDC  = 10_000n; // $0.010 for plan-only

// ─── Upstream provider base URLs ──────────────────────────────────────────────

export const UPSTREAM = {
  chutes:     { base: 'https://llm.chutes.ai/v1' },
  openrouter: { base: 'https://openrouter.ai/api/v1' },
  desearch:   { base: 'https://api.desearch.ai' },
  numinous:   { base: 'https://api.numinous.ai', forecast: 'https://api.numinous.ai/v1/predictions' },
  vericore:   { base: 'https://api.vericore.ai' },
  e2b:        { base: 'https://api.e2b.dev' },
  replicate:  { base: 'https://api.replicate.com/v1' },
} as const;

// ─── Per-provider cost estimates (USDC micro, 6 decimals) ─────────────────────

export const PROVIDER_COST_ESTIMATES: Record<string, bigint> = {
  chutes:     20_000n,   // $0.020
  openrouter: 30_000n,   // $0.030
  desearch:   5_000n,    // $0.005
  numinous:   10_000n,   // $0.010
  vericore:   5_000n,    // $0.005
  e2b:        50_000n,   // $0.050
  replicate:  40_000n,   // $0.040
};

// ─── Planner system prompt ────────────────────────────────────────────────────

export const PLANNER_SYSTEM_PROMPT = `You are an AI orchestration planner. Given a user goal, produce a minimal JSON execution plan.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "goal": "<goal>",
  "reasoning": "<why this plan>",
  "estimated_total_cost_usd": <number>,
  "steps": [
    {
      "id": "step_1",
      "provider": "chutes" | "desearch" | "numinous" | "vericore" | "e2b" | "replicate",
      "model": "<model id or task>",
      "task": "<specific instruction for this step>",
      "input_from": ["step_id", ...],
      "parallel": true,
      "required": true,
      "estimated_cost_usd": <number>
    }
  ]
}

Rules:
- Use chutes for LLM tasks (model: "deepseek-ai/DeepSeek-V3-0324-TEE")
- Use desearch for web search, news, Twitter queries
- Use numinous for forecasting/prediction tasks
- Use vericore for fact-checking
- ONLY use providers: chutes, desearch, numinous, vericore, e2b, replicate
- NEVER use openrouter — it is not available
- Keep plans minimal — 1-4 steps for most goals
- Set input_from to depend on prior step IDs when output chaining is needed
- parallel: true means this step can run in parallel with other same-wave steps`;

// ─── Synthesizer system prompt ────────────────────────────────────────────────

export const SYNTHESIZER_SYSTEM_PROMPT = `You are a synthesis AI. You receive outputs from multiple AI agents that each worked on part of a goal.
Your job is to merge their outputs into one clean, comprehensive answer.

- Integrate all relevant information naturally
- Resolve any contradictions by noting them
- Keep the response focused on the original goal
- Write in clear, direct prose
- Do not mention the internal step structure or provider names`;
