# Revoke WICK

A token-approval checker and revoker for **PulseChain**, live at
**[revoke.wick.pics](https://revoke.wick.pics)**.

Every token you've ever traded left a standing permission behind. If that
contract is later drained — or was malicious from the start — those permissions
are how your tokens leave your wallet. This finds them and lets you close them.

**Half of every fee buys WICK on the open market and burns it.**

---

## How it works

There is **no backend**. This is a handful of static files that talk directly to
public PulseChain RPCs. Nothing is logged, nothing is proxied, and no server
ever sees your address.

Approval **logs** only prove an approval once existed — they never say whether
it's still live. So discovery runs in two phases:

1. **`eth_getLogs`** filtered by event topic + owner, across all history.
   ERC-20 and ERC-721 share the same `Approval` topic and are told apart by
   topic count (3 = ERC-20, 4 = ERC-721 with an indexed tokenId).
   `ApprovalForAll` is scanned separately.
2. **Re-read live on-chain state** for every unique `(token, spender)` pair —
   `allowance()`, `isApprovedForAll()`, `getApproved()` — and keep only what is
   still active.

Phase 2 is what makes the result honest. It's also cheap: one wallet tested
during development produced 38,410 approval logs but only **2 unique pairs**.

Revokes are sent **from your wallet, directly to the token contract**. This site
never takes custody of anything and never asks for an approval of its own.

---

## Fees, and what's honest about them

| Action | Fee |
|---|---|
| Revoke one approval | 50,000 PLS |
| Batch (one payment, many revokes) | 250,000 PLS |

**You do not have to pay this.** Revoking is free on-chain — anyone can call
`approve(spender, 0)` on a token themselves and pay nothing but gas. That's true
of every revoke dApp, including this one. The fee buys the scan, the risk
assessment and one-click revoking.

PulseChain is at the Shanghai fork and has **no EIP-7702**, so a batch revoke
genuinely cannot be a single transaction — it's one fee payment followed by one
transaction per token. The UI says so up front rather than surprising you.

---

## The burn

Half of every fee accrues in the fee contract. Then **anyone** can call `burn()`,
which market-buys WICK and sends it straight to PulseChain's burn address
`0x0000000000000000000000000000000000000369`.

The swap's recipient **is** the burn address, so burned WICK never passes
through the operator's hands.

What the contract guarantees, precisely:

- Once PLS is in the burn pot, the **only** ways out are a WICK buy delivered to
  the hardcoded burn address, or `burnPlsDirectly()` which sends it to that same
  hardcoded address as raw PLS. Both destinations are `constant`, and the swap
  router is `constant` too — enforced by bytecode, not by trust.
- `burn()` is permissionless, so the community can force the burn through
  without depending on the operator.
- The owner **can** change the split for *future* fees. It cannot touch PLS
  already accrued.

Burns route through **PulseX V1**, chosen by measurement rather than by TVL: the
9mm V3 WICK pool sits in the 2% fee tier while PulseX V1 charges 0.29%, so V1
returns more WICK for any burn under ~6.63M PLS.

### Known limitation

The slippage floor guards against a dead or migrated route, **not** against
sandwiching — a front-runner moves the reserves first, so the floor is computed
from already-corrupted state. Real protection needs a TWAP, and the WICK/WPLS V3
pool reports `observationCardinality == 1`, so none exists on-chain. The
mitigation is economic: the pot stays small and a cooldown blocks
same-transaction looping.

---

## Security

The fee contract was put through an adversarial review before deployment. It
found a **critical flaw in v1.0**: a settable swap router meant the owner could
point the contract at a fake router and drain the entire burn pot, and because
the delivered amount was computed but never asserted, nothing reverted. Two
reviewers reproduced it independently.

**v1.1** pins the router as a `constant` with no setter, asserts the delivered
WICK clears the minimum, bounds the burn cooldown so it can never freeze the
pot's only exit, and rejects a thinned route rather than only an empty one.

Contract source is in [`contracts/`](contracts/). Verify the deployed bytecode
yourself on the explorer before trusting it with anything.

---

## Running it locally

No build step, no bundler, no dependencies:

```bash
python -m http.server 8000
# open http://localhost:8000
```

Any static host works. The site is ~76 KB total.

---

## License

MIT — see [LICENSE](LICENSE).
