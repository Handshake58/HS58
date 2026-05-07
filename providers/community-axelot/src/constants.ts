export const DRAIN_ADDRESSES: Record<number, string> = {
  137: '0x0C2B3aA1e80629D572b1f200e6DF3586B3946A8A',
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
    outputs: [
      {
        components: [
          { name: 'consumer', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'deposit', type: 'uint256' },
          { name: 'claimed', type: 'uint256' },
          { name: 'expiry', type: 'uint256' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
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
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'finalAmount', type: 'uint256' },
      { name: 'providerSignature', type: 'bytes' },
    ],
    name: 'cooperativeClose',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  { inputs: [], name: 'ChannelNotFound', type: 'error' },
  { inputs: [], name: 'InvalidAmount', type: 'error' },
  { inputs: [], name: 'InvalidSignature', type: 'error' },
  { inputs: [], name: 'NotExpired', type: 'error' },
  { inputs: [], name: 'NotProvider', type: 'error' },
] as const;

export const PERMANENT_CLAIM_ERRORS = [
  'InvalidAmount',
  'ChannelNotFound',
  'InvalidSignature',
  'NotProvider',
  'NotExpired',
] as const;
