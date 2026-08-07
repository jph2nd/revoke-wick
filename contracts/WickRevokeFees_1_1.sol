// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * WickRevokeFees v1.1 — fee collector + WICK buy-and-burn for revoke.wick.pics
 * ---------------------------------------------------------------------------
 * PulseChain (chainId 369).
 *
 * A user of the revoke dApp pays a convenience fee before revoking token
 * approvals. Every payment is split:
 *
 *     burnShareBps  (default 50%) -> accrues to `pendingBurn`
 *     the remainder (default 50%) -> pushed to `payoutWallet`
 *
 * `pendingBurn` is later spent by ANYONE calling `burn()`, which market-buys
 * WICK with the accumulated PLS and delivers it straight to PulseChain's burn
 * address 0x…0369. The swap recipient IS the burn address, so burned WICK
 * never touches this contract and cannot be diverted.
 *
 * ---------------------------------------------------------------------------
 * CHANGES FROM v1.0 — all four came out of an adversarial review that
 * reproduced a working drain of the pot. Do not revert any of them.
 *
 *  1. BLOCKER FIX. v1.0 had a settable `burnRouter`. That was a complete rug
 *     vector: the owner deploys a contract implementing just getAmountsOut()
 *     (return 2 wei, enough to pass the old `require(minOut > 0)`) and a
 *     payable swapExactETHForTokens() that simply keeps the PLS, points the
 *     contract at it, and calls the permissionless burn(). The pot leaves to an
 *     arbitrary address. Two reviewers reproduced this independently — one via
 *     eth_call state overrides on live mainnet, one in an in-memory EVM which
 *     moved 40,000 PLS to an attacker address. The router is now a `constant`
 *     and there is no setter. PulseX V1 is measured-best anyway, and
 *     burnPlsDirectly() already covers the "route died" case.
 *
 *  2. The swap result is now VERIFIED, not assumed. v1.0 computed `wickBurned`
 *     from the burn address balance and then ignored it, so a swap that
 *     delivered nothing still succeeded silently. Now the delivered amount must
 *     clear `minOut` or the whole transaction reverts.
 *
 *  3. `burnCooldown` is bounded (<= MAX_BURN_COOLDOWN) and defaults NONZERO.
 *     Unbounded, it let the owner freeze the pot's only exit until the year
 *     2106 — a limit that can permanently block an exit is exactly the
 *     anti-pattern that has bitten these bots before. A nonzero default also
 *     kills the "loop burn() inside one transaction" bypass that made
 *     `maxBurnPerCall` bound nothing.
 *
 *  4. `_floor()` now rejects a THINNED route, not just an empty one.
 *     getAmountsOut stays proportionally "correct" as a pool drains, so the old
 *     percentage-only floor would happily burn the whole pot into a migrated
 *     pair at a terrible price. The pair's live WPLS reserve must now clear
 *     `minRouteLiquidityPls` first.
 *
 * ---------------------------------------------------------------------------
 * TRUST MODEL — stated precisely, because v1.0's version was false
 *
 *  - Once PLS is in `pendingBurn`, the ONLY ways out are (a) a WICK buy whose
 *    recipient is the hardcoded burn address, or (b) burnPlsDirectly(), which
 *    sends it to that same hardcoded burn address as raw PLS. There is no
 *    function, owner-only or otherwise, that moves it anywhere else. The router
 *    and the burn address are both `constant`, so this is enforced by the
 *    bytecode rather than by owner restraint.
 *
 *  - The owner CAN change the split for FUTURE fees, including setting
 *    burnShareBps to 0 so nothing further accrues. That is deliberate operator
 *    policy over their own revenue. It cannot touch PLS already accrued.
 *
 *  - burn() is permissionless so the community can force the burn through
 *    without depending on the operator staying alive.
 *
 * ---------------------------------------------------------------------------
 * MEV NOTE — honest scope, do not overstate it
 *
 * `_floor()` derives its minimum from the pair's CURRENT reserves. That catches
 * a dead, migrated or thinned route. It is NOT sandwich protection: an attacker
 * who front-runs moves the reserves first, so the floor is computed from
 * already-corrupted state. Real sandwich protection needs a TWAP, and the
 * WICK/WPLS V3 pool reports observationCardinality == 1, so no usable on-chain
 * TWAP exists today.
 *
 * The mitigation is economic: the pot holds single-digit dollars, `burnCooldown`
 * stops same-transaction looping, and `maxBurnPerCall` caps one swap. Call
 * burn() often and there is nothing worth sandwiching. A caller who wants more
 * protection passes their own `minWickOut`, which can only RAISE the floor.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

interface IUniswapV2Pair {
    function getReserves()
        external view returns (uint112 reserve0, uint112 reserve1, uint32 ts);
    function token0() external view returns (address);
}

contract WickRevokeFees {
    // ---------------------------------------------------------------- consts

    /// PulseChain's canonical burn address.
    address public constant BURN_ADDRESS =
        0x0000000000000000000000000000000000000369;

    /// Green Wick (WICK) — immutable fixed-supply OpenZeppelin ERC20, no tax.
    address public constant WICK =
        0x8CDaf3d630Da9E1450832924D5701CC0500E9cfC;

    /// Wrapped PLS.
    address public constant WPLS =
        0xA1077a294dDE1B09bB078844df40758a5D0f9a27;

    /**
     * PulseX V1 router — hardcoded, no setter. See change (1) above.
     *
     * Chosen on measurement, not on brand: the 9mm V3 WICK/WPLS pool is in the
     * 2% fee tier while PulseX V1 charges 0.29% (verified on-chain), so V1
     * returns more WICK for every burn below ~6.63M PLS. A single revoke burns
     * 25,000 PLS and a batch 125,000 PLS — 50x to 265x under that crossover.
     * PulseX V2's WICK/WPLS pair holds ~$17 and must never be used.
     */
    address public constant BURN_ROUTER =
        0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02;

    /// PulseX V1 WICK/WPLS pair. Its factory was verified to match the router's.
    address public constant BURN_PAIR =
        0xb2406c1E31Da31C1118E4DBCb4ed2456FEcFc6cE;

    uint16 private constant BPS = 10_000;

    /// Ceiling on the configurable slippage tolerance (20%).
    uint16 public constant MAX_SLIPPAGE_BPS_LIMIT = 2_000;

    /// Ceiling on the burn cooldown, so the pot's exit can never be frozen.
    uint32 public constant MAX_BURN_COOLDOWN = 1 days;

    /// Floor on maxBurnPerCall, so the pot can never be made undrainable.
    uint256 public constant MIN_BURN_PER_CALL = 1_000 ether;

    // ----------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;

    /// Receives the non-burn share of every fee.
    address public payoutWallet;

    /// True when the pair's token1 is WPLS. Resolved once, at construction.
    bool public immutable wplsIsToken1;

    uint256 public singleFee = 50_000 ether;
    uint256 public batchFee = 250_000 ether;

    /// Share of each payment routed to the WICK burn, in basis points.
    uint16 public burnShareBps = 5_000;

    /// PLS awaiting conversion into burned WICK. Nobody can withdraw this.
    uint256 public pendingBurn;

    /// Owner-side PLS that failed to push to `payoutWallet`; withdrawable.
    uint256 public pendingPayout;

    /// Slippage tolerance applied to the router's own quote.
    uint16 public maxSlippageBps = 300;

    /// Largest amount of PLS a single burn() call may spend.
    uint256 public maxBurnPerCall = 1_000_000 ether;

    /**
     * Minimum WPLS the burn pair must hold for burn() to route through it.
     * Defaults to 50M PLS (~$400 at the time of writing) against a pair holding
     * ~220M PLS. If liquidity migrates, burn() fails closed and the operator
     * falls back to burnPlsDirectly().
     */
    uint256 public minRouteLiquidityPls = 50_000_000 ether;

    /// Minimum seconds between burns. Nonzero by default — see change (3).
    uint32 public burnCooldown = 60;
    uint64 public lastBurnAt;

    // lifetime accounting, for the dApp's stats panel
    uint256 public totalFeesCollected;
    uint256 public totalPaidOut;
    uint256 public totalPlsSpentOnBurns;
    uint256 public totalWickBurned;
    uint256 public totalSingleRevokesPaid;
    uint256 public totalBatchesPaid;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events

    event FeePaid(
        address indexed payer,
        bool indexed isBatch,
        uint256 amount,
        uint256 burnCut,
        uint256 payoutCut,
        uint256 approvalCount
    );
    event Burned(
        address indexed caller,
        uint256 plsIn,
        uint256 wickBurned,
        uint256 minOutUsed
    );
    event PlsBurnedDirectly(address indexed caller, uint256 amount);
    event PayoutPushFailed(address indexed to, uint256 amount);
    event PayoutWithdrawn(address indexed to, uint256 amount);
    event Donated(address indexed from, uint256 amount);
    event ConfigChanged(string what);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ----------------------------------------------------------- constructor

    constructor(address _payoutWallet) {
        require(_payoutWallet != address(0), "payout=0");
        owner = msg.sender;
        payoutWallet = _payoutWallet;

        // Resolve pair ordering once rather than trusting a hardcoded guess.
        address t0 = IUniswapV2Pair(BURN_PAIR).token0();
        require(t0 == WICK || t0 == WPLS, "bad pair");
        wplsIsToken1 = (t0 == WICK);

        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------ fees

    /// Pay for a single approval revoke. Overpayment is accepted and split.
    function payRevokeFee() external payable {
        require(msg.value >= singleFee, "fee too low");
        totalSingleRevokesPaid += 1;
        _split(msg.value, false, 1);
    }

    /// Pay for a batch revoke session. `approvalCount` is advisory, for events.
    function payBatchFee(uint256 approvalCount) external payable {
        require(msg.value >= batchFee, "fee too low");
        totalBatchesPaid += 1;
        _split(msg.value, true, approvalCount);
    }

    function _split(uint256 amount, bool isBatch, uint256 approvalCount)
        private
    {
        uint256 burnCut = (amount * burnShareBps) / BPS;
        uint256 payoutCut = amount - burnCut;

        pendingBurn += burnCut;
        totalFeesCollected += amount;

        if (payoutCut > 0) {
            // Push to the operator, but never let a failing payout target
            // brick fee collection — fall back to a pull.
            (bool ok, ) = payoutWallet.call{value: payoutCut}("");
            if (ok) {
                totalPaidOut += payoutCut;
            } else {
                pendingPayout += payoutCut;
                emit PayoutPushFailed(payoutWallet, payoutCut);
            }
        }

        emit FeePaid(
            msg.sender, isBatch, amount, burnCut, payoutCut, approvalCount
        );
    }

    /// Bare PLS sent to this contract is treated as a donation to the burn pot.
    receive() external payable {
        pendingBurn += msg.value;
        emit Donated(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ burn

    /**
     * Market-buy WICK with the accumulated pot and send it to the burn address.
     * Permissionless by design.
     *
     * @param minWickOut Caller's own minimum. Applied only if STRICTER than the
     *                   contract's own floor, so passing 0 cannot weaken it.
     */
    function burn(uint256 minWickOut)
        external
        nonReentrant
        returns (uint256 wickBurned)
    {
        require(
            block.timestamp >= uint256(lastBurnAt) + burnCooldown,
            "cooldown"
        );

        uint256 amount = pendingBurn;
        require(amount > 0, "nothing to burn");
        if (amount > maxBurnPerCall) amount = maxBurnPerCall;

        // effects before interaction
        pendingBurn -= amount;
        lastBurnAt = uint64(block.timestamp);

        uint256 minOut = _floor(amount);
        if (minWickOut > minOut) minOut = minWickOut;
        require(minOut > 0, "no route");

        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = WICK;

        // Output goes straight to the burn address; it never touches this
        // contract, so measure the burn address balance to learn the truth.
        uint256 before = IERC20(WICK).balanceOf(BURN_ADDRESS);

        IUniswapV2Router(BURN_ROUTER).swapExactETHForTokens{value: amount}(
            minOut, path, BURN_ADDRESS, block.timestamp
        );

        wickBurned = IERC20(WICK).balanceOf(BURN_ADDRESS) - before;

        // Verify delivery rather than trusting the callee. Without this, a swap
        // that delivered nothing would still "succeed". See change (2).
        require(wickBurned >= minOut, "short burn");

        totalPlsSpentOnBurns += amount;
        totalWickBurned += wickBurned;

        emit Burned(msg.sender, amount, wickBurned, minOut);
    }

    /**
     * Escape hatch: if WICK liquidity ever dies or thins below the route floor,
     * the pot is still burnable — as raw PLS, to the same hardcoded burn
     * address. This is NOT a withdrawal; the destination cannot be changed.
     */
    function burnPlsDirectly() external onlyOwner nonReentrant {
        uint256 amount = pendingBurn;
        require(amount > 0, "nothing to burn");
        pendingBurn = 0;
        totalPlsSpentOnBurns += amount;

        (bool ok, ) = BURN_ADDRESS.call{value: amount}("");
        require(ok, "burn send failed");

        emit PlsBurnedDirectly(msg.sender, amount);
    }

    /// Live WPLS balance of the burn pair.
    function routeLiquidityPls() public view returns (uint256) {
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(BURN_PAIR).getReserves();
        return wplsIsToken1 ? uint256(r1) : uint256(r0);
    }

    /**
     * Minimum acceptable output for `amount` of PLS.
     * Reverts if the route is dead OR merely thin — see change (4).
     */
    function _floor(uint256 amount) private view returns (uint256) {
        require(
            routeLiquidityPls() >= minRouteLiquidityPls,
            "route too thin"
        );

        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = WICK;
        uint256[] memory out =
            IUniswapV2Router(BURN_ROUTER).getAmountsOut(amount, path);
        return (out[1] * (BPS - maxSlippageBps)) / BPS;
    }

    // ----------------------------------------------------------------- views

    /// What burn() would spend and demand right now. For the dApp UI.
    function previewBurn()
        external
        view
        returns (uint256 plsIn, uint256 expectedWick, uint256 minOut)
    {
        plsIn = pendingBurn;
        if (plsIn > maxBurnPerCall) plsIn = maxBurnPerCall;
        if (plsIn == 0) return (0, 0, 0);

        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = WICK;
        uint256[] memory out =
            IUniswapV2Router(BURN_ROUTER).getAmountsOut(plsIn, path);
        expectedWick = out[1];
        minOut = (expectedWick * (BPS - maxSlippageBps)) / BPS;
    }

    /// Seconds remaining before burn() is callable again. 0 when ready.
    function burnReadyIn() external view returns (uint256) {
        uint256 ready = uint256(lastBurnAt) + burnCooldown;
        return block.timestamp >= ready ? 0 : ready - block.timestamp;
    }

    /// Everything the stats panel needs, in one call.
    function stats()
        external
        view
        returns (
            uint256 _pendingBurn,
            uint256 _totalFeesCollected,
            uint256 _totalPlsSpentOnBurns,
            uint256 _totalWickBurned,
            uint256 _totalSingleRevokesPaid,
            uint256 _totalBatchesPaid,
            uint256 _wickAtBurnAddress
        )
    {
        return (
            pendingBurn,
            totalFeesCollected,
            totalPlsSpentOnBurns,
            totalWickBurned,
            totalSingleRevokesPaid,
            totalBatchesPaid,
            IERC20(WICK).balanceOf(BURN_ADDRESS)
        );
    }

    // ----------------------------------------------------------------- admin

    function withdrawPendingPayout() external nonReentrant {
        uint256 amount = pendingPayout;
        require(amount > 0, "nothing pending");
        pendingPayout = 0;
        totalPaidOut += amount;
        (bool ok, ) = payoutWallet.call{value: amount}("");
        require(ok, "payout failed");
        emit PayoutWithdrawn(payoutWallet, amount);
    }

    function setPayoutWallet(address w) external onlyOwner {
        require(w != address(0), "payout=0");
        payoutWallet = w;
        emit ConfigChanged("payoutWallet");
    }

    function setFees(uint256 _singleFee, uint256 _batchFee)
        external
        onlyOwner
    {
        singleFee = _singleFee;
        batchFee = _batchFee;
        emit ConfigChanged("fees");
    }

    function setBurnShareBps(uint16 bps) external onlyOwner {
        require(bps <= BPS, "bps>100%");
        burnShareBps = bps;
        emit ConfigChanged("burnShareBps");
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_SLIPPAGE_BPS_LIMIT, "slippage too high");
        maxSlippageBps = bps;
        emit ConfigChanged("maxSlippageBps");
    }

    function setMaxBurnPerCall(uint256 v) external onlyOwner {
        require(v >= MIN_BURN_PER_CALL, "cap too low");
        maxBurnPerCall = v;
        emit ConfigChanged("maxBurnPerCall");
    }

    /// Bounded: a cooldown must never be able to freeze the pot's only exit.
    function setBurnCooldown(uint32 s) external onlyOwner {
        require(s <= MAX_BURN_COOLDOWN, "cooldown too long");
        burnCooldown = s;
        emit ConfigChanged("burnCooldown");
    }

    function setMinRouteLiquidityPls(uint256 v) external onlyOwner {
        minRouteLiquidityPls = v;
        emit ConfigChanged("minRouteLiquidityPls");
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }
}
