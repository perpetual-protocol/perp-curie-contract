pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import { IClearingHouse } from "../../../contracts/interface/IClearingHouse.sol";
import { IPriceFeedDispatcher } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeedDispatcher.sol";

contract ClearingHousePriceBandTest is Setup {
    address trader = makeAddr("Trader");
    address maker = makeAddr("Maker");

    uint8 usdcDecimals;
    uint8 priceFeedDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // wait for 30 mins after market is deployed
        skip(1800);

        priceFeedDecimals = IPriceFeedDispatcher(_BASE_TOKEN_PRICE_FEED).decimals();
        // mock priceFeed oracle
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(100 * (10**priceFeedDecimals))
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
    // example: before: 5%, after 7% (increase positive spread)
    function test_increase_positive_spread_when_before_and_after_is_in_range() public {
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
    // example: before: 9%, after 11% (increase positive spread)
    function test_revert_increase_positive_spread_when_before_in_range_but_after_our_of_range() public {
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

    // before in range, after out of range
    // example: before: 5%, after -12% (reverse spread)
    function test_revert_reverse_positive_spread_when_before_in_range_but_after_our_of_range() public {
        // mock index price to 95
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(95 * (10**priceFeedDecimals))
        );

        // reverse positive spread
        // before swap: spread is 5.2631%
        // after swap: spread is -13.0056%
        vm.expectRevert(bytes("EX_OPB"));
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 1800 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after out of range
    // example: before: 12%, after 14% (increase positive spread)
    function test_revert_increase_positive_spread_when_before_out_of_range_and_after_spread_greater_than_before()
        public
    {
        // mock index price to 90
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(90 * (10**priceFeedDecimals))
        );

        // expect revert if user still open long position (enlarge price spread)
        // before swap: spread is 11.11%
        // after swap: spread is 12.2138%
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

    // before out of range, after out of range
    // example: before: 12%, after -11% (reverse positive spread)
    function test_revert_reverse_positive_spread_when_both_before_and_after_out_of_range() public {
        // mock index price to 85
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(85 * (10**priceFeedDecimals))
        );

        // expect revert if user reverse positive spread(out of range) to negative spread(out of range)
        // before swap: spread is 17.6470%
        // after swap: spread is -15.3026%
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

    // before out of range, after out of range
    // example: before: 12%, after 11%  (reduce positive spread)
    function test_reduce_positive_spread_when_both_before_after_out_of_range() public {
        // mock index price to 90
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(90 * (10**priceFeedDecimals))
        );

        // before swap: spread is 11.11%
        // after swap: spread is 10.5506%
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

    // before out of range, after in range
    // example: before: 11%, after 9% (reduce positive spread)
    function test_reduce_positive_spread_when_before_out_of_range_and_after_in_range() public {
        // mock index price to 90
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(90 * (10**priceFeedDecimals))
        );

        // before swap: spread is 11.11%
        // after swap: spread is 8.8777%
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
    // example: before: -5%, after -7% (increase negative spread)
    function test_increase_negative_spread_when_before_and_after_is_in_range() public {
        // open short position => market price < index price
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
    // example: before: -9%, after -11% (increase negative spread)
    function test_revert_increase_negative_spread_when_before_in_range_but_after_our_of_range() public {
        // open short position => market price < index price
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

    // before in range, after out of range
    // example: before: -5%, after 12% (reverse negative spread)
    function test_revert_reverse_negative_spread_when_before_in_range_but_after_our_of_range() public {
        // mock index price to 105
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(105 * (10**priceFeedDecimals))
        );

        // reverse negative spread
        // before swap: spread is -4.7619%
        // after swap: spread is 12.9656%
        vm.expectRevert(bytes("EX_OPB"));
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 1800 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after out of range
    // example: before: -12%, after -14% (increase negative spread)
    function test_revert_increase_negative_spread_when_before_out_of_range_and_after_spread_greater_than_before()
        public
    {
        // mock index price to 115
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(115 * (10**priceFeedDecimals))
        );

        // expect revert if user still open short position (enlarge price spread)
        // before swap: spread is -13.0434%
        // after swap: spread is -13.9196%
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

    // before out of range, after out of range
    // example: before: -12%, after 11% (reverse negative spread)
    function test_revert_reverse_negative_spread_when_both_before_and_after_out_of_range() public {
        // mock index price to 115
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(115 * (10**priceFeedDecimals))
        );

        // expect revert if user reverse negative spread(out of range) to positive spread(out of range)
        // before swap: spread is -13.0434%
        // after swap: spread is 14.7001%
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

    // before out of range, after out of range
    // example: before: -12%, after -11%  (reduce negative spread)
    function test_reduce_negative_spread_when_both_before_after_out_of_range() public {
        // mock index price to 115
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(115 * (10**priceFeedDecimals))
        );

        // before swap: spread is -13.0434%
        // after swap: spread is -12.6125% (out of range)
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

    // before out of range, after in range
    // example: before: -11%, after -9% (reduce negative spread)
    function test_reduce_negative_spread_when_before_out_of_range_and_after_in_range() public {
        // mock index price to 112
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeedDispatcher.getDispatchedPrice.selector),
            abi.encode(112 * (10**priceFeedDecimals))
        );

        // before swap: spread is -10.71428571%
        // after swap: spread is -8.9376% (in range)
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
