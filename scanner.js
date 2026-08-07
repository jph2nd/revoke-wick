// Approval discovery.
//
// Logs only tell you an approval once EXISTED. They never tell you whether it
// is still live — a token that was approved and later revoked still has its
// Approval log forever. So discovery is two phases:
//
//   1. getLogs, filtered by topic0 (event) + topic1 (owner), to find every
//      (token, spender) pair this wallet has ever touched.
//   2. re-read the CURRENT on-chain state for each unique pair, and keep only
//      the ones that are still non-zero / still true.
//
// Phase 2 is what makes the result trustworthy, and it is cheap because the
// unique-pair count is tiny even for wallets with tens of thousands of logs.

import { SCAN, TOPICS, SEL } from './config.js';
import {
  rpc,
  rpcBatch,
  ethCall,
  addressTopic,
  topicToAddress,
  padAddress,
  padUint,
  decodeUint,
  decodeBool,
  decodeAddress,
  decodeString,
  getLogsAdaptive,
} from './rpc.js';

export const KIND = {
  ERC20: 'erc20',
  ERC721_ONE: 'erc721-token',
  FOR_ALL: 'for-all',
};

export const UNLIMITED_THRESHOLD = (1n << 255n); // treat >= 2^255 as "unlimited"

export async function getLatestBlock() {
  return Number(decodeUint(await rpc('eth_blockNumber', [])));
}

/**
 * Phase 1 — find every (token, spender) pair the owner has ever approved.
 * Scans newest-first so the UI can show recent, most-relevant approvals early.
 */
export async function discoverPairs(owner, latestBlock, onProgress) {
  const ownerTopic = addressTopic(owner);
  const pairs = new Map();

  // Ask for the ENTIRE history in one request per event type.
  //
  // Pre-chunking is a trap here: a filtered getLogs costs the node a bloom
  // scan over the range, so N chunks cost roughly N times a single full-range
  // query. Measured on a 10-approval wallet: one full-range call = 3.1s, the
  // same scan pre-split into 7 chunks = 15.7s. getLogsAdaptive already halves
  // the range on failure, so handing it [0, latest] gives the fast path by
  // default and degrades only for the rare wallet that overflows a response.
  let ranges = 0;
  const onRange = (lo, hi, n) => {
    ranges++;
    if (onProgress) {
      onProgress({
        phase: 'logs',
        done: ranges,
        total: null, // unknown up front; adaptive splitting decides
        found: pairs.size,
        fromBlock: lo,
        toBlock: hi,
        logs: n,
      });
    }
  };

  {
    const [approvals, forAlls] = await Promise.all([
      getLogsAdaptive(0, latestBlock, [TOPICS.Approval, ownerTopic], onRange),
      getLogsAdaptive(
        0,
        latestBlock,
        [TOPICS.ApprovalForAll, ownerTopic],
        onRange
      ),
    ]);

    for (const log of approvals) {
      // ERC20 Approval has 3 topics (value is in data).
      // ERC721 Approval has 4 topics (tokenId is indexed).
      const isNft = log.topics.length === 4;
      const spender = topicToAddress(log.topics[2]);
      const tokenId = isNft ? decodeUint(log.topics[3]) : null;
      const key = isNft
        ? `${log.address.toLowerCase()}|${spender}|${tokenId}`
        : `${log.address.toLowerCase()}|${spender}`;
      pairs.set(key, {
        key,
        kind: isNft ? KIND.ERC721_ONE : KIND.ERC20,
        token: log.address.toLowerCase(),
        spender,
        tokenId,
        lastBlock: Number(decodeUint(log.blockNumber)),
      });
    }

    for (const log of forAlls) {
      const spender = topicToAddress(log.topics[2]);
      const key = `${log.address.toLowerCase()}|${spender}|all`;
      pairs.set(key, {
        key,
        kind: KIND.FOR_ALL,
        token: log.address.toLowerCase(),
        spender,
        tokenId: null,
        lastBlock: Number(decodeUint(log.blockNumber)),
      });
    }

  }

  return [...pairs.values()];

}

/**
 * Phase 2 — re-read live on-chain state and drop everything already revoked.
 * Also pulls token metadata and the owner's balance, so the UI can show what
 * is actually at risk rather than a meaningless raw allowance.
 */
export async function resolveActive(owner, pairs, onProgress) {
  if (pairs.length === 0) return [];

  // --- current approval state ---------------------------------------------
  const stateCalls = pairs.map((p) => {
    if (p.kind === KIND.ERC20) {
      return ethCall(
        p.token,
        SEL.allowance + padAddress(owner) + padAddress(p.spender)
      );
    }
    if (p.kind === KIND.FOR_ALL) {
      return ethCall(
        p.token,
        SEL.isApprovedForAll + padAddress(owner) + padAddress(p.spender)
      );
    }
    return ethCall(p.token, SEL.getApproved + padUint(p.tokenId));
  });

  if (onProgress) onProgress({ phase: 'state', total: pairs.length });
  const states = await rpcBatch(stateCalls);

  const active = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const raw = states[i];
    if (raw == null) continue; // unreadable — assume gone rather than alarm

    if (p.kind === KIND.ERC20) {
      const allowance = decodeUint(raw);
      if (allowance > 0n) active.push({ ...p, allowance });
    } else if (p.kind === KIND.FOR_ALL) {
      if (decodeBool(raw)) active.push({ ...p, allowance: null });
    } else {
      const approved = decodeAddress(raw);
      if (approved && approved === p.spender) {
        active.push({ ...p, allowance: null });
      }
    }
  }

  if (active.length === 0) return [];

  // --- token metadata, one batch per field over unique tokens -------------
  const tokens = [...new Set(active.map((a) => a.token))];
  if (onProgress) onProgress({ phase: 'metadata', total: tokens.length });

  const metaCalls = [];
  for (const t of tokens) {
    metaCalls.push(ethCall(t, SEL.symbol));
    metaCalls.push(ethCall(t, SEL.name));
    metaCalls.push(ethCall(t, SEL.decimals));
    metaCalls.push(ethCall(t, SEL.balanceOf + padAddress(owner)));
  }
  const metaRaw = await rpcBatch(metaCalls);

  const meta = new Map();
  tokens.forEach((t, i) => {
    const base = i * 4;
    const decRaw = metaRaw[base + 2];
    meta.set(t, {
      symbol: decodeString(metaRaw[base]) || '???',
      name: decodeString(metaRaw[base + 1]) || 'Unknown token',
      decimals: decRaw == null ? 18 : Number(decodeUint(decRaw)),
      balance: metaRaw[base + 3] == null ? 0n : decodeUint(metaRaw[base + 3]),
    });
  });

  return active.map((a) => ({ ...a, meta: meta.get(a.token) }));
}

/** Full scan: discovery + live-state resolution. */
export async function scanApprovals(owner, onProgress) {
  const latest = await getLatestBlock();
  const pairs = await discoverPairs(owner, latest, onProgress);
  const active = await resolveActive(owner, pairs, onProgress);
  // Riskiest first: unlimited allowances and blanket operator rights on top.
  active.sort((a, b) => {
    const risk = (x) =>
      x.kind === KIND.FOR_ALL
        ? 3
        : x.allowance && x.allowance >= UNLIMITED_THRESHOLD
          ? 2
          : 1;
    const d = risk(b) - risk(a);
    return d !== 0 ? d : b.lastBlock - a.lastBlock;
  });
  return { latest, scanned: pairs.length, approvals: active };
}

/** Calldata that revokes a given approval. */
export function revokeCalldata(item) {
  if (item.kind === KIND.ERC20) {
    return { to: item.token, data: SEL.approve + padAddress(item.spender) + padUint(0) };
  }
  if (item.kind === KIND.FOR_ALL) {
    return {
      to: item.token,
      data: SEL.setApprovalForAll + padAddress(item.spender) + padUint(0),
    };
  }
  // Single-NFT approval is cleared by approving the zero address.
  return {
    to: item.token,
    data:
      SEL.approve +
      padAddress('0x0000000000000000000000000000000000000000') +
      padUint(item.tokenId),
  };
}
