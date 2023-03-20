pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IClearingHouse.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";

contract ClearingHousePriceBandTest is Setup {
    address trader = makeAddr("Trader");
    address maker = makeAddr("Maker");

    uint8 usdcDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // mock priceFeed oracle
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(100 * 1e8)
        );
        usdcDecimals = usdc.decimals();

        // mint usdc to maker and deposit to vault
        uint256 makerUsdcAmount = 10000 * 10**usdcDecimals;
        usdc.mint(maker, makerUsdcAmount);
        vm.startPrank(maker);
        usdc.approve(address(vault), makerUsdcAmount);
        vault.deposit(address(usdc), makerUsdcAmount);
        vm.stopPrank();

        // mint 1000 usdc to trader and deposit to vault
        uint256 traderUsdcAmount = 1000 * 10**usdcDecimals;
        usdc.mint(trader, traderUsdcAmount);
        vm.startPrank(trader);
        usdc.approve(address(vault), traderUsdcAmount);
        vault.deposit(address(usdc), traderUsdcAmount);
        vm.stopPrank();

        // maker add liquidity
        vm.prank(maker);
        clearingHouse.addLiquidity(
            IClearingHouse.AddLiquidityParams({
                baseToken: address(baseToken),
                base: 200 ether,
                quote: 20000 ether,
                lowerTick: -887220,
                upperTick: 887220,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp
            })
        );

        // initiate timestamp to enable last tick update; should be larger than Exchange._PRICE_LIMIT_INTERVAL
        vm.warp(block.timestamp + 100);
    }

    // before in range, after in range
    function test_open_long_position_when_before_and_after_is_in_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 100.9924502498
        //  - spread: 9924 (0.9924 %)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range
    function test_revert_open_long_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 110.1450249998
        //  - spread: 101450 (10.1450 %)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 1000 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range (reverse position)
    function test_revert_reverse_long_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 100.9924502498
        //  - spread: 9924 (0.9924 %)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // open a reverse position => market price will lees than index price and price spread will out of range
        vm.expectRevert(bytes("EX_OPB"));
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 1500 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, and after spread greater than before
    function test_revert_increase_long_position_when_before_out_of_range_and_after_spread_greater_than_before() public {
        // open 100 U long position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 90
        vm.mockCall(_BASE_TOKEN_PRICE_FEED, abi.encodeWithSelector(IPriceFeed.getPrice.selector), abi.encode(90 * 1e8));

        // expect revert if user still open long position (enlarge price spread)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, and after spread less than before (reverse position)
    function test_revert_reverse_long_position_when_both_before_and_after_out_of_range() public {
        // open 100 U long position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 85
        // market price after swap: 100.9847237481 => will have 18.80555735% price spread
        vm.mockCall(_BASE_TOKEN_PRICE_FEED, abi.encodeWithSelector(IPriceFeed.getPrice.selector), abi.encode(85 * 1e8));

        // expect revert if user open reverse position to over negative price band
        // market price after swap: 72.8341977555 => will have -14.31270852% price spread
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 3000 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, but after spread less than before (reduce position)
    function test_reduce_long_position_when_both_before_after_out_of_range_but_after_less_than_before() public {
        // open 100 U long position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 90
        vm.mockCall(_BASE_TOKEN_PRICE_FEED, abi.encodeWithSelector(IPriceFeed.getPrice.selector), abi.encode(90 * 1e8));

        // market price before swap: 100.99245024983759 => will have 12.21383361% price spread
        // market price before swap: 100.48553743481871 => will have 11.65059715% price spread
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 50 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after in range (reduce position)
    function test_reduce_long_position_when_before_out_of_range_and_after_in_range() public {
        // open 100 U long position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 90
        vm.mockCall(_BASE_TOKEN_PRICE_FEED, abi.encodeWithSelector(IPriceFeed.getPrice.selector), abi.encode(90 * 1e8));

        // market price before swap: 100.99245024983759 => will have 12.21383361% price spread
        // market price after swap: 98.97245127014166 => will have 9.9693903% price spread (in range)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 200 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after in range
    function test_open_short_position_when_before_and_after_is_in_range() public {
        // open long position => market price < index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 98.9927965078
        //  - spread: -10072 (-1.0072 %)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 2 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range
    function test_revert_open_short_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 88.9996440013
        //  - spread: -110003 (-11.0003 %)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 12 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range (reverse position)
    function test_revert_reverse_short_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 88.9996440013
        //  - spread: -110003 (-11.0003 %)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 12 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // open a reverse position => market price will greater than index price and price spread will out of range
        vm.expectRevert(bytes("EX_OPB"));
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 1200 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, and after spread greater than before
    function test_revert_increase_short_position_when_before_out_of_range_and_after_spread_greater_than_before()
        public
    {
        // open 100 U short position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 110
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(110 * 1e8)
        );

        // expect revert if user still open short position (enlarge price spread)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, and after spread less than before (reverse position)
    function test_revert_reverse_short_position_when_both_before_and_after_out_of_range() public {
        // open 100 U short position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 115
        // market price after swap: 98.9851912207 => will have -13.92592067% price spread
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(115 * 1e8)
        );

        // expect revert if user open reverse position to over positive price band
        // market price after swap: 72.8341977555 => will have 13.69215476% price spread
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 3000 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // both before, after out of range, but after spread less than before (reduce position)
    function test_reduce_short_position_when_both_before_after_out_of_range_but_after_less_than_before() public {
        // open 100 U short position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 110
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(112 * 1e8)
        );

        // market price before swap: 98.9924497498631 => will have -11.61388415% price spread
        // market price after swap: 99.4855623123631 => will have -11.17360508% price spread
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 50 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after in range (reduce position)
    function test_reduce_short_position_when_before_out_of_range_and_after_in_range() public {
        // open 100 U short position
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );

        // mock index price to 110
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(112 * 1e8)
        );

        // market price before swap: 98.9924497498631 => will have -11.61388415% price spread
        // market price after swap: 100.97225074986308 => will have -9.846204688% price spread (in range)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 200 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }
}
