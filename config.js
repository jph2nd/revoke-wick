// revoke.wick.pics — configuration
// Every address below was verified on-chain (eth_getCode + interface calls)
// against PulseChain mainnet, chainId 369.

export const CHAIN = {
  id: 369,
  idHex: '0x171',
  name: 'PulseChain',
  currency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
  explorer: 'https://scan.pulsechain.com',
};

// CORS-verified public endpoints (Access-Control-Allow-Origin: *), measured in
// sync with each other. Order = failover order, and it is ordered by MEASURED
// throughput, not by how official the hostname looks.
//
// Measured with a 40-call eth_call batch:
//   pulsechain-rpc.publicnode.com     81 ms
//   pulsechain.publicnode.com        166 ms
//   rpc-pulsechain.g4mm4.io          193 ms
//   rpc.pulsechain.com            TIMED OUT (>25s); 3,786 ms even at 10 calls
//
// rpc.pulsechain.com is the canonical endpoint and the obvious default, but it
// degrades hard under batch load and after a burst of full-history getLogs.
// It stays in the list as a last resort, never as the primary.
// Excluded, confirmed dead/CORS-less: rpc.pulsechain.dev, evex.cloud/pulsechain.
export const RPCS = [
  'https://pulsechain-rpc.publicnode.com',
  'https://pulsechain.publicnode.com',
  'https://rpc-pulsechain.g4mm4.io',
  'https://rpc.pulsechain.com',
];

export const TOKENS = {
  WICK: '0x8CDaf3d630Da9E1450832924D5701CC0500E9cfC',
  WPLS: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
};

export const BURN_ADDRESS = '0x0000000000000000000000000000000000000369';

// Deployed by scripts/deploy.py — filled in after deployment.
export const FEE_CONTRACT = '0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000';

// Fees in whole PLS. Must match the on-chain values; the UI reads the
// contract's real values at load and these are only the fallback display.
export const FEES = {
  single: 50_000n,
  batch: 250_000n,
};

// Event topics — computed with keccak256, verified against known values.
export const TOPICS = {
  // Approval(address,address,uint256) — shared by ERC20 and ERC721.
  // Disambiguated by topic count: 3 topics => ERC20, 4 topics => ERC721.
  Approval:
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  // ApprovalForAll(address,address,bool) — ERC721 and ERC1155.
  ApprovalForAll:
    '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
};

// Function selectors — computed with keccak256 and sanity-checked against
// the canonical published values for approve() and balanceOf().
export const SEL = {
  // token reads
  allowance: '0xdd62ed3e',
  isApprovedForAll: '0xe985e9c5',
  getApproved: '0x081812fc',
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  // token writes (the actual revokes)
  approve: '0x095ea7b3',
  setApprovalForAll: '0xa22cb465',
  // fee contract
  payRevokeFee: '0x720ace64',
  payBatchFee: '0x6b83a055',
  burn: '0x42966c68',
  previewBurn: '0xeb0fda7e',
  stats: '0xd80528ae',
  singleFee: '0xd3b16175',
  batchFee: '0xf8b823e4',
  burnReadyIn: '0x274cfaf0',
};

// Scanning. PulseChain has ~27.2M blocks; a normal wallet's full-history scan
// returns in well under a second, but a bot wallet that re-approves on every
// trade can return 38,000+ logs / 23 MB. Chunking bounds any single response
// and lets results stream in newest-first.
export const SCAN = {
  chunkBlocks: 4_000_000,
  minChunkBlocks: 25_000,
  maxBatchCalls: 40,
  // Heavy full-history getLogs legitimately takes seconds; give it room.
  requestTimeoutMs: 30_000,
  // eth_call batches answer in well under a second on a healthy endpoint, so a
  // slow one is a sick one — fail over fast instead of stalling the whole scan.
  callTimeoutMs: 10_000,
  // Chunks run in parallel. Sequential full-history scanning measured ~22s;
  // 4-way concurrency brings it under ~6s while staying inside public-RPC
  // rate limits.
  concurrency: 4,
  // Delay before a slow request is hedged onto a second provider. Long enough
  // that a healthy endpoint answers alone; short enough to cut the tail.
  hedgeMs: 3_000,
};

// Well-known spenders, so users see a name instead of a raw address.
export const SPENDER_LABELS = {
  '0x98bf93ebf5c380c0e6ae8e192a7e2ae08edacc02': 'PulseX Router V1',
  '0x165c3410fc91ef562c50559f7d2289febed552d9': 'PulseX Router V2',
  '0xf6076d61a0c46c944852f65838e1b12a2910a717': '9mm V3 SwapRouter',
  '0xa9444246d80d6e3496c9242395213b4f22226a59': '9mm SmartRouter',
  '0xcc73b59f8d7b7c532703bdfea2808a28a488cf47': '9mm V2 Router',
  '0xcc05bf158202b4f461ede8843d76dcd7bbad07f2': '9mm V3 Position Manager',
  '0x6bf228eb7f8ad948d37ded07e595efddfaaf88a6': 'Piteas Aggregator',
  '0x42556a17ef0bd815bf21ad628dfd2e2f3b5f9ac7': '9inch SmartRouter',
  '0xca11bde05977b3631167028862be2a173976ca11': 'Multicall3',
};
