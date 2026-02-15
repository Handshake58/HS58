/**
 * DRAIN Protocol Constants (inline for standalone deployment)
 */

// Contract Addresses
export const DRAIN_ADDRESSES: Record<number, string> = {
  137: '0x1C1918C99b6DcE977392E4131C91654d8aB71e64',
  80002: '0x61f1C1E04d6Da1C92D0aF1a3d7Dc0fEFc8794d7C',
};

// USDC has 6 decimals
export const USDC_DECIMALS = 6;

// EIP-712 Domain
export const EIP712_DOMAIN = {
  name: 'DrainChannel',
  version: '1',
} as const;

// DrainChannel ABI (functions + errors + events)
export const DRAIN_CHANNEL_ABI = [
  // === Functions ===
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
  // === Custom Errors (from DrainChannel.sol) ===
  { inputs: [], name: 'NotOwner', type: 'error' },
  { inputs: [], name: 'NoOwner', type: 'error' },
  { inputs: [], name: 'ZeroAddress', type: 'error' },
  { inputs: [], name: 'ChannelExists', type: 'error' },
  { inputs: [], name: 'ChannelNotFound', type: 'error' },
  { inputs: [], name: 'NotProvider', type: 'error' },
  { inputs: [], name: 'NotConsumer', type: 'error' },
  { inputs: [], name: 'NotExpired', type: 'error' },
  { inputs: [], name: 'InvalidSignature', type: 'error' },
  { inputs: [], name: 'InvalidAmount', type: 'error' },
  { inputs: [], name: 'TransferFailed', type: 'error' },
  // === Events ===
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'channelId', type: 'bytes32' },
      { indexed: true, name: 'provider', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
    name: 'ChannelClaimed',
    type: 'event',
  },
] as const;

/**
 * Permanent claim failure errors -- these will never succeed on retry.
 * Used to mark vouchers as failed and stop retrying.
 */
export const PERMANENT_CLAIM_ERRORS = [
  'InvalidAmount',      // amount > deposit OR amount <= already claimed
  'ChannelNotFound',    // channel doesn't exist
  'InvalidSignature',   // signature doesn't match consumer
  'NotProvider',        // caller is not the channel's provider
  'NotExpired',         // only relevant for close(), not claim()
] as const;
