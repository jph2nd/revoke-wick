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
  currentRpc,
} from './rpc.js';
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
};

// ---------------------------------------------------------------- formatting

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

function spenderLabel(a) {
  return SPENDER_LABELS[a.toLowerCase()] || null;
}

function fmtUnits(value, decimals, maxFrac = 4) {
  const d = BigInt(decimals ?? 18);
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

/** EIP-6963 discovery, falling back to the legacy injected provider. */
function discoverProviders() {
  const found = [];
  const onAnnounce = (e) => found.push(e.detail);
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  if (found.length === 0 && window.ethereum) {
    found.push({ info: { name: 'Injected Wallet' }, provider: window.ethereum });
  }
  return found;
}

async function connect() {
  const providers = discoverProviders();
  if (providers.length === 0) {
    toast('No wallet found. Install MetaMask or another PulseChain wallet.', 'err');
    return;
  }
  // Multiple wallets could be present; the injected default is the sane pick
  // and avoids building a wallet-picker UI for v1.
  const chosen = providers[0];
  state.provider = chosen.provider;

  try {
    const accounts = await state.provider.request({
      method: 'eth_requestAccounts',
    });
    if (!accounts?.length) throw new Error('no accounts returned');
    state.account = accounts[0].toLowerCase();
    state.chainId = await state.provider.request({ method: 'eth_chainId' });
  } catch (e) {
    toast(walletError(e), 'err');
    return;
  }

  state.provider.on?.('accountsChanged', (accs) => {
    state.account = accs?.[0]?.toLowerCase() ?? null;
    if (state.account) startScan(state.account, false);
    else location.reload();
  });
  state.provider.on?.('chainChanged', (id) => {
    state.chainId = id;
    renderNetwork();
  });

  renderNetwork();
  if (!onRightChain()) {
    const ok = await ensureChain();
    if (!ok) return;
  }
  startScan(state.account, false);
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
    return;
  }
  if (!state.account) {
    pill.classList.add('hidden');
    return;
  }
  if (onRightChain()) {
    pill.textContent = `PulseChain · ${shortAddr(state.account)}`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'Wrong network — click to switch';
    pill.className = 'pill warn';
    pill.onclick = ensureChain;
  }
  $('connect').textContent = shortAddr(state.account);
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
      `Then ${items.length} separate transactions, one per token.`,
      'PulseChain cannot bundle these — each token must be signed individually. You can reject any of them without losing the fee for the ones already done.',
    ],
    okText: `Pay & revoke ${items.length}`,
  });
  if (!ok) return;

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
    if (statsRaw) {
      const w = (i) => decodeUint('0x' + statsRaw.slice(2).slice(i * 64, i * 64 + 64));
      const pending = w(0);
      const wickBurned = w(3);
      const singles = w(4);
      const batches = w(5);
      $('stat-pending').textContent = fmtUnits(pending, 18, 0);
      $('stat-wick').textContent = fmtUnits(wickBurned, 18, 2);
      $('stat-revokes').textContent = (singles + batches).toLocaleString();
      $('do-burn').disabled = pending === 0n;
      $('burn-note').textContent =
        pending === 0n ? 'Nothing pending yet.' : 'Anyone can trigger this.';
    }
    if (previewRaw && previewRaw !== '0x') {
      const w = (i) => decodeUint('0x' + previewRaw.slice(2).slice(i * 64, i * 64 + 64));
      const expected = w(1);
      if (expected > 0n) {
        $('burn-note').textContent = `≈ ${fmtUnits(expected, 18, 2)} WICK will be burned.`;
      }
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
  if (!feeContractReady) return;
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
}

// ---------------------------------------------------------------------- init

$('connect').onclick = connect;
$('connect-hero').onclick = connect;
$('rescan').onclick = () => state.viewing && startScan(state.viewing, state.readOnly);
$('only-risky').onchange = renderRows;
$('revoke-batch').onclick = revokeBatch;
$('do-burn').onclick = triggerBurn;

$('select-all').onchange = (e) => {
  const rows = visibleApprovals();
  if (e.target.checked) rows.forEach((a) => state.selected.add(a.key));
  else rows.forEach((a) => state.selected.delete(a.key));
  renderRows();
};

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

$('rpc-note').textContent = `via ${new URL(currentRpc()).host}`;

loadFees().then(refreshBurnStats);

// Deep link: ?address=0x… opens a read-only view.
const qs = new URLSearchParams(location.search);
const qAddr = qs.get('address');
if (qAddr && /^0x[0-9a-fA-F]{40}$/.test(qAddr)) startScan(qAddr, true);
