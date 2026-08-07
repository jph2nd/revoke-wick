# Verifying this contract yourself

The fee contract is deployed at

**`0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000`** — PulseChain (chain 369)

You do not have to trust an explorer, or us. The build is reproducible: compile
the source in this repo and compare it against what is actually on-chain.

---

## Already verified, in two independent places

**PulseChain explorer** — full source and ABI, exact bytecode match
(`is_fully_verified: true`, `is_partially_verified: false`):

<https://scan.pulsechain.com/address/0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000#code>

**Sourcify** — `exact_match`, the strongest tier (full metadata match):

- Viewer: <https://repo.sourcify.dev/369/0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000>
- API: <https://sourcify.dev/server/v2/contract/369/0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000>

Two independent verifications of the same bytecode is a stronger guarantee than
either alone — they compile the source separately and both reach the deployed
code. You can still reproduce it yourself below and trust neither.

---

## Reproduce the bytecode yourself

Requires Python and `py-solc-x`.

```bash
pip install py-solc-x requests
```

```python
import solcx, requests

solcx.install_solc("0.8.20")
solcx.set_solc_version("0.8.20")

src = open("contracts/WickRevokeFees_1_1.sol", encoding="utf-8").read()
out = solcx.compile_standard({
    "language": "Solidity",
    "sources": {"WickRevokeFees_1_1.sol": {"content": src}},
    "settings": {
        "optimizer": {"enabled": True, "runs": 200},
        "evmVersion": "shanghai",
        "outputSelection": {"*": {"*": ["evm.deployedBytecode.object"]}},
    },
})
local = out["contracts"]["WickRevokeFees_1_1.sol"]["WickRevokeFees"] \
           ["evm"]["deployedBytecode"]["object"].lower()

chain = requests.post("https://pulsechain-rpc.publicnode.com", json={
    "jsonrpc": "2.0", "id": 1, "method": "eth_getCode",
    "params": ["0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000", "latest"],
}).json()["result"][2:].lower()

diff = [i // 2 for i, (a, b) in enumerate(zip(local, chain)) if a != b]
print("same length:", len(local) == len(chain))
print("differing bytes:", sorted(set(diff)))
```

### Expected result

```
same length: True
differing bytes: [2053, 5041]
```

**Two differing bytes is a correct match, not a mismatch.** Those two offsets are
the final byte of the contract's two `immutable` slots (`wplsIsToken1`), which
solc emits as zero placeholders and the constructor fills in at deploy time.
Locally they read `00`; on-chain they read `01`, because WPLS is `token1` of the
PulseX V1 WICK/WPLS pair. Every other byte is identical.

Build settings, for reference:

| | |
|---|---|
| Compiler | `0.8.20+commit.a1b79de6` |
| Optimizer | enabled, 200 runs |
| EVM version | `shanghai` |
| Constructor arg | the payout address — read it from the chain, see below |

The constructor takes a single `address` (the fee payout destination). Read the
live value straight from the contract rather than trusting this document:

```bash
# payoutWallet()  ->  selector 0x88bb4e96
curl -s -X POST https://pulsechain-rpc.publicnode.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x02a765241c2AD5863cf7f67C1AfBA3C3c623d000","data":"0x88bb4e96"},"latest"]}'
```

Left-pad that 20-byte address to 32 bytes to get the ABI-encoded constructor
argument. The creation transaction is linked from the contract's page on any
PulseChain explorer.

---

## What to check in the source

If you are deciding whether to pay a fee, these are the parts that matter:

- **`BURN_ADDRESS`, `WICK`, `WPLS`, `BURN_ROUTER`, `BURN_PAIR` are `constant`.**
  They are compiled into the bytecode and there is no setter for any of them.
  The owner cannot repoint the swap or the burn destination.
- **No function moves `pendingBurn` anywhere except the burn address.** The only
  two exits are `burn()` (buys WICK, recipient is the burn address) and
  `burnPlsDirectly()` (sends raw PLS to that same hardcoded address).
- **`burn()` is permissionless.** Anyone can trigger it; it does not depend on
  the operator staying online.
- **`require(wickBurned >= minOut)`** — the contract checks what was actually
  delivered to the burn address rather than trusting the router's return value.

The owner *can* change fee amounts and the split for **future** payments
(including setting the burn share to 0). That is deliberate operator control
over their own revenue, and it cannot touch PLS that has already accrued.

## Known limitation, stated plainly

The slippage floor in `burn()` protects against a dead or drained route, **not**
against sandwiching — a front-runner moves the reserves before the floor is
computed, so it is derived from already-corrupted state. Proper protection needs
a TWAP, and the WICK/WPLS V3 pool reports `observationCardinality == 1`, so none
is available on-chain. The mitigation is economic: the pot holds single-digit
dollars and a 60-second cooldown prevents same-transaction looping.
