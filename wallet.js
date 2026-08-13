// Wallet discovery.
//
// The hard part of "connect wallet" is not connecting — it is working out WHICH
// wallet the user meant when several are installed. Three failure modes, all of
// which this module exists to avoid:
//
//   1. Taking the first EIP-6963 announcement. Phantom announces early and also
//      overwrites window.ethereum, so "first wins" silently forces every user
//      with Phantom installed into Phantom, whatever else they have.
//   2. Adding the eip6963:announceProvider listener and removing it in the same
//      tick. Wallets are only required to answer the request event, and several
//      announce a tick later or on their own schedule — those become invisible.
//   3. Only checking window.ethereum when 6963 found nothing. When Phantom owns
//      window.ethereum, MetaMask is still reachable through the legacy
//      window.ethereum.providers[] array, which never gets read.
//
// So: listen from module load and never stop, re-request on demand, and merge
// every source, deduping by provider object identity.

/** rdns/uuid/name -> { info, provider } announced via EIP-6963. */
const announced = new Map();
let listening = false;

/** Start listening before anything asks, so slow announcers are not missed. */
export function initDiscovery() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e?.detail;
    if (!d?.provider) return;
    const key = d.info?.rdns || d.info?.uuid || d.info?.name;
    if (key) announced.set(key, d);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/**
 * Best-effort name for a provider that did not announce itself via 6963.
 * Order matters: Rabby and Phantom both set isMetaMask for compatibility, so
 * the specific flags have to be tested before the generic one.
 */
export function describeProvider(p) {
  if (!p) return 'Wallet';
  if (p.isRabby) return 'Rabby';
  if (p.isPhantom) return 'Phantom';
  if (p.isOkxWallet || p.isOKExWallet || p.isOkxWalletExtension) return 'OKX Wallet';
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet';
  if (p.isCoinbaseWallet || p.isCoinbaseBrowser) return 'Coinbase Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isTokenPocket) return 'TokenPocket';
  if (p.isBitKeep || p.isBitget) return 'Bitget Wallet';
  if (p.isFrame) return 'Frame';
  if (p.isZerion) return 'Zerion';
  if (p.isMetaMask) return 'MetaMask';
  return 'Injected Wallet';
}

/** Stable-ish id for a legacy provider, so a remembered choice survives reloads. */
function legacyRdns(p) {
  return 'legacy:' + describeProvider(p).toLowerCase().replace(/\s+/g, '-');
}

/**
 * Every reachable EVM provider, deduped by object identity.
 *
 * Deduping by object rather than by name matters: the same wallet frequently
 * appears both as a 6963 announcement and inside window.ethereum.providers,
 * and listing it twice makes the chooser look broken.
 */
export function listProviders() {
  // Re-ask every time; wallets that loaded after our first request answer now.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  const out = [];
  const seen = new Set();
  const add = (info, provider) => {
    if (!provider || seen.has(provider)) return;
    seen.add(provider);
    out.push({ info, provider });
  };

  // 1. EIP-6963 — the only source with a real name, icon and rdns.
  for (const d of announced.values()) add(d.info, d.provider);

  const eth = typeof window !== 'undefined' ? window.ethereum : null;

  // 2. Legacy multiplexed array. This is where MetaMask hides when another
  //    wallet has taken ownership of window.ethereum.
  if (Array.isArray(eth?.providers)) {
    for (const p of eth.providers) {
      add({ name: describeProvider(p), rdns: legacyRdns(p) }, p);
    }
  }

  // 3. The bare injected provider.
  if (eth) add({ name: describeProvider(eth), rdns: legacyRdns(eth) }, eth);

  // 4. Wallet-specific globals. Some in-app browsers never announce via 6963
  //    and never touch window.ethereum.
  for (const g of ['okxwallet', 'OKXWallet', 'trustwallet', 'bitkeep']) {
    const w = typeof window !== 'undefined' ? window[g] : null;
    const p = w?.ethereum || (typeof w?.request === 'function' ? w : null);
    if (p) add({ name: describeProvider(p), rdns: legacyRdns(p) }, p);
  }
  const phantomEvm = typeof window !== 'undefined' ? window.phantom?.ethereum : null;
  if (phantomEvm) add({ name: 'Phantom', rdns: 'app.phantom' }, phantomEvm);

  return out;
}

/** Identifier used to remember a choice across reloads. */
export function providerKey(entry) {
  return entry?.info?.rdns || entry?.info?.uuid || entry?.info?.name || null;
}
