// Minimal JSON-RPC client + ABI codec. No dependencies by design: this site
// is served as static files and must keep working with no build step and no
// third-party runtime it cannot audit.

import { RPCS, SCAN } from './config.js';

let rpcIndex = 0;
let nextId = 1;

/** Rotate to the next endpoint after a failure. */
function rotate() {
  rpcIndex = (rpcIndex + 1) % RPCS.length;
}

export function currentRpc() {
  return RPCS[rpcIndex];
}

async function post(body, timeoutMs = SCAN.requestTimeoutMs) {
  let lastErr;
  // Try every endpoint once before giving up.
  for (let attempt = 0; attempt < RPCS.length; attempt++) {
    const url = RPCS[rpcIndex];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      rotate();
    }
  }
  throw lastErr ?? new Error('all RPC endpoints failed');
}

/** Single JSON-RPC call. Throws on a JSON-RPC error object. */
export async function rpc(method, params = []) {
  const out = await post({ jsonrpc: '2.0', id: nextId++, method, params });
  if (out.error) {
    const err = new Error(out.error.message || 'rpc error');
    err.code = out.error.code;
    throw err;
  }
  return out.result;
}

/**
 * Batched JSON-RPC. Returns results positionally, with `null` where an
 * individual call errored — a failed metadata read must never sink the batch.
 */
export async function rpcBatch(calls) {
  if (calls.length === 0) return [];
  const results = new Array(calls.length).fill(null);

  for (let i = 0; i < calls.length; i += SCAN.maxBatchCalls) {
    const slice = calls.slice(i, i + SCAN.maxBatchCalls);
    const body = slice.map((c, j) => ({
      jsonrpc: '2.0',
      id: i + j,
      method: c.method,
      params: c.params,
    }));
    let out;
    try {
      out = await post(body, SCAN.callTimeoutMs);
    } catch {
      continue; // leave this slice as nulls
    }
    if (!Array.isArray(out)) continue;
    for (const r of out) {
      if (typeof r.id === 'number' && !r.error) results[r.id] = r.result;
    }
  }
  return results;
}

/**
 * HEDGED request: start on one endpoint, and only bring in another if the
 * first is still silent after `hedgeMs`. First success wins and cancels the rest.
 *
 * Public PulseChain RPCs have wildly variable latency — the identical
 * full-history getLogs measured 2.2s, 3.1s, 4.3s and 14.1s across runs. With
 * no backend to cache behind, using a second provider is the only lever we have.
 *
 * Do NOT turn this back into an unconditional 3-way race. That was measured and
 * it backfires: firing every heavy getLogs at three providers at once burns
 * quota on all of them, and the follow-up allowance batch got throttled from
 * 403ms to 48s. Hedging keeps the common case at exactly one request.
 */
export async function rpcRace(
  method,
  params = [],
  width = 3,
  hedgeMs = SCAN.hedgeMs
) {
  const urls = RPCS.slice(0, Math.min(width, RPCS.length));
  const ctrls = [];
  const errors = [];
  let done = false;

  const attempt = (url, i) => {
    const ctrl = new AbortController();
    ctrls[i] = ctrl;
    const timer = setTimeout(() => ctrl.abort(), SCAN.requestTimeoutMs);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const out = await res.json();
        if (out.error) {
          const err = new Error(out.error.message || 'rpc error');
          err.code = out.error.code;
          throw err;
        }
        return out.result;
      })
      .finally(() => clearTimeout(timer));
  };

  return new Promise((resolve, reject) => {
    let started = 0;
    let outstanding = 0;

    const settleOk = (v) => {
      if (done) return;
      done = true;
      ctrls.forEach((c) => {
        try {
          c.abort();
        } catch {
          /* already settled */
        }
      });
      resolve(v);
    };

    const settleErr = (e) => {
      errors.push(e);
      outstanding--;
      if (done) return;
      if (started < urls.length) {
        launch(); // a failure immediately promotes the next endpoint
      } else if (outstanding === 0) {
        reject(errors[0] ?? new Error('all RPC endpoints failed'));
      }
    };

    function launch() {
      const i = started++;
      outstanding++;
      attempt(urls[i], i).then(settleOk, settleErr);
      if (started < urls.length) {
        const t = setTimeout(() => {
          if (!done && started < urls.length) launch();
        }, hedgeMs);
        // Don't keep a Node process alive just for a hedge timer.
        if (typeof t?.unref === 'function') t.unref();
      }
    }

    launch();
  });
}

export function ethCall(to, data, tag = 'latest') {
  return { method: 'eth_call', params: [{ to, data }, tag] };
}

// ----------------------------------------------------------------- ABI codec

const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);

export function padAddress(addr) {
  return strip(addr).toLowerCase().padStart(64, '0');
}

export function padUint(v) {
  return BigInt(v).toString(16).padStart(64, '0');
}

export function padBool(b) {
  return (b ? '1' : '0').padStart(64, '0');
}

/** Topic form of an address, for getLogs filters. */
export function addressTopic(addr) {
  return '0x' + padAddress(addr);
}

/** Last 20 bytes of a 32-byte topic, as a checksum-less lowercase address. */
export function topicToAddress(topic) {
  return '0x' + strip(topic).slice(-40).toLowerCase();
}

export function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.length > 66 ? '0x' + strip(hex).slice(0, 64) : hex);
}

export function decodeBool(hex) {
  return decodeUint(hex) !== 0n;
}

export function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  return '0x' + strip(hex).slice(24, 64).toLowerCase();
}

/**
 * Decode a returned string. Handles both the ABI `string` encoding and the
 * legacy `bytes32` symbol/name that pre-ERC20-standard tokens still return.
 */
export function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  const raw = strip(hex);
  // Dynamic string: offset word, length word, then data.
  if (raw.length >= 128) {
    try {
      const len = Number(BigInt('0x' + raw.slice(64, 128)));
      if (len > 0 && len <= 1024 && raw.length >= 128 + len * 2) {
        const bytes = raw.slice(128, 128 + len * 2);
        const s = hexToUtf8(bytes);
        if (s) return s;
      }
    } catch {
      /* fall through to bytes32 */
    }
  }
  // bytes32: trailing zero padding, ascii content.
  const s = hexToUtf8(raw.slice(0, 64)).replace(/\0+$/, '');
  return s || null;
}

function hexToUtf8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: false })
      .decode(bytes)
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ getLogs

/**
 * Scan a block range for logs, halving the range on failure. Public RPCs
 * answer a full-history filtered scan for a normal wallet in under a second,
 * but a heavy wallet can blow past response limits — so degrade gracefully
 * instead of failing the whole scan.
 */
export async function getLogsAdaptive(fromBlock, toBlock, topics, onProgress) {
  const out = [];
  const stack = [[fromBlock, toBlock]];

  while (stack.length) {
    const [lo, hi] = stack.pop();
    try {
      const logs = await rpcRace('eth_getLogs', [
        {
          fromBlock: '0x' + lo.toString(16),
          toBlock: '0x' + hi.toString(16),
          topics,
        },
      ]);
      out.push(...logs);
      if (onProgress) onProgress(lo, hi, logs.length);
    } catch (e) {
      const span = hi - lo;
      if (span <= SCAN.minChunkBlocks) {
        // Give up on this sliver rather than the whole scan.
        if (onProgress) onProgress(lo, hi, 0, e);
        continue;
      }
      const mid = lo + Math.floor(span / 2);
      stack.push([mid + 1, hi]);
      stack.push([lo, mid]);
    }
  }
  return out;
}
