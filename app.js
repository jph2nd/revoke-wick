// revoke.wick.pics — application logic.

import {
  CHAIN,
  RPCS,
  FEE_CONTRACT,
  FEES,
  SEL,
  SPENDER_LABELS,
  BURN_ADDRESS,
  TOKENS,
} from './config.js';
import {
  rpc,
  rpcBatch,
  ethCall,
  padAddress,
  padUint,
  decodeUint,
} from './rpc.js';
import {
  initDiscovery,
  listProviders,
  providerKey,
  describeProvider,
} from './wallet.js';
import {
  scanApprovals,
  revokeCalldata,
  KIND,
  UNLIMITED_THRESHOLD,
} from './scanner.js';

const $ = (id) => document.getElementById(id);
const ZERO = '0x0000000000000000000000000000000000000000';
const feeContractReady =
  FEE_CONTRACT && FEE_CONTRACT.toLowerCase() !== ZERO;

const state = {
  provider: null,
  account: null,
  chainId: null,
  /** address currently displayed — may differ from account in read-only mode */
  viewing: null,
  readOnly: false,
  approvals: [],
  selected: new Set(),
  fees: { single: FEES.single * 10n ** 18n, batch: FEES.batch * 10n ** 18n },
  scanning: false,
  connecting: false,
  walletName: null,
  /** providers whose events are already bound, by object identity */
  bound: new Set(),
};

// ---------------------------------------------------------------- formatting

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

function spenderLabel(a) {
  return SPENDER_LABELS[a.toLowerCase()] || null;
}

function fmtUnits(value, decimals, maxFrac = 4) {
  // Defence in depth: the scanner already clamps decimals, but this must never
  // throw on hostile input either. `10n ** 2n**256n` raises RangeError and
  // would abort rendering of every row, not just the offending one.
  const n = decimals == null ? 18 : Number(decimals);
  const d = BigInt(Number.isInteger(n) && n >= 0 && n <= 36 ? n : 18);
  const base = 10n ** d;
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toLocaleString('en-US');
  const fracStr = frac.toString().padStart(Number(d), '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${fracStr ? '.' + fracStr : ''}`;
}

function fmtPls(wei) {
  return fmtUnits(wei, 18, 2) + ' PLS';
}

// -------------------------------------------------------------------- toasts

function toast(msg, kind = '', link = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'View transaction ↗';
    el.appendChild(a);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 6000);
  return el;
}

// --------------------------------------------------------------------- modal

function confirmModal({ title, rows, steps, okText = 'Continue' }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    const body = $('modal-body');
    body.innerHTML = '';
    for (const [k, v] of rows || []) {
      const row = document.createElement('div');
      row.className = 'modal-body-row';
      const kk = document.createElement('span');
      kk.className = 'k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'v';
      vv.textContent = v;
      row.append(kk, vv);
      body.appendChild(row);
    }
    if (steps?.length) {
      const ol = document.createElement('ol');
      ol.className = 'steps';
      for (const s of steps) {
        const li = document.createElement('li');
        li.textContent = s;
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }
    $('modal-ok').textContent = okText;
    $('modal').classList.remove('hidden');

    const close = (v) => {
      $('modal').classList.add('hidden');
      $('modal-ok').onclick = null;
      $('modal-cancel').onclick = null;
      resolve(v);
    };
    $('modal-ok').onclick = () => close(true);
    $('modal-cancel').onclick = () => close(false);
  });
}

// ------------------------------------------------------------------- wallet

const WALLET_PREF_KEY = 'wick.wallet';

function rememberWallet(key) {
  try {
    if (key) localStorage.setItem(WALLET_PREF_KEY, key);
  } catch {
    /* private mode — the chooser just appears again next time */
  }
}

function forgetWallet() {
  try {
    localStorage.removeItem(WALLET_PREF_KEY);
  } catch {
    /* ignore */
  }
}

function rememberedWallet() {
  try {
    return localStorage.getItem(WALLET_PREF_KEY);
  } catch {
    return null;
  }
}

/**
 * Ask which wallet to use. Returns the chosen entry, or null if cancelled.
 *
 * Never auto-picks from a list of several. Taking providers[0] is what forces
 * everyone with Phantom installed into Phantom, because Phantom announces first
 * and also owns window.ethereum.
 */
function chooseWallet(entries, { force = false } = {}) {
  if (entries.length === 0) return Promise.resolve(null);
  if (!force) {
    if (entries.length === 1) return Promise.resolve(entries[0]);
    const pref = rememberedWallet();
    if (pref) {
      const hit = entries.find((e) => providerKey(e) === pref);
      if (hit) return Promise.resolve(hit);
    }
  }

  return new Promise((resolve) => {
    const list = $('wallet-picker-list');
    list.innerHTML = '';
    for (const entry of entries) {
      const name = entry.info?.name || describeProvider(entry.provider);
      const btn = document.createElement('button');
      btn.className = 'wallet-option';
      btn.type = 'button';

      if (entry.info?.icon && /^data:image\//.test(entry.info.icon)) {
        // 6963 icons are data URIs, which the CSP's img-src 'self' data: allows.
        const img = document.createElement('img');
        img.src = entry.info.icon;
        img.alt = '';
        img.width = 28;
        img.height = 28;
        btn.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = name;
      btn.appendChild(label);

      btn.onclick = () => close(entry);
      list.appendChild(btn);
    }

    const close = (v) => {
      $('wallet-picker').classList.add('hidden');
      $('wallet-picker-cancel').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    // An abandoned chooser must not strand the next connect behind a promise
    // that never settles, so Esc and Cancel both resolve.
    $('wallet-picker-cancel').onclick = () => close(null);
    document.addEventListener('keydown', onKey);
    $('wallet-picker').classList.remove('hidden');
  });
}

/**
 * Bind account/chain events, once per provider object.
 *
 * A single global "already bound" flag was wrong: after switching to a second
 * wallet the new provider had no listeners at all, so account changes there
 * went completely unnoticed while the page kept showing the old account's
 * approvals — and revoking against the wrong account still charges a fee.
 */
function bindProviderEvents() {
  const p = state.provider;
  if (!p || state.bound.has(p)) return;
  state.bound.add(p);

  p.on?.('accountsChanged', (accs) => {
    if (p !== state.provider) return; // a stale wallet must not hijack the session
    const next = accs?.[0]?.toLowerCase() ?? null;
    if (next && next !== state.account) {
      onAccountChanged(next);
    } else if (!next) {
      resetToDisconnected();
    }
  });
  p.on?.('chainChanged', (id) => {
    if (p !== state.provider) return;
    state.chainId = id;
    renderNetwork();
  });
  p.on?.('disconnect', () => {
    // Often just an RPC hiccup rather than a real disconnect. Re-ask before
    // wiping a working session.
    setTimeout(async () => {
      try {
        const accs = await p.request({ method: 'eth_accounts' });
        if (!accs?.length) resetToDisconnected();
      } catch {
        resetToDisconnected();
      }
    }, 1200);
  });
}

/**
 * One path for every account change. Everything shown is per-account, so the
 * old account's approvals and selection must be dropped together — showing one
 * account's rows while another is connected is a lie the user could act on.
 */
function onAccountChanged(next) {
  state.account = next;
  state.selected.clear();
  state.approvals = [];
  $('approvals-body').innerHTML = '';
  renderBatchBar();
  renderNetwork();
  startScan(next, false);
}

/** ?address=0x… deep link, if present and well-formed. */
function qsAddress() {
  const v = new URLSearchParams(location.search).get('address');
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

async function connect(opts = {}) {
  if (state.connecting) {
    toast('Check your wallet — a connection request is already open.', 'warn');
    return;
  }
  const providers = listProviders();
  if (providers.length === 0) {
    // A mobile browser has no injected provider at all — wallets only inject
    // inside their own in-app browser. Telling someone on a phone to "install
    // an extension" is a dead end, so offer the deep link instead.
    const ua = navigator.userAgent || '';
    // iPadOS 13+ reports a Macintosh UA, so sniffing alone misses iPads;
    // a touch-capable "Mac" is one.
    const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    if (/android|iphone|ipad|ipod/i.test(ua) || isTouchMac) {
      const go = await confirmModal({
        title: 'Open in your wallet app',
        rows: [['Why', 'Mobile browsers have no wallet built in']],
        steps: [
          'A wallet only provides a connection inside its own in-app browser, so a normal mobile browser has nothing to connect to.',
          'Reopen this page inside MetaMask, then connect there.',
          'Or paste any address in the box above to check it read-only — that needs no wallet at all.',
        ],
        okText: 'Open in MetaMask',
      });
      if (go) {
        location.href =
          `https://metamask.app.link/dapp/${location.host}${location.pathname}`;
      }
      return;
    }
    toast('No wallet found. Install MetaMask or another PulseChain wallet.', 'err');
    return;
  }
  const chosen = await chooseWallet(providers, { force: opts.force });
  if (!chosen) return; // cancelled
  state.provider = chosen.provider;
  state.walletName = chosen.info?.name || describeProvider(chosen.provider);

  state.connecting = true;
  try {
    const accounts = await state.provider.request({
      method: 'eth_requestAccounts',
    });
    if (!accounts?.length) throw new Error('no accounts returned');
    state.account = accounts[0].toLowerCase();
    state.chainId = await state.provider.request({ method: 'eth_chainId' });
    rememberWallet(providerKey(chosen));
  } catch (e) {
    // -32002 means a popup is already open and hidden behind the window.
    if (e?.code === -32002) {
      toast('Your wallet already has a request open — click its toolbar icon.', 'warn');
    } else {
      toast(walletError(e), 'err');
    }
    return;
  } finally {
    state.connecting = false;
  }

  bindProviderEvents();

  renderNetwork();
  if (!onRightChain()) {
    const ok = await ensureChain();
    if (!ok) return;
  }
  startScan(state.account, false);
}

/**
 * Ask the wallet to re-present its account picker.
 *
 * There is no EIP-1193 "switch account" call. Re-requesting the eth_accounts
 * permission is what makes MetaMask (and most forks) show the picker again;
 * plain eth_requestAccounts silently returns the already-approved account.
 */
async function switchWallet() {
  closeWalletMenu();
  // More than one wallet installed? Offer the chooser rather than only
  // re-prompting the current one for a different account.
  if (listProviders().length > 1) {
    return connect({ force: true });
  }
  try {
    await state.provider.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    const accounts = await state.provider.request({ method: 'eth_accounts' });
    if (!accounts?.length) return resetToDisconnected();
    state.account = accounts[0].toLowerCase();
    renderNetwork();
    startScan(state.account, false);
  } catch (e) {
    // Wallets that do not implement wallet_requestPermissions fall back to a
    // plain connect, which at least re-prompts on some of them.
    if (e?.code === -32601) return connect();
    toast(walletError(e), 'err');
  }
}

/**
 * Disconnect. EIP-1193 has no disconnect method — a dApp cannot force a wallet
 * to forget it. wallet_revokePermissions does it on MetaMask; everywhere else
 * we clear our own state, which is all a site can honestly do.
 */
async function disconnectWallet() {
  closeWalletMenu();
  try {
    await state.provider?.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* unsupported on this wallet — local reset below is the fallback */
  }
  forgetWallet();
  resetToDisconnected();
  toast('Wallet disconnected.');
}

/** Return the page to its signed-out state without reloading. */
function resetToDisconnected() {
  state.account = null;
  state.chainId = null;
  state.viewing = null;
  state.readOnly = false;
  state.approvals = [];
  state.selected.clear();

  closeWalletMenu();
  $('connect').textContent = 'Connect Wallet';
  $('net-pill').classList.add('hidden');
  $('net-pill').onclick = null;
  $('topbar-inner').classList.remove('net-warn');
  $('select-all-mobile').checked = false;
  $('select-all').checked = false;
  $('results').classList.add('hidden');
  $('scanning').classList.add('hidden');
  $('hero').classList.remove('hidden');
  $('approvals-body').innerHTML = '';
  renderBatchBar();
}

function openWalletMenu() {
  $('wallet-menu').classList.remove('hidden');
  $('connect').setAttribute('aria-expanded', 'true');
  // Close on the next outside click.
  setTimeout(() => document.addEventListener('click', outsideWalletClick), 0);
}

function closeWalletMenu() {
  $('wallet-menu').classList.add('hidden');
  $('connect').setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', outsideWalletClick);
}

function outsideWalletClick(e) {
  if (!e.target.closest('.wallet-wrap')) closeWalletMenu();
}

/** Connect when signed out; offer change/disconnect when signed in. */
function onConnectClick() {
  if (state.account) {
    $('wallet-menu').classList.contains('hidden')
      ? openWalletMenu()
      : closeWalletMenu();
  } else {
    connect();
  }
}

function onRightChain() {
  return (
    state.chainId &&
    parseInt(state.chainId, 16) === CHAIN.id
  );
}

async function ensureChain() {
  try {
    await state.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN.idHex }],
    });
    state.chainId = CHAIN.idHex;
    renderNetwork();
    return true;
  } catch (e) {
    // 4902 = chain unknown to the wallet; offer to add it.
    if (e?.code === 4902 || /unrecognized chain/i.test(e?.message || '')) {
      try {
        await state.provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: CHAIN.idHex,
              chainName: CHAIN.name,
              nativeCurrency: CHAIN.currency,
              rpcUrls: RPCS,
              blockExplorerUrls: [CHAIN.explorer],
            },
          ],
        });
        state.chainId = CHAIN.idHex;
        renderNetwork();
        return true;
      } catch (addErr) {
        toast(walletError(addErr), 'err');
        return false;
      }
    }
    toast(walletError(e), 'err');
    return false;
  }
}

function walletError(e) {
  const code = e?.code;
  if (code === 4001 || /user rejected|user denied/i.test(e?.message || '')) {
    return 'Rejected in wallet.';
  }
  if (code === -32002) return 'Wallet already has a pending request — check it.';
  return e?.message ? `Wallet error: ${e.message}` : 'Wallet error.';
}

function renderNetwork() {
  const pill = $('net-pill');
  pill.classList.remove('hidden');
  if (state.readOnly) {
    pill.textContent = `read-only · ${shortAddr(state.viewing)}`;
    pill.className = 'pill';
    pill.onclick = null;
    $('topbar-inner').classList.remove('net-warn');
    return;
  }
  if (!state.account) {
    pill.classList.add('hidden');
    $('topbar-inner').classList.remove('net-warn');
    return;
  }
  if (onRightChain()) {
    pill.textContent = `PulseChain · ${shortAddr(state.account)}`;
    pill.className = 'pill ok';
    pill.onclick = null;
    $('topbar-inner').classList.remove('net-warn');
  } else {
    pill.textContent = 'Wrong network — click to switch';
    pill.className = 'pill warn';
    pill.onclick = ensureChain;
    $('topbar-inner').classList.add('net-warn');
  }
  // Caret signals the button is now a menu, not a connect action.
  $('connect').textContent = `${shortAddr(state.account)} ▾`;
}

// ------------------------------------------------------------------ scanning

async function startScan(address, readOnly) {
  if (state.scanning) return;
  state.scanning = true;
  state.viewing = address.toLowerCase();
  state.readOnly = readOnly;
  state.selected.clear();

  $('hero').classList.add('hidden');
  $('results').classList.add('hidden');
  $('scanning').classList.remove('hidden');
  $('scan-bar').style.width = '5%';
  $('scan-title').textContent = 'Scanning approvals…';
  renderNetwork();

  let ranges = 0;
  try {
    const res = await scanApprovals(state.viewing, (p) => {
      if (p.phase === 'logs') {
        ranges++;
        // Total range count is unknowable up front (the scanner only splits
        // when a request fails), so show a soft, always-advancing bar.
        const pct = Math.min(70, 10 + ranges * 12);
        $('scan-bar').style.width = pct + '%';
        $('scan-detail').textContent =
          `Reading approval history — ${p.found} token/spender pair${p.found === 1 ? '' : 's'} found`;
      } else if (p.phase === 'state') {
        $('scan-bar').style.width = '82%';
        $('scan-title').textContent = 'Checking which are still live…';
        $('scan-detail').textContent =
          `Re-reading current allowances for ${p.total} pair${p.total === 1 ? '' : 's'} on-chain`;
      } else if (p.phase === 'metadata') {
        $('scan-bar').style.width = '93%';
        $('scan-detail').textContent = `Loading token details (${p.total})`;
      }
    });
    state.approvals = res.approvals;
    $('scan-bar').style.width = '100%';
    renderResults(res);
  } catch (e) {
    toast(`Scan failed: ${e.message}`, 'err');
    $('hero').classList.remove('hidden');
  } finally {
    state.scanning = false;
    $('scanning').classList.add('hidden');
  }
}

// ------------------------------------------------------------------ rendering

function isRisky(a) {
  return (
    a.kind === KIND.FOR_ALL ||
    (a.allowance != null && a.allowance >= UNLIMITED_THRESHOLD)
  );
}

function visibleApprovals() {
  return $('only-risky').checked
    ? state.approvals.filter(isRisky)
    : state.approvals;
}

function renderResults(res) {
  $('results').classList.remove('hidden');
  const total = state.approvals.length;
  const risky = state.approvals.filter(isRisky).length;

  $('results-title').textContent = state.readOnly
    ? `Approvals for ${shortAddr(state.viewing)}`
    : 'Your approvals';
  $('results-sub').textContent =
    `${total} active · ${risky} unlimited or blanket · scanned ${res.scanned} historical pair${res.scanned === 1 ? '' : 's'} to block ${res.latest.toLocaleString()}`;

  renderRows();
}

function renderRows() {
  const body = $('approvals-body');
  body.innerHTML = '';
  const rows = visibleApprovals();

  $('empty').classList.toggle('hidden', rows.length > 0);
  document.querySelector('.table-scroll').classList.toggle('hidden', rows.length === 0);

  for (const a of rows) {
    const tr = document.createElement('tr');
    tr.dataset.key = a.key;

    // select
    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    if (!state.readOnly) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(a.key);
      cb.onchange = () => {
        if (cb.checked) state.selected.add(a.key);
        else state.selected.delete(a.key);
        renderBatchBar();
      };
      tdCheck.appendChild(cb);
    }

    // token
    const tdTok = document.createElement('td');
    const tok = document.createElement('div');
    tok.className = 'tok';
    const sym = document.createElement('span');
    sym.className = 'tok-sym';
    sym.textContent = a.meta?.symbol ?? '???';
    const nm = document.createElement('a');
    nm.className = 'tok-name';
    nm.href = `${CHAIN.explorer}/address/${a.token}`;
    nm.target = '_blank';
    nm.rel = 'noopener';
    nm.textContent = a.meta?.name ?? a.token;
    tok.append(sym, nm);
    tdTok.appendChild(tok);

    // amount
    const tdAmt = document.createElement('td');
    if (a.kind === KIND.FOR_ALL) {
      tdAmt.innerHTML = '<span class="amt-all">ALL tokens &amp; NFTs</span>';
    } else if (a.kind === KIND.ERC721_ONE) {
      tdAmt.innerHTML = `<span class="amt-num">NFT #${a.tokenId}</span>`;
    } else if (a.allowance >= UNLIMITED_THRESHOLD) {
      tdAmt.innerHTML = '<span class="amt-unlimited">UNLIMITED</span>';
    } else {
      tdAmt.innerHTML = `<span class="amt-num">${fmtUnits(a.allowance, a.meta?.decimals ?? 18)}</span>`;
    }

    // at risk = min(allowance, balance)
    const tdRisk = document.createElement('td');
    const bal = a.meta?.balance ?? 0n;
    if (a.kind === KIND.ERC20) {
      const atRisk = a.allowance < bal ? a.allowance : bal;
      // NEVER interpolate token metadata into innerHTML. `symbol` is whatever
      // an arbitrary token contract chose to return, so it is attacker
      // controlled: a token whose symbol() is `<img src=x onerror=...>` would
      // otherwise inject markup into a page that is connected to the user's
      // wallet. Build the node and assign textContent instead. The CSP blocks
      // inline handlers too, but the escaping must not depend on the CSP.
      const span = document.createElement('span');
      if (atRisk > 0n) {
        span.className = 'risk some';
        span.textContent =
          `${fmtUnits(atRisk, a.meta?.decimals ?? 18)} ${a.meta?.symbol ?? ''}`.trim();
      } else {
        span.className = 'risk none';
        span.textContent = 'nothing held';
      }
      tdRisk.appendChild(span);
    } else {
      tdRisk.innerHTML = '<span class="risk some">all holdings</span>';
    }

    // spender
    const tdSp = document.createElement('td');
    const label = spenderLabel(a.spender);
    const sp = document.createElement('a');
    sp.href = `${CHAIN.explorer}/address/${a.spender}`;
    sp.target = '_blank';
    sp.rel = 'noopener';
    sp.className = label ? 'addr-label' : 'addr';
    sp.textContent = label ?? shortAddr(a.spender);
    tdSp.appendChild(sp);

    // action
    const tdAct = document.createElement('td');
    tdAct.className = 'col-action';
    if (!state.readOnly) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = 'Revoke';
      btn.onclick = () => revokeOne(a, tr);
      tdAct.appendChild(btn);
    }

    // Labels for the stacked mobile layout, where the header row is hidden and
    // each cell renders its own name via td::before.
    tdTok.dataset.label = 'Token';
    tdAmt.dataset.label = 'Approved';
    tdRisk.dataset.label = 'At risk';
    tdSp.dataset.label = 'Spender';

    tr.append(tdCheck, tdTok, tdAmt, tdRisk, tdSp, tdAct);
    body.appendChild(tr);
  }

  renderBatchBar();
}

function renderBatchBar() {
  const n = state.selected.size;
  const bar = $('batch-bar');
  bar.classList.toggle('hidden', n === 0);
  $('batch-count').textContent = `${n} selected`;
  $('batch-fee-note').textContent = feeContractReady
    ? `one ${fmtPls(state.fees.batch)} fee covers the whole batch`
    : 'fee contract not configured — revokes are free';
}

// ------------------------------------------------------------------ revoking

async function sendTx(tx) {
  return state.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: state.account, ...tx }],
  });
}

async function waitForReceipt(hash, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (r) return r;
    } catch {
      /* transient; keep polling */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('timed out waiting for confirmation');
}

async function payFee(kind, count) {
  if (!feeContractReady) return true; // fee not deployed yet
  const value =
    kind === 'batch' ? state.fees.batch : state.fees.single;
  const data =
    kind === 'batch'
      ? SEL.payBatchFee + padUint(count)
      : SEL.payRevokeFee;

  const hash = await sendTx({
    to: FEE_CONTRACT,
    value: '0x' + value.toString(16),
    data,
  });
  toast('Fee sent, waiting for confirmation…', '', `${CHAIN.explorer}/tx/${hash}`);
  const rec = await waitForReceipt(hash);
  if (decodeUint(rec.status) !== 1n) throw new Error('fee transaction reverted');
  return true;
}

async function revokeOne(item, tr) {
  if (!(await guardWallet())) return;

  const ok = await confirmModal({
    title: 'Revoke approval',
    rows: [
      ['Token', item.meta?.symbol ?? item.token],
      ['Spender', spenderLabel(item.spender) ?? shortAddr(item.spender)],
      ['Fee', feeContractReady ? fmtPls(state.fees.single) : 'none (not configured)'],
    ],
    steps: feeContractReady
      ? [
          `Transaction 1 — pay the ${fmtPls(state.fees.single)} fee. Half of it buys and burns WICK.`,
          'Transaction 2 — set the allowance to zero on the token itself.',
        ]
      : ['One transaction — set the allowance to zero on the token itself.'],
    okText: 'Revoke',
  });
  if (!ok) return;

  tr?.classList.add('busy');
  try {
    await payFee('single', 1);
    const call = revokeCalldata(item);
    const hash = await sendTx(call);
    toast('Revoke sent…', '', `${CHAIN.explorer}/tx/${hash}`);
    const rec = await waitForReceipt(hash);
    if (decodeUint(rec.status) !== 1n) throw new Error('revoke reverted');
    toast(`Revoked ${item.meta?.symbol ?? 'approval'}`, '');
    markRevoked(item, tr);
  } catch (e) {
    toast(walletError(e), 'err');
  } finally {
    tr?.classList.remove('busy');
  }
  refreshBurnStats();
}

/**
 * EIP-5792 batch send: hand the wallet every call at once so the user confirms
 * ONCE instead of once per token.
 *
 * PulseChain has no EIP-7702, so a true atomic batch is impossible — but 5792
 * explicitly allows non-atomic execution ("in the case of EOA wallets the
 * wallet_send* method might send more than one transaction"), which still
 * collapses N popups into one prompt. atomicRequired is false because
 * demanding atomicity here would make every wallet reject the request.
 *
 * Returns a batch id, or null when the wallet does not implement 5792 — the
 * caller then falls back to sending the calls one at a time.
 */
async function trySendCalls(calls) {
  if (!state.provider?.request) return null;
  try {
    const res = await state.provider.request({
      method: 'wallet_sendCalls',
      params: [
        {
          version: '2.0.0',
          chainId: CHAIN.idHex,
          from: state.account,
          atomicRequired: false,
          calls,
        },
      ],
    });
    return typeof res === 'string' ? res : (res?.id ?? null);
  } catch (e) {
    // A rejection is a decision, not a capability gap — do not silently retry
    // the slow path and prompt the user all over again.
    if (e?.code === 4001 || /user rejected|denied/i.test(e?.message || '')) throw e;
    return null;
  }
}

/** Poll EIP-5792 batch status. Status >= 200 is terminal (200 = confirmed). */
async function waitForCalls(id, timeoutMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const s = await state.provider.request({
        method: 'wallet_getCallsStatus',
        params: [id],
      });
      const code = typeof s?.status === 'number' ? s.status : null;
      if (code !== null && code >= 200) return s;
      if (typeof s?.status === 'string' && /confirmed|success/i.test(s.status)) {
        return s; // older wallets still on the v1 string statuses
      }
    } catch {
      /* transient; keep polling */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('timed out waiting for the batch');
}

async function revokeBatch() {
  if (!(await guardWallet())) return;
  const items = state.approvals.filter((a) => state.selected.has(a.key));
  if (items.length === 0) return;

  const ok = await confirmModal({
    title: `Revoke ${items.length} approvals`,
    rows: [
      ['Approvals', String(items.length)],
      ['Fee', feeContractReady ? fmtPls(state.fees.batch) + ' (once)' : 'none (not configured)'],
      ['Transactions', String(items.length + (feeContractReady ? 1 : 0))],
    ],
    steps: [
      feeContractReady
        ? `One ${fmtPls(state.fees.batch)} fee payment covers the whole batch.`
        : 'No fee is charged.',
      `Then one revoke per token — ${items.length} in total.`,
      'If your wallet supports batching it will ask you once. Otherwise it asks once per token; you can reject any of them, and the ones already done stay revoked.',
    ],
    okText: `Pay & revoke ${items.length}`,
  });
  if (!ok) return;

  // --- fast path: one confirmation for the fee and every revoke ------------
  const calls = [];
  if (feeContractReady) {
    calls.push({
      to: FEE_CONTRACT,
      value: '0x' + state.fees.batch.toString(16),
      data: SEL.payBatchFee + padUint(items.length),
    });
  }
  for (const item of items) {
    const c = revokeCalldata(item);
    calls.push({ to: c.to, data: c.data, value: '0x0' });
  }

  try {
    const batchId = await trySendCalls(calls);
    if (batchId) {
      toast(`Sent ${items.length} revokes as one batch — waiting…`);
      await waitForCalls(batchId);
      // The wallet reports the batch, not per-call success. Re-scan so the
      // table reflects real on-chain state rather than an assumption.
      toast(`Batch complete — rechecking on-chain`);
      refreshBurnStats();
      return startScan(state.viewing || state.account, false);
    }
  } catch (e) {
    toast(walletError(e), 'err');
    return;
  }

  // --- fallback: wallets without EIP-5792, one transaction at a time -------
  try {
    await payFee('batch', items.length);
  } catch (e) {
    toast(walletError(e), 'err');
    return;
  }

  let done = 0;
  for (const item of items) {
    const tr = document.querySelector(`tr[data-key="${CSS.escape(item.key)}"]`);
    tr?.classList.add('busy');
    try {
      const hash = await sendTx(revokeCalldata(item));
      const rec = await waitForReceipt(hash);
      if (decodeUint(rec.status) !== 1n) throw new Error('reverted');
      done++;
      markRevoked(item, tr);
    } catch (e) {
      toast(`${item.meta?.symbol ?? 'token'}: ${walletError(e)}`, 'err');
    } finally {
      tr?.classList.remove('busy');
    }
  }
  toast(`Revoked ${done} of ${items.length}`, done === items.length ? '' : 'warn');
  refreshBurnStats();
}

function markRevoked(item, tr) {
  state.approvals = state.approvals.filter((a) => a.key !== item.key);
  state.selected.delete(item.key);
  if (tr) {
    tr.classList.add('done');
    setTimeout(() => renderRows(), 900);
  } else {
    renderRows();
  }
}

async function guardWallet() {
  if (state.readOnly) {
    toast('Read-only view. Connect this wallet to revoke.', 'warn');
    return false;
  }
  if (!state.account) {
    await connect();
    return !!state.account;
  }
  if (!onRightChain()) return ensureChain();
  return true;
}

// ---------------------------------------------------------------- burn panel

async function refreshBurnStats() {
  if (!feeContractReady) {
    $('burn-note').textContent = 'Fee contract not deployed yet.';
    return;
  }
  try {
    const [statsRaw, previewRaw, readyRaw] = await rpcBatch([
      ethCall(FEE_CONTRACT, SEL.stats),
      ethCall(FEE_CONTRACT, SEL.previewBurn),
      ethCall(FEE_CONTRACT, SEL.burnReadyIn),
    ]);
    let pending = 0n;
    if (statsRaw) {
      const w = (i) => decodeUint('0x' + statsRaw.slice(2).slice(i * 64, i * 64 + 64));
      pending = w(0);
      const wickBurned = w(3);
      const singles = w(4);
      const batches = w(5);
      $('stat-wick').textContent = fmtUnits(wickBurned, 18, 2);
      $('stat-revokes').textContent = (singles + batches).toLocaleString();
      $('do-burn').disabled = pending === 0n;
      $('burn-note').textContent =
        pending === 0n ? 'Nothing pending yet.' : 'Anyone can trigger this.';
    }

    // The pot holds PLS, not WICK — the WICK does not exist until burn() runs.
    // previewBurn() quotes what that PLS currently buys, so the headline figure
    // can be denominated in WICK honestly. Never label a PLS balance as WICK.
    if (previewRaw && previewRaw !== '0x') {
      const w = (i) => decodeUint('0x' + previewRaw.slice(2).slice(i * 64, i * 64 + 64));
      const plsIn = w(0);
      const expected = w(1);
      $('stat-pending').textContent = fmtUnits(expected, 18, 2);
      if (expected > 0n) {
        $('burn-note').textContent =
          `${fmtUnits(plsIn, 18, 0)} PLS in the pot — anyone can trigger the burn.`;
      }
    } else if (pending === 0n) {
      $('stat-pending').textContent = '0';
    } else {
      // Pot has PLS but the quote failed (thin/dead route) — do not invent a number.
      $('stat-pending').textContent = '—';
      $('burn-note').textContent =
        `${fmtUnits(pending, 18, 0)} PLS pending — no route quote available.`;
    }
    // The contract enforces a cooldown between burns; surface it instead of
    // letting the user submit a transaction that is guaranteed to revert.
    if (readyRaw) {
      const wait = decodeUint(readyRaw);
      if (wait > 0n) {
        $('do-burn').disabled = true;
        $('burn-note').textContent = `Cooling down — ready in ${wait}s.`;
      }
    }
  } catch {
    $('burn-note').textContent = 'Could not read burn stats.';
  }
}

async function triggerBurn() {
  if (!(await guardWallet())) return;
  try {
    // minWickOut = 0: the contract floors it with its own on-chain quote, and
    // a caller-supplied value can only ever raise that floor, never lower it.
    const hash = await sendTx({ to: FEE_CONTRACT, data: SEL.burn + padUint(0) });
    toast('Burn sent…', '', `${CHAIN.explorer}/tx/${hash}`);
    await waitForReceipt(hash);
    toast('WICK burned 🔥');
    refreshBurnStats();
  } catch (e) {
    toast(walletError(e), 'err');
  }
}

/** Read the real on-chain fee amounts so the UI never lies about the price. */
async function loadFees() {
  if (!feeContractReady) {
    $('fee-line').classList.add('hidden');
    return;
  }
  try {
    const [s, b] = await rpcBatch([
      ethCall(FEE_CONTRACT, SEL.singleFee),
      ethCall(FEE_CONTRACT, SEL.batchFee),
    ]);
    if (s) state.fees.single = decodeUint(s);
    if (b) state.fees.batch = decodeUint(b);
  } catch {
    /* keep the compiled-in defaults */
  }
  renderFees();
}

/**
 * Show the price from the contract's own values, not the hardcoded fallback,
 * so the headline figure can never advertise one price while the contract
 * charges another.
 */
function renderFees() {
  $('fee-single').textContent = fmtPls(state.fees.single);
  $('fee-batch').textContent = fmtPls(state.fees.batch);
}

// ---------------------------------------------------------------------- init

$('connect').onclick = onConnectClick;
$('connect-hero').onclick = connect;
$('wm-switch').onclick = switchWallet;
$('wm-disconnect').onclick = disconnectWallet;
$('rescan').onclick = () => state.viewing && startScan(state.viewing, state.readOnly);
$('only-risky').onchange = renderRows;
$('revoke-batch').onclick = revokeBatch;
$('do-burn').onclick = triggerBurn;

const onSelectAll = (e) => {
  const rows = visibleApprovals();
  if (e.target.checked) rows.forEach((a) => state.selected.add(a.key));
  else rows.forEach((a) => state.selected.delete(a.key));
  renderRows();
};
$('select-all').onchange = onSelectAll;
$('select-all-mobile').onchange = onSelectAll;

$('lookup-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('lookup-input').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    toast('That is not a valid 0x address.', 'err');
    return;
  }
  startScan(v, true);
};

if (feeContractReady) {
  $('contract-link').href = `${CHAIN.explorer}/address/${FEE_CONTRACT}`;
  $('contract-link').textContent = 'fee contract ↗';
} else {
  $('contract-link').classList.add('hidden');
}

// Point the footer explorer link at the deployed contract from config rather
// than hardcoding it in the HTML, so the link can never drift from the address
// the site actually charges fees to.
$('explorer-link').href = feeContractReady
  ? `${CHAIN.explorer}/address/${FEE_CONTRACT}`
  : CHAIN.explorer;

// "Contract is verified" — deep-link to the verified source tab, again built
// from config so it can never point at a different contract than the one the
// site charges fees to.
$('verified-link').href = feeContractReady
  ? `${CHAIN.explorer}/address/${FEE_CONTRACT}#code`
  : CHAIN.explorer;


loadFees().then(refreshBurnStats);

/**
 * Restore a previous session WITHOUT a popup. eth_accounts returns only what
 * was already granted; eth_requestAccounts (which prompts) must never fire
 * except from a real tap.
 */
async function silentReconnect() {
  const pref = rememberedWallet();
  if (!pref) return;
  // Give slow announcers a moment before deciding the wallet is absent.
  await new Promise((r) => setTimeout(r, 350));
  const entry = listProviders().find((e) => providerKey(e) === pref);
  if (!entry) return;
  try {
    const accounts = await entry.provider.request({ method: 'eth_accounts' });
    if (!accounts?.length) return;
    state.provider = entry.provider;
    state.walletName = entry.info?.name || describeProvider(entry.provider);
    state.account = accounts[0].toLowerCase();
    state.chainId = await entry.provider.request({ method: 'eth_chainId' });
    bindProviderEvents();
    renderNetwork();
    startScan(state.account, false);
  } catch {
    /* stay signed out */
  }
}

/**
 * Some wallets never fire accountsChanged when the user switches in their own
 * popup — OKX in particular often does not even blur the page, so no event of
 * any kind arrives. Re-read the truth whenever the tab regains attention, and
 * poll gently while it is visible. Cheap: eth_accounts hits the extension, not
 * the network, and never prompts.
 */
async function recheckAccount() {
  if (!state.provider || !state.account || state.readOnly) return;
  try {
    const accs = await state.provider.request({ method: 'eth_accounts' });
    const next = accs?.[0]?.toLowerCase() ?? null;
    if (!next) return resetToDisconnected();
    if (next !== state.account) onAccountChanged(next);
  } catch {
    /* leave the session alone on a transient failure */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheckAccount();
});
window.addEventListener('focus', recheckAccount);
setInterval(() => {
  if (document.visibilityState === 'visible') recheckAccount();
}, 2500);

initDiscovery();
if (!qsAddress()) silentReconnect();

// Deep link: ?address=0x… opens a read-only view.
const deepLinked = qsAddress();
if (deepLinked) startScan(deepLinked, true);
